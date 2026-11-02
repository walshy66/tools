import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClientError, createHerdrClient } from "./herdr-client.mjs";

function fakeHerdr(responses) {
  const calls = [];
  return {
    calls,
    invoke: async (operation, input) => {
      calls.push({ operation, input });
      const response = responses[operation];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response(input);
      return response;
    },
  };
}

test("creates a task tab without stealing focus and validates its root pane", async () => {
  const fake = fakeHerdr({
    createTab: { workspace: "workspace-1", tab: "tab-1", pane: "pane-1" },
  });
  const client = createHerdrClient({ invoke: fake.invoke });

  const tab = await client.createTaskTab({ workspace: "workspace-1", label: "COA-364", cwd: "/work/task" });

  assert.deepEqual(tab, { workspace: "workspace-1", tab: "tab-1", pane: "pane-1" });
  assert.deepEqual(fake.calls, [{
    operation: "createTab",
    input: { workspace: "workspace-1", label: "COA-364", cwd: "/work/task", focus: false },
  }]);
});

test("opens a verifier sibling without stealing focus and sets environment before launch", async () => {
  const fake = fakeHerdr({ paneLayout: { panes: [{pane_id:'pane-1',rect:{width:100,height:25}}] }, splitPane: { pane: 'pane-2', tab: 'tab-1' } });
  const client = createHerdrClient({ invoke: fake.invoke });
  assert.deepEqual(await client.createVerifierPane({ pane: 'pane-1', cwd: '/work', env: { CROSBY_GATE_REQUEST: '/request.json' } }), { pane: 'pane-2', tab: 'tab-1' });
  assert.equal(fake.calls[1].input.focus, false);
  assert.equal(fake.calls[1].input.pane, 'pane-1');
  assert.equal(fake.calls[1].input.direction, 'right');
});

test('Windows startup prompt confirms submission and recovers a pending Enter once', async () => {
  let waits=0;
  const fake=fakeHerdr({promptAgent:{state:'idle'},waitForAgent:()=>{if(waits++===0)throw new Error('not working');return {state:'working'};},inspectAgent:{name:'reviewer',state:'idle'},sendAgentKeys:{state:'working'}});
  const client=createHerdrClient({invoke:fake.invoke,platform:'win32'});
  assert.equal((await client.promptAgent({agent:'reviewer',prompt:'Review only'})).state,'working');
  assert.equal(fake.calls.filter(call=>call.operation==='promptAgent').length,1);
  assert.deepEqual(fake.calls.find(call=>call.operation==='sendAgentKeys').input.keys,['enter']);
});

test("exposes validated agent control operations", async () => {
  const fake = fakeHerdr({
    snapshot: { workspaces: [] },
    closeTab: { tab: "tab-1" },
    promptAgent: { state: "working" },
    waitForAgent: { state: "idle" },
    readAgent: { text: "worker output" },
    renameAgent: { name: "coa-364-worker", state: "idle" },
    inspectAgent: { name: "coa-364-worker", state: "blocked" },
    sendAgentKeys: { state: "working" },
    stopAgent: { state: "done" },
  });
  const client = createHerdrClient({ invoke: fake.invoke, platform: "linux" });

  assert.deepEqual(await client.snapshot(), { workspaces: [] });
  assert.deepEqual(await client.closeTaskTab({ tab: "tab-1" }), { tab: "tab-1" });
  assert.deepEqual(await client.promptAgent({ agent: "coa-364", prompt: "implement", wait: false }), { state: "working" });
  assert.deepEqual(await client.waitForAgent({ agent: "coa-364", until: ["idle", "blocked"] }), { state: "idle" });
  assert.deepEqual(await client.readAgent({ agent: "coa-364" }), { text: "worker output" });
  assert.deepEqual(await client.renameAgent({ agent: "coa-364", name: "coa-364-worker" }), { name: "coa-364-worker", state: "idle" });
  assert.deepEqual(await client.inspectAgent({ agent: "coa-364-worker" }), { name: "coa-364-worker", state: "blocked" });
  assert.deepEqual(await client.sendAgentKeys({ agent: "coa-364-worker", keys: ["ctrl-c"] }), { state: "working" });
  assert.deepEqual(await client.stopAgent({ agent: "coa-364-worker" }), { state: "done" });
});

test("starts Claude through the pane shell and names it once its input is on screen", async () => {
  let inspections = 0;
  let reads = 0;
  const fake = fakeHerdr({
    runPaneCommand: { pane: "pane-1" },
    inspectAgent: () => { if (inspections++ === 0) throw new Error("agent target pane-1 not found"); return { name: "claude", pane: "pane-1", state: "idle" }; },
    readAgent: () => ({ text: reads++ === 0 ? "Claude Code loading" : "  bypass permissions on (shift+tab to cycle)" }),
    renameAgent: { name: "task-001", pane: "pane-1", state: "idle" },
  });
  const client = createHerdrClient({ invoke: fake.invoke, platform: "win32", pollMs: 1 });
  const command = "claude --dangerously-skip-permissions --model opus --mcp-config 'C:/x/mcp.json' --settings 'C:/x/settings.json' -n 'task-001'";

  assert.deepEqual(await client.startClaudeAgent({ pane: "pane-1", name: "task-001", command }), { name: "task-001", pane: "pane-1", state: "idle" });
  assert.deepEqual(fake.calls.map((call) => call.operation), ["runPaneCommand", "inspectAgent", "inspectAgent", "readAgent", "inspectAgent", "readAgent", "renameAgent"]);
  assert.deepEqual(fake.calls[0].input, { pane: "pane-1", command });
  assert.deepEqual(fake.calls[3].input, { agent: "pane-1", source: "visible" });
});

test("reports a first-run trust dialog once and waits for the operator to answer it", async () => {
  let reads = 0;
  const notices = [];
  const fake = fakeHerdr({
    runPaneCommand: { pane: "pane-1" },
    inspectAgent: () => ({ name: "claude", state: reads < 3 ? "blocked" : "idle" }),
    readAgent: () => ({ text: reads++ < 3 ? "No, exit / Yes, I trust this folder" : "bypass permissions on" }),
  });
  const client = createHerdrClient({ invoke: fake.invoke, pollMs: 1, startupTimeoutMs: 1000, onStartupDialog: (notice) => notices.push(notice) });
  assert.equal((await client.startClaudeAgent({ pane: "pane-1", command: "claude --model opus" })).state, "idle");
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /pane-1 is asking to trust this repository/);
});

test("an unanswered startup dialog eventually fails with recovery guidance", async () => {
  const fake = fakeHerdr({ runPaneCommand: { pane: "pane-1" }, inspectAgent: { name: "claude", state: "blocked" }, readAgent: { text: "Yes, I accept" } });
  const client = createHerdrClient({ invoke: fake.invoke, pollMs: 1, dialogTimeoutMs: 5 });
  await assert.rejects(client.startClaudeAgent({ pane: "pane-1", command: "claude --model opus" }), /still waiting on its startup dialog.*Recovery/);
});

test("idle without the Claude input footer is not treated as ready", async () => {
  const fake = fakeHerdr({ runPaneCommand: { pane: "pane-1" }, inspectAgent: { name: "claude", state: "idle" }, readAgent: { text: "PS C:/repo>" } });
  const client = createHerdrClient({ invoke: fake.invoke, pollMs: 1, startupTimeoutMs: 20 });
  await assert.rejects(client.startClaudeAgent({ pane: "pane-1", command: "claude --model opus" }), /did not become ready/);
});

test("rejects unsafe Claude startup commands before invoking the shell", async () => {
  const fake = fakeHerdr({});
  const client = createHerdrClient({ invoke: fake.invoke, platform: "win32" });

  await assert.rejects(client.startClaudeAgent({ pane: "pane-1", command: "pi --approve" }), /unsafe launch command.*Recovery/i);
  await assert.rejects(client.startClaudeAgent({ pane: "pane-1", command: "claude --model opus\nRemove-Item x" }), /unsafe launch command/i);
  assert.deepEqual(fake.calls, []);
});

test("fails closed with recovery guidance for adapter failures and malformed Herdr responses", async () => {
  const unavailable = createHerdrClient({ invoke: async () => { throw new Error("connection refused"); } });
  await assert.rejects(unavailable.snapshot(), /Herdr snapshot failed: connection refused.*Recovery/i);

  const malformed = createHerdrClient({ invoke: async () => ({ workspace: "workspace-1", tab: "tab-1" }) });
  await assert.rejects(
    malformed.createTaskTab({ workspace: "workspace-1", label: "COA-364", cwd: "/work/task" }),
    HerdrClientError,
  );

  const invalidInput = createHerdrClient({ invoke: async () => ({ workspaces: [] }) });
  await assert.rejects(invalidInput.promptAgent({ agent: "", prompt: "implement" }), /agent must be a non-empty string.*Recovery/i);
});

test("does not present lifecycle telemetry as a task-completion decision", async () => {
  const fake = fakeHerdr({ inspectAgent: { name: "coa-364", state: "idle" } });
  const client = createHerdrClient({ invoke: fake.invoke });

  assert.deepEqual(await client.inspectAgent({ agent: "coa-364" }), { name: "coa-364", state: "idle" });
  assert.equal(typeof client.completeFromAgentState, "undefined");
});

test("treats a done Claude with its input footer as ready (state after a trust dialog)", async () => {
  const fake = fakeHerdr({ runPaneCommand: { pane: "pane-1" }, inspectAgent: { name: "claude", state: "done" }, readAgent: { text: "bypass permissions on" } });
  const client = createHerdrClient({ invoke: fake.invoke, pollMs: 1 });
  assert.equal((await client.startClaudeAgent({ pane: "pane-1", command: "claude --model opus" })).state, "done");
});

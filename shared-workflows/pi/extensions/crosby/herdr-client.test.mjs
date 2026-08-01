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

test("exposes validated agent control operations", async () => {
  const fake = fakeHerdr({
    snapshot: { workspaces: [] },
    closeTab: { tab: "tab-1" },
    startAgent: { name: "coa-364", pane: "pane-1", state: "working" },
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
  assert.deepEqual(await client.startPiAgent({ pane: "pane-1", name: "coa-364" }), {
    name: "coa-364", pane: "pane-1", state: "working",
  });
  assert.deepEqual(await client.promptAgent({ agent: "coa-364", prompt: "implement", wait: false }), { state: "working" });
  assert.deepEqual(await client.waitForAgent({ agent: "coa-364", until: ["idle", "blocked"] }), { state: "idle" });
  assert.deepEqual(await client.readAgent({ agent: "coa-364" }), { text: "worker output" });
  assert.deepEqual(await client.renameAgent({ agent: "coa-364", name: "coa-364-worker" }), { name: "coa-364-worker", state: "idle" });
  assert.deepEqual(await client.inspectAgent({ agent: "coa-364-worker" }), { name: "coa-364-worker", state: "blocked" });
  assert.deepEqual(await client.sendAgentKeys({ agent: "coa-364-worker", keys: ["ctrl-c"] }), { state: "working" });
  assert.deepEqual(await client.stopAgent({ agent: "coa-364-worker" }), { state: "done" });
});

test("starts Pi through the interactive Windows shell and names it after detection", async () => {
  const fake = fakeHerdr({
    runPaneCommand: { pane: "pane-1" },
    inspectAgent: { name: "pi", pane: "pane-1", state: "idle" },
    renameAgent: { name: "task-001", pane: "pane-1", state: "idle" },
  });
  const client = createHerdrClient({ invoke: fake.invoke, platform: "win32" });

  assert.deepEqual(
    await client.startPiAgent({ pane: "pane-1", name: "task-001", agentArgs: ["--approve"] }),
    { name: "task-001", pane: "pane-1", state: "idle" },
  );
  assert.deepEqual(fake.calls, [
    { operation: "runPaneCommand", input: { pane: "pane-1", command: "pi --approve" } },
    { operation: "inspectAgent", input: { agent: "pane-1" } },
    { operation: "renameAgent", input: { agent: "pane-1", name: "task-001" } },
  ]);
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

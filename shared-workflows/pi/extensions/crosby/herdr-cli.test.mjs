import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrCliInvoker } from "./herdr-cli.mjs";

test("reads agent output as raw transcript text rather than a Herdr JSON envelope", async () => {
  const calls = [];
  const invoke = createHerdrCliInvoker({
    exec: async (command, args) => {
      calls.push([command, args]);
      return {
        code: 0,
        stdout: '{"outcome":"complete","summary":"done"}',
        stderr: "",
      };
    },
  });

  assert.deepEqual(
    await invoke("readAgent", { agent: "crosby-coa-365", lines: 2000, source: "recent-unwrapped" }),
    { text: '{"outcome":"complete","summary":"done"}' },
  );
  assert.deepEqual(calls, [["herdr", ["agent", "read", "crosby-coa-365", "--source", "recent-unwrapped", "--lines", "2000"]]]);
});

test("parses Herdr tab create envelopes with nested tab and root pane records", async () => {
  const invoke = createHerdrCliInvoker({
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        result: {
          type: "tab_created",
          tab: { tab_id: "w3:t2", workspace_id: "w3", label: "COA-348" },
          root_pane: { pane_id: "w3:p2", tab_id: "w3:t2", workspace_id: "w3" },
        },
      }),
      stderr: "",
    }),
  });

  assert.deepEqual(await invoke("createTab", { workspace: "w3", label: "COA-348", cwd: ".", focus: false }), {
    workspace: "w3",
    tab: "w3:t2",
    pane: "w3:p2",
  });
});

test("parses JSON envelopes for stateful Herdr operations", async () => {
  const invoke = createHerdrCliInvoker({
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { name: "crosby-coa-365", pane_id: "w1:p2", agent_status: "idle" } } }),
      stderr: "",
    }),
  });

  assert.deepEqual(await invoke("inspectAgent", { agent: "crosby-coa-365" }), {
    name: "crosby-coa-365",
    pane_id: "w1:p2",
    agent_status: "idle",
    state: "idle",
  });
});

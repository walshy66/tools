import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubCommand, runGitHubWatch } from "./github-actions.mjs";

test("parses GitHub parent, watch, push, and review commands", () => {
  assert.deepEqual(parseGitHubCommand("#14"), { mode: "parent", issueRef: "#14" });
  assert.deepEqual(parseGitHubCommand("--watch"), { mode: "watch" });
  assert.deepEqual(parseGitHubCommand("push #14"), { mode: "push", issueRef: "#14" });
  assert.deepEqual(parseGitHubCommand("review #14"), { mode: "review", issueRef: "#14" });
});

test("watch skips parents with an active building child", async () => {
  const runs = [];
  let slept = false;
  const controller = new AbortController();
  const client = { loadExecuteParentQueues: async () => {
    controller.abort();
    return [
      { parent: { identifier: "#14" }, children: [{ state: { name: "Building" } }] },
      { parent: { identifier: "#15" }, children: [{ state: { name: "Ready to Build" } }] },
    ];
  } };
  await runGitHubWatch({ client, runParent: async (key) => { runs.push(key); }, sleep: async () => { slept = true; } , signal: controller.signal });
  assert.deepEqual(runs, ["#15"]);
  assert.equal(slept, false);
});

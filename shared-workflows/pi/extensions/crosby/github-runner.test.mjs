import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubParent } from "./github-runner.mjs";

test("runs a durable build from GitHub and reports integrated children", async () => {
  const moved = [];
  const comments = [];
  const issues = new Map([
    ["14", { number: 14, title: "Parent", body: "## Child Issues\n- [ ] #17", state: "OPEN", labels: [], url: "https://github.com/walshy66/tools/issues/14" }],
    ["17", { number: 17, title: "Child", body: "## Outcome\nDo it\n\n## Acceptance Criteria\n- works\n\n## File Scope\n- src/**\n\n## Verification\n- none", state: "OPEN", labels: ["status:ready-to-build"], url: "https://github.com/walshy66/tools/issues/17" }],
  ]);
  const result = await runGitHubParent({ issueRef: "14", repository: "https://github.com/walshy66/tools", exec: async (_command, args) => {
    if (args[0] === "issue" && args[1] === "view") return { code: 0, stdout: JSON.stringify(issues.get(args[2])), stderr: "" };
    if (args[0] === "issue" && args[1] === "edit") { moved.push(args); return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "issue" && args[1] === "close") { moved.push(args); issues.get(args[2]).state = "CLOSED"; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "issue" && args[1] === "comment") { comments.push(args); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  }, runBuild: async ({ buildFolder, adapters }) => {
    assert.match(buildFolder, /crosby-github/);
    await adapters.onTaskIntegrated({ task: { id: "task-017" }, report: { changes: { commit: "abc" } } });
    return { completed: [] };
  } });
  assert.ok(result.queue);
  assert.equal(moved.length, 2);
  assert.equal(comments.length, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { issueToBuildTask, renderGitHubBuild, taskIdForIssue } from "./github-build.mjs";

const child = (number, body) => ({ number, identifier: `#${number}`, title: `Task ${number}`, body, labels: { nodes: [{ name: "mode:afk" }] } });
const body = `## Outcome\nImplement the adapter.\n\n## Acceptance Criteria\n- Parse issues\n- Validate remotes\n\n## File Scope\n- shared-workflows/pi/extensions/crosby/**\n\n## Verification\n- node --test test.mjs\n\n## Guardrails\n- Do not bypass scope validation.`;

test("maps GitHub issue numbers to stable local task IDs", () => {
  assert.equal(taskIdForIssue({ number: 17 }), "task-017");
  assert.equal(issueToBuildTask(child(17, body), 0).id, "task-017");
});

test("renders a valid local build contract from a GitHub queue", () => {
  const markdown = renderGitHubBuild({ parent: { number: 14, branchName: "crosby/github" }, children: [child(17, body)] });
  assert.match(markdown, /# Build: github-14/);
  assert.match(markdown, /## task-017 — Task 17/);
  assert.match(markdown, /- File scope:/);
  assert.match(markdown, /- Verification:/);
});

test("fails closed when a child issue omits execution contract sections", () => {
  assert.throws(() => issueToBuildTask(child(18, "## Outcome\nDo it."), 0), /Acceptance Criteria|File Scope|Verification/);
});

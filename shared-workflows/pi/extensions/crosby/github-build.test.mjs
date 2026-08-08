import assert from "node:assert/strict";
import test from "node:test";
import { issueToBuildTask, renderGitHubBuild, taskIdForIssue } from "./github-build.mjs";

const child = (number, body) => ({ number, identifier: `#${number}`, title: `Task ${number}`, body, labels: { nodes: [{ name: "mode:afk" }] } });
const body = `## Outcome\nImplement the adapter.\n\n## Acceptance Criteria\n- Parse issues\n- Validate remotes\n\n## File Scope\n- shared-workflows/pi/extensions/crosby/**\n\n## Verification\n- node --test test.mjs\n\n## Guardrails\n- Do not bypass scope validation.`;

test("maps GitHub issue numbers to stable local task IDs", () => {
  assert.equal(taskIdForIssue({ number: 17 }), "task-017");
  assert.equal(issueToBuildTask(child(17, body), 0).id, "task-017");
  assert.equal(issueToBuildTask(child(17, body), 0).tabLabel, "Task #17");
});

test("renders a valid local build contract from a GitHub queue", () => {
  const markdown = renderGitHubBuild({ parent: { number: 14, branchName: "crosby/github" }, children: [child(17, body)] });
  assert.match(markdown, /# Build: github-14/);
  assert.match(markdown, /## task-017 — Task 17/);
  assert.match(markdown, /- File scope:/);
  assert.match(markdown, /- Verification:/);
});

test("preserves complete nested execution contract sections", () => {
  const nestedBody = `## Outcome
Implement the adapter.

## Acceptance Criteria
- Parse issues
- Validate remotes

## File Scope
### Expected Files
- \`src/adapter.mjs\`
- \`test/adapter.test.mjs\` only if regression coverage is needed

### Do Not Touch
- \`migrations/**\` — schema changes are out of scope

## Verification
### Test Command
\`\`\`bash
node --test test/adapter.test.mjs
\`\`\`

Confirm the full suite passes.

## Guardrails
- Preserve repository validation.
- Do not bypass scope checks.`;

  const task = issueToBuildTask(child(18, nestedBody), 0);

  assert.deepEqual(task.criteria, ["Parse issues", "Validate remotes"]);
  assert.deepEqual(task.scope, ["src/adapter.mjs", "test/adapter.test.mjs"]);
  assert.deepEqual(task.verification, ["node --test test/adapter.test.mjs"]);
  assert.match(task.guardrails, /Preserve repository validation\.[\s\S]*Do not bypass scope checks\.[\s\S]*Do not touch:[\s\S]*migrations\/\*\*[\s\S]*Verification notes:[\s\S]*Confirm the full suite passes\./);
});

test("fails closed when a child issue omits execution contract sections", () => {
  assert.throws(() => issueToBuildTask(child(19, "## Outcome\nDo it."), 0), /Acceptance Criteria|File Scope|Verification/);
});

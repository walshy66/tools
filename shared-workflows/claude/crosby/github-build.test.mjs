import assert from "node:assert/strict";
import test from "node:test";
import { issueToBuildTask, renderGitHubBuild, taskIdForIssue } from "./github-build.mjs";

const child = (number, body, labels = ["mode:afk"]) => ({ number, identifier: `#${number}`, title: `Task ${number}`, body, labels: { nodes: labels.map((name) => ({ name })) } });
const body = `## Outcome\nImplement the adapter.\n\n## Acceptance Criteria\n- Parse issues\n- Validate remotes\n\n## File Scope\n- shared-workflows/pi/extensions/crosby/**\n\n## Verification\n- node --test test.mjs\n\n## Guardrails\n- Do not bypass scope validation.`;

test("maps GitHub issue numbers to stable local task IDs", () => {
  assert.equal(taskIdForIssue({ number: 17 }), "task-017");
  assert.equal(issueToBuildTask(child(17, body), 0).id, "task-017");
  assert.equal(issueToBuildTask(child(17, body), 0).tabLabel, "Crosby #17");
  const routed = issueToBuildTask(child(17, body, ["mode:afk", "model:openai-codex/gpt-5.6-luna", "thinking:high"]), 0);
  assert.equal(routed.modelHint, "openai-codex/gpt-5.6-luna");
  assert.equal(routed.thinkingHint, "high");
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

test("renders standalone parent tasks without changing the required task contract", () => {
  const parentTask = { ...child(123, body, ["type:parent", "mode:afk", "status:execute"]), standaloneParentTask: true, parentIdentifier: "#123" };
  const task = issueToBuildTask(parentTask, 0);
  assert.equal(task.id, "task-123");
  assert.equal(task.standaloneParentTask, true);
  assert.equal(task.sourceIssue, "#123");
  assert.equal(task.tabLabel, "Crosby #123");
  const markdown = renderGitHubBuild({ parent: { number: 123, branchName: "issue-123-one-slice" }, children: [parentTask] });
  assert.match(markdown, /\*\*Standalone parent task\*\*: yes/);
  assert.match(markdown, /\*\*Source issue\*\*: #123/);
});

test("allows HITL children without repository file scope", () => {
  const hitl = child(30, "## Outcome\nRun staging acceptance.\n\n## Acceptance Criteria\n- Confirm the operator checklist.\n\n## File Scope\nThis is a manual acceptance task.\n\n## Verification\nFollow the runbook.\n\n## Guardrails\nDo not use production data.", ["mode:hitl", "status:review"]);
  const task = issueToBuildTask(hitl, 0);
  assert.equal(task.mode, "HITL");
  assert.deepEqual(task.scope, []);
});

test("legacy five-section issues remain parseable but report missing new contracts", async () => {
  const { parseBuildTaskList } = await import("./task-list.mjs");
  const task = issueToBuildTask(child(17, body), 0);
  const parsed = parseBuildTaskList(renderGitHubBuild({ parent: { number: 14, branchName: "test" }, children: [child(17, body)] })).tasks[0];
  for (const value of [task, parsed]) {
    assert.match(value.contractError, /Review Context/);
    assert.match(value.contractError, /Browser Acceptance/);
    assert.match(value.contractError, /Dependencies/);
  }
});

test("preserves parent review and explicit browser context and flags absent parent declarations", async () => {
  const { parseBuildTaskList } = await import("./task-list.mjs");
  const queue = { parent: { number: 14, branchName: "test", body: "## Review Context\nCross-issue review against AGENTS.md\n## Browser Acceptance\nBrowser testing: not applicable\nReason: CLI library only." }, children: [child(17, body)] };
  const build = parseBuildTaskList(renderGitHubBuild(queue));
  assert.equal(build.parentReviewContext, "Cross-issue review against AGENTS.md");
  assert.equal(build.parentBrowserAcceptance.required, false);
  assert.equal(build.parentBrowserAcceptance.reason, "CLI library only.");
  assert.equal(build.contractError, "");
  const missing = parseBuildTaskList(renderGitHubBuild({ ...queue, parent: { ...queue.parent, body: "" } }));
  assert.match(missing.contractError, /Browser Acceptance/);
  const browser = `Browser testing: required
Testing instructions: docs/testing.md
### PW-01: Cross-issue journey
- Acceptance criteria: AC-01, AC-02
- Preconditions/test data: Synthetic account
- User actions: Complete both issue flows
- Expected outcomes: Combined result visible
### PW-02: Failure journey
- Acceptance criteria: AC-02
- Preconditions/test data: Rejected fixture
- User actions: Submit invalid input
- Expected outcomes: Error visible`;
  const required = parseBuildTaskList(renderGitHubBuild({ ...queue, parent: { ...queue.parent, body: `## Review Context\nAGENTS.md\n## Acceptance Criteria\n- AC-01: Combined flow\n- AC-02: Failure\n## Browser Acceptance\n${browser}` } }));
  assert.equal(required.contractError, "");
  assert.deepEqual(required.parentBrowserAcceptance, { required: true, reason: "", scenarios: [{ id: "PW-01", criteria: ["AC-01", "AC-02"] }, { id: "PW-02", criteria: ["AC-02"] }], text: browser });
});

test("fails closed when a child issue omits execution contract sections", () => {
  assert.throws(() => issueToBuildTask(child(19, "## Outcome\nDo it."), 0), /Acceptance Criteria|File Scope|Verification/);
});


test("round-trips child review and browser contracts without executing browser prose", async () => {
  const { parseBuildTaskList } = await import("./task-list.mjs");
  const browser = `Browser testing: required
Testing instructions: docs/testing.md

### PW-01: Parse UI
- Acceptance criteria: AC-01
- Preconditions/test data: Synthetic issue
- User actions: Open the issue
- Expected outcomes: Parsed issue appears`;
  const fullBody = body.replace("- Parse issues", "- AC-01: Parse issues") + `

## Review Context
Parent #14; AGENTS.md; AC-01 unit coverage.

## Dependencies
None

## Browser Acceptance
` + browser;
  const task = issueToBuildTask(child(17, fullBody), 0);
  const parsed = parseBuildTaskList(renderGitHubBuild({ parent: { number: 14, branchName: "test" }, children: [child(17, fullBody)] })).tasks[0];
  for (const value of [task, parsed]) {
    assert.equal(value.reviewContext, "Parent #14; AGENTS.md; AC-01 unit coverage.");
    assert.deepEqual(value.browserAcceptance, { required: true, reason: "", scenarios: [{ id: "PW-01", criteria: ["AC-01"] }], text: browser });
    assert.deepEqual(value.dependencies, []);
    assert.equal(value.contractError, "");
    assert.equal(value.tabLabel, "Crosby #17");
    assert.deepEqual(value.verification, ["node --test test.mjs"]);
  }
});


test("nested review context survives and cannot supply missing task metadata", async () => {
  const { parseBuildTaskList } = await import("./task-list.mjs");
  const review = "AGENTS.md\n\n### Coverage\n- AC-01: unit tests\n**Dependencies**: task-999";
  const issue = child(17, body + `\n## Review Context\n${review}\n## Dependencies\nNone\n## Browser Acceptance\nBrowser testing: not applicable\nReason: CLI only.`);
  const markdown = renderGitHubBuild({ parent: { number: 14, branchName: "test" }, children: [issue] });
  assert.equal(parseBuildTaskList(markdown).tasks[0].reviewContext, review);
  const missing = parseBuildTaskList(markdown.replace("**Dependencies**: none", "")).tasks[0];
  assert.match(missing.contractError, /Dependencies/);
  assert.deepEqual(missing.dependencies, []);
});

test("explicit issue dependencies round-trip in topological order without sequential inventions", async () => {
  const { parseBuildTaskList } = await import("./task-list.mjs");
  const contract = (deps) => body + `
## Review Context
AGENTS.md
## Dependencies
${deps}
## Browser Acceptance
Browser testing: not applicable
Reason: CLI-only parsing.`;
  const queue = { parent: { number: 14, branchName: "test" }, children: [child(17, contract("- #19")), child(18, contract("None")), child(19, contract("None"))] };
  assert.deepEqual(issueToBuildTask(queue.children[0], 0).dependencies, ["task-019"]);
  const tasks = parseBuildTaskList(renderGitHubBuild(queue)).tasks;
  assert.ok(tasks.findIndex(t => t.id === "task-019") < tasks.findIndex(t => t.id === "task-017"));
  assert.deepEqual(tasks.find(t => t.id === "task-018").dependencies, []);
  assert.ok(tasks.every(t => !t.contractError));
  for (const deps of ["", "slice-A", "None, #19", "#999", "#17"]) {
    const parsed = parseBuildTaskList(renderGitHubBuild({ ...queue, children: [child(17, contract(deps)), child(18, contract("None"))] })).tasks;
    assert.match(parsed.find(t => t.id === "task-017").contractError, /dependenc/i);
    assert.equal(parsed.find(t => t.id === "task-018").contractError, "");
  }
  const cycle = parseBuildTaskList(renderGitHubBuild({ ...queue, children: [child(17, contract("#18")), child(18, contract("#17")), child(19, contract("None"))] })).tasks;
  assert.ok(cycle.filter(t => t.id !== "task-019").every(t => /cycle/i.test(t.contractError)));
  assert.equal(cycle.find(t => t.id === "task-019").contractError, "");
});

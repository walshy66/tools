import test from "node:test";
import assert from "node:assert/strict";
import { parseBuildTaskList } from "./task-list.mjs";

test("parses ordered build tasks with stable IDs and execution contracts", () => {
  const result = parseBuildTaskList(`
# Build: 001-example

**Parent branch**: \`crosby/001-example\`
**Execution**: sequential, list order

## task-001 — Add parser

**Dependencies**: none
**Outcome**: Parse the task list.

### Acceptance criteria

- Preserves authored order.

### Crosby execution

- Parallel: sequential
- File scope:
  - \`src/parser.mjs\`
- Verification:
  - \`node --test src/parser.test.mjs\`

### Instructions

Read the build task list.

### Guardrails

Do not use a tracker.

## task-002 — Add tests

**Dependencies**: task-001
**Outcome**: Verify the parser.

### Acceptance criteria

- Rejects malformed input.

### Crosby execution

- Parallel: sequential
- File scope:
  - \`src/parser.test.mjs\`
- Verification:
  - \`node --test src/parser.test.mjs\`

### Instructions

Run the parser tests.

### Guardrails

Keep the task scoped.
`);

  assert.equal(result.buildId, "001-example");
  assert.equal(result.parentBranch, "crosby/001-example");
  assert.deepEqual(result.tasks.map((task) => task.id), ["task-001", "task-002"]);
  assert.equal(result.tasks[0].title, "Add parser");
  assert.equal(result.tasks[0].executionMode, "AFK");
  assert.deepEqual(result.tasks[0].dependencies, []);
  assert.deepEqual(result.tasks[1].dependencies, ["task-001"]);
  assert.deepEqual(result.tasks[0].fileScope, ["src/parser.mjs"]);
  assert.deepEqual(result.tasks[0].verification, ["node --test src/parser.test.mjs"]);
  assert.match(result.tasks[0].instructions, /Read the build task list/);
  assert.match(result.tasks[0].guardrails, /Do not use a tracker/);
});

test("uses the outcome as worker instructions when an explicit Instructions section is omitted", () => {
  const result = parseBuildTaskList(`# Build: 001-concise\n\n**Parent branch**: \`crosby/001-concise\`\n\n## task-001 — Concise task\n\n**Dependencies**: none\n**Outcome**: Deliver the complete concise task outcome.\n**Execution mode**: HITL\n\n### Acceptance criteria\n- The outcome is complete.\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`src/concise.mjs\`\n- Verification:\n  - \`node --test concise\`\n\n### Guardrails\nStay scoped.`);

  assert.equal(result.tasks[0].instructions, "Deliver the complete concise task outcome.");
  assert.equal(result.tasks[0].executionMode, "HITL");
});

test("orders forward references before dependent tasks", () => {
  const result = parseBuildTaskList(`# Build: 001-invalid\n\n**Parent branch**: \`crosby/001-invalid\`\n\n## task-001 — First\n\n**Dependencies**: task-002\n**Outcome**: First\n\n### Acceptance criteria\n- First\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`src/first.mjs\`\n- Verification:\n  - \`node --test first\`\n\n### Instructions\nDo first.\n\n### Guardrails\nStay scoped.\n\n## task-002 — Second\n\n**Dependencies**: none\n**Outcome**: Second\n\n### Acceptance criteria\n- Second\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`src/second.mjs\`\n- Verification:\n  - \`node --test second\`\n\n### Instructions\nDo second.\n\n### Guardrails\nStay scoped.`);
  assert.deepEqual(result.tasks.map(task => task.id), ["task-002", "task-001"]);
});

test("authored task lists localize dependency errors without blocking unrelated contracts", () => {
  const task = (id, deps) => `## ${id} — Review
**Dependencies**: ${deps}
**Outcome**: Review the result.
**Execution mode**: HITL
### Acceptance criteria
- AC-01: Reviewed
### Crosby execution
- Parallel: sequential
### Review Context
AGENTS.md
### Browser Acceptance
Browser testing: not applicable
Reason: CLI-only change.
### Guardrails
Stay scoped.
`;
  const parse = (first, second = "none") => parseBuildTaskList(`# Build: test\n**Parent branch**: test\n${task("task-001", first)}\n${task("task-002", second)}\n${task("task-003", "none")}`);
  for (const deps of ["", "draft-A", "task-999", "task-001", "none, task-002"]) {
    const build = parse(deps);
    assert.match(build.tasks.find(t => t.id === "task-001").contractError, /dependenc/i);
    assert.equal(build.tasks.find(t => t.id === "task-003").contractError, "");
  }
  const cycle = parse("task-002", "task-001");
  assert.ok(cycle.tasks.filter(t => t.id !== "task-003").every(t => /cycle/i.test(t.contractError)));
  assert.equal(cycle.tasks.find(t => t.id === "task-003").contractError, "");
});

test("exposes all parent acceptance criteria to the parent verifier without mixing child criteria", () => {
  const prefix = `# Build: github-14
**Parent branch**: parent
`;
  const parent = `## Parent Acceptance Criteria
- AC-01: Combined success journey (US-01).
- [ ] AC-02: Combined failure journey (US-02).
## Parent Review Context
AGENTS.md; AC-01 and AC-02 require integration coverage.
## Parent Browser Acceptance
Browser testing: not applicable
Reason: CLI-only library.
`;
  const child = `## task-017 — Child
**Dependencies**: none
**Outcome**: Implement the child.
**Execution mode**: HITL
### Acceptance criteria
- AC-99: Child-only requirement.
### Crosby execution
- Parallel: sequential
### Guardrails
Stay scoped.
`;
  const build = parseBuildTaskList(prefix + parent + child);
  assert.deepEqual(build.parentAcceptanceCriteria, [
    "AC-01: Combined success journey (US-01).",
    "[ ] AC-02: Combined failure journey (US-02).",
  ]);
  assert.equal(build.contractError, "");
  const legacy = parseBuildTaskList(prefix + child);
  assert.deepEqual(legacy.parentAcceptanceCriteria, []);
  assert.match(legacy.contractError, /Review Context/);
  assert.match(legacy.contractError, /Browser Acceptance/);
});

test("rejects absolute file-scope paths", () => {
  assert.throws(
    () => parseBuildTaskList(`# Build: 001-invalid\n\n**Parent branch**: \`crosby/001-invalid\`\n\n## task-001 — Unsafe\n\n**Dependencies**: none\n**Outcome**: Unsafe\n\n### Acceptance criteria\n- Reject unsafe scope.\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`C:/outside.mjs\`\n- Verification:\n  - \`node --test unsafe\`\n\n### Instructions\nDo not do this.\n\n### Guardrails\nStay scoped.`),
    /unsafe file-scope path/,
  );
});

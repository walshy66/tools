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

test("rejects a task that depends on a later task", () => {
  assert.throws(
    () => parseBuildTaskList(`# Build: 001-invalid\n\n**Parent branch**: \`crosby/001-invalid\`\n\n## task-001 — First\n\n**Dependencies**: task-002\n**Outcome**: First\n\n### Acceptance criteria\n- First\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`src/first.mjs\`\n- Verification:\n  - \`node --test first\`\n\n### Instructions\nDo first.\n\n### Guardrails\nStay scoped.\n\n## task-002 — Second\n\n**Dependencies**: none\n**Outcome**: Second\n\n### Acceptance criteria\n- Second\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`src/second.mjs\`\n- Verification:\n  - \`node --test second\`\n\n### Instructions\nDo second.\n\n### Guardrails\nStay scoped.`),
    /must appear earlier/,
  );
});

test("rejects absolute file-scope paths", () => {
  assert.throws(
    () => parseBuildTaskList(`# Build: 001-invalid\n\n**Parent branch**: \`crosby/001-invalid\`\n\n## task-001 — Unsafe\n\n**Dependencies**: none\n**Outcome**: Unsafe\n\n### Acceptance criteria\n- Reject unsafe scope.\n\n### Crosby execution\n- Parallel: sequential\n- File scope:\n  - \`C:/outside.mjs\`\n- Verification:\n  - \`node --test unsafe\`\n\n### Instructions\nDo not do this.\n\n### Guardrails\nStay scoped.`),
    /unsafe file-scope path/,
  );
});

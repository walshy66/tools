import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskContractError,
  normalizeScope,
  parseTaskContract,
  scopesOverlap,
} from "./task-contract.mjs";

const modernDescription = `## Crosby execution

* Parallel: allowed
* File scope:
  * \`src/worker.mjs\`
  * \`test/worker.test.mjs\`
* Verification:
  * \`node --test test/worker.test.mjs\`
`;

test("parses a modern Crosby task contract", () => {
  assert.deepEqual(parseTaskContract(modernDescription), {
    kind: "declared",
    parallel: "allowed",
    fileScopes: [
      { path: "src/worker.mjs", type: "file" },
      { path: "test/worker.test.mjs", type: "file" },
    ],
    verification: ["node --test test/worker.test.mjs"],
  });
});

test("missing Crosby metadata is a sequential legacy contract", () => {
  assert.deepEqual(parseTaskContract("## Outcome\n\nDo a small safe change."), {
    kind: "legacy",
    parallel: "sequential",
    fileScopes: [],
    verification: [],
  });
});

test("declared but incomplete or invalid metadata fails with recovery guidance", () => {
  assert.throws(() => parseTaskContract("## Crosby execution\n* Parallel: allowed"), TaskContractError);
  assert.throws(
    () =>
      parseTaskContract(`## Crosby execution
* Parallel: allowed
* File scope:
  * /etc/passwd
* Verification:
  * node --test`),
    /repository-relative.*Recovery/i,
  );
});

test("rejects unsafe scope declarations", () => {
  for (const scope of ["/absolute/path", "C:\\drive\\path", "../parent", "src/../parent", "!generated", ".", "/", "*"]) {
    assert.throws(() => normalizeScope(scope), /scope.*Recovery/i, scope);
  }
});

test("normalizes exact-file and directory scopes", () => {
  assert.deepEqual(normalizeScope("./src//worker.mjs"), { path: "src/worker.mjs", type: "file" });
  assert.deepEqual(normalizeScope("src/workers/"), { path: "src/workers", type: "directory" });
  assert.deepEqual(normalizeScope("src/workers/**"), { path: "src/workers", type: "directory" });
});

test("scope overlap handles disjoint and file/directory combinations deterministically", () => {
  assert.equal(scopesOverlap(["src/a.mjs"], ["src/b.mjs"]), false);
  assert.equal(scopesOverlap(["src/worker.mjs"], ["src/"]), true);
  assert.equal(scopesOverlap(["src/"], ["src/nested/worker.mjs"]), true);
  assert.equal(scopesOverlap(["docs/"], ["src/"]), false);
  assert.equal(
    scopesOverlap([{ path: "src", type: "directory" }], [{ path: "src/nested/worker.mjs", type: "file" }]),
    true,
  );
});

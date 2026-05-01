import assert from "node:assert/strict";
import { loadParentQueueFromIssue, parseSingleIssueKeyArg } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

function expectThrows(fn, pattern) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "Expected function to throw");
  assert.match(thrown.message, pattern);
}

const validParent = {
  identifier: "COA-116",
  title: "The Crosby Loop",
  parent: null,
  children: [
    { identifier: "COA-117", title: "Add /crosby command entrypoint with parent validation" },
    { identifier: "COA-118", title: "Classify child issues into runnable vs non-runnable" },
  ],
};

const nonParentChildIssue = {
  identifier: "COA-117",
  title: "Add /crosby command entrypoint with parent validation",
  parent: { identifier: "COA-116", title: "The Crosby Loop" },
  children: [],
};

const zeroChildParent = {
  identifier: "COA-999",
  title: "Empty parent",
  parent: null,
  children: [],
};

assert.equal(parseSingleIssueKeyArg("COA-116"), "COA-116");
expectThrows(() => parseSingleIssueKeyArg(""), /Usage: \/crosby <PARENT-ISSUE-KEY>/);
expectThrows(() => parseSingleIssueKeyArg("COA-116 COA-117"), /accepts exactly one issue key/i);

const queue = loadParentQueueFromIssue(validParent);
assert.equal(queue.parent.identifier, "COA-116");
assert.equal(queue.children.length, 2);
assert.deepEqual(
  queue.children.map((child) => child.identifier),
  ["COA-117", "COA-118"],
);

expectThrows(
  () => loadParentQueueFromIssue(nonParentChildIssue),
  /requires a parent issue with child execution issues/i,
);
expectThrows(
  () => loadParentQueueFromIssue(zeroChildParent),
  /requires a parent issue with child execution issues/i,
);

console.log("PASS: /crosby parent validation covers valid parent, non-parent, zero-child, and one-key parsing");

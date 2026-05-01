import assert from "node:assert/strict";
import { classifyChildIssues } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

const children = [
  {
    identifier: "COA-123",
    title: "Unknown state child",
    priority: 2,
    state: { name: "Triage" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-121",
    title: "Blocked child",
    priority: 1,
    state: { name: "Build Ready" },
    relations: { blockedBy: [{ identifier: "COA-120", state: { name: "Build Ready" } }], blocks: [] },
  },
  {
    identifier: "COA-120",
    title: "High priority runnable",
    priority: 1,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-122",
    title: "Already building",
    priority: 0,
    state: { name: "Building" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-124",
    title: "Review item",
    priority: 1,
    state: { name: "Review" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-125",
    title: "Done item",
    priority: 1,
    state: { name: "Done" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-126",
    title: "Medium priority runnable",
    priority: 2,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-119",
    title: "Same priority runnable A",
    priority: 2,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-118",
    title: "Same priority runnable B",
    priority: 2,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [] },
  },
  {
    identifier: "COA-130",
    title: "Dependency parent runnable",
    priority: 3,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [{ identifier: "COA-129" }] },
  },
  {
    identifier: "COA-129",
    title: "Dependency child runnable",
    priority: 1,
    state: { name: "Build Ready" },
    relations: { blockedBy: [], blocks: [] },
  },
];

const result = classifyChildIssues(children);

assert.deepEqual(
  result.runnable.map((child) => child.identifier),
  ["COA-120", "COA-118", "COA-119", "COA-126", "COA-130", "COA-129"],
  "Runnable children should use stable priority/key ordering for unrelated items",
);
assert.ok(
  result.runnable.findIndex((child) => child.identifier === "COA-130") <
    result.runnable.findIndex((child) => child.identifier === "COA-129"),
  "Dependency ordering should keep blockers ahead of dependents",
);

assert.deepEqual(
  result.nonRunnable.map(({ child, reason }) => [child.identifier, reason]),
  [
    ["COA-121", "blocked"],
    ["COA-122", "building"],
    ["COA-123", "unknown-state"],
    ["COA-124", "review"],
    ["COA-125", "done"],
  ],
  "Non-runnable children should capture grouped skip reasons",
);

assert.deepEqual(result.reasonSummary, {
  blocked: ["COA-121"],
  building: ["COA-122"],
  "unknown-state": ["COA-123"],
  review: ["COA-124"],
  done: ["COA-125"],
});

console.log("PASS: /crosby classification handles runnable ordering and grouped skipped reasons");

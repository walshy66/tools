import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkerReportError,
  isWorkerCompletionReport,
  validateWorkerReport,
} from "./worker-protocol.mjs";

const completion = {
  outcome: "complete",
  taskOutcome: "implemented",
  summary: "Added validated Herdr client and report protocol.",
  changes: {
    paths: ["shared-workflows/pi/extensions/crosby/herdr-client.mjs"],
    commit: "abc1234",
  },
  verification: [{ command: "node --test herdr-client.test.mjs", result: "passed" }],
  risks: [],
};

test("validates and normalizes an explicit completion report", () => {
  const report = validateWorkerReport(completion);

  assert.deepEqual(report, completion);
  assert.equal(isWorkerCompletionReport(report), true);
});

test("requires completion evidence instead of using agent lifecycle state", () => {
  for (const report of [
    { ...completion, taskOutcome: "" },
    { ...completion, changes: { paths: [], commit: "" } },
    { ...completion, verification: [] },
  ]) {
    assert.throws(() => validateWorkerReport(report), WorkerReportError);
  }

  assert.equal(isWorkerCompletionReport({ outcome: "complete", state: "idle" }), false);
  assert.equal(isWorkerCompletionReport({ outcome: "blocked", state: "done" }), false);
});

test("validates a block report that requests visible Herdr blocked state", () => {
  const report = validateWorkerReport({
    outcome: "blocked",
    summary: "The release decision needs an operator.",
    requiredHumanAction: "Choose the target release channel.",
    recoveryNotes: ["Resume the worker with the selected channel."],
    requestHerdrBlocked: true,
  });

  assert.deepEqual(report, {
    outcome: "blocked",
    summary: "The release decision needs an operator.",
    requiredHumanAction: "Choose the target release channel.",
    recoveryNotes: ["Resume the worker with the selected channel."],
    requestHerdrBlocked: true,
  });
  assert.equal(isWorkerCompletionReport(report), false);
});

test("validates failed and cancelled terminal reports", () => {
  for (const outcome of ["failed", "cancelled"]) {
    assert.deepEqual(validateWorkerReport({
      outcome,
      summary: `Worker ${outcome}.`,
      recoveryNotes: ["Inspect the retained worktree."],
    }), {
      outcome,
      summary: `Worker ${outcome}.`,
      recoveryNotes: ["Inspect the retained worktree."],
    });
  }
});

test("rejects malformed reports with actionable recovery guidance", () => {
  for (const report of [
    undefined,
    { outcome: "complete" },
    { outcome: "blocked", summary: "Need input", requiredHumanAction: "Decide", recoveryNotes: [] },
    { outcome: "blocked", summary: "Need input", requiredHumanAction: "Decide", recoveryNotes: ["Resume"], requestHerdrBlocked: false },
    { ...completion, changes: { paths: ["../escape"], commit: "abc1234" } },
    { ...completion, verification: [{ command: "npm test", result: "unknown" }] },
  ]) {
    assert.throws(() => validateWorkerReport(report), /Worker report.*Recovery/i);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildChildIntegrationComment, buildParentIntegrationComment, buildSupervisorStatusReport } from "./linear-reporting.mjs";

test("child integration reports retain detailed evidence while parent reports stay concise", () => {
  const child = buildChildIntegrationComment({
    child: { identifier: "COA-366", title: "Schedule safely", url: "https://linear.test/COA-366" },
    outcome: "done",
    changedPaths: ["src/a.ts"],
    verification: { skipped: false, results: [{ command: "node --test", code: 0 }] },
    merge: { sha: "abc123" },
  });
  const parent = buildParentIntegrationComment({
    child: { identifier: "COA-366", title: "Schedule safely", url: "https://linear.test/COA-366" },
    outcome: "done",
  });

  assert.match(child, /Changed paths:[\s\S]*src\/a.ts/);
  assert.match(child, /Merge commit: `abc123`/);
  assert.match(parent, /COA-366/);
  assert.doesNotMatch(parent, /Changed paths/);
});

test("supervisor status reports stay compact while identifying retained operator evidence", () => {
  const report = buildSupervisorStatusReport({
    parentKey: "COA-360",
    status: {
      taskKey: "COA-367",
      lifecycle: "paused",
      attempts: 2,
      recoveryAttempts: 1,
      agent: { name: "crosby-coa-367", state: "idle" },
      retained: { tab: "tab-367", worktree: "/managed/COA-360/tasks/COA-367", branch: "feature/coa-360/coa-367" },
    },
  });

  assert.match(report, /COA-360/);
  assert.match(report, /COA-367.*paused/i);
  assert.match(report, /crosby-coa-367 \(idle\)/);
  assert.match(report, /Retained worktree: `\/managed\/COA-360\/tasks\/COA-367`/);
  assert.doesNotMatch(report, /baseSha|recoveryNotes|launchError/);
});

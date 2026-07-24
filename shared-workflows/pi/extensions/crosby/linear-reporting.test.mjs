import test from "node:test";
import assert from "node:assert/strict";
import { buildChildIntegrationComment, buildParentIntegrationComment } from "./linear-reporting.mjs";

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

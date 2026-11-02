import assert from "node:assert/strict";
import test from "node:test";
import { buildGitHubChildProgress, buildGitHubParentSummary } from "./github-reporting.mjs";

test("builds a child progress comment with verification and risks", () => {
  const text = buildGitHubChildProgress({ child: { identifier: "#17" }, outcome: "complete", summary: "Done", changes: ["Adapter"], verification: ["131 tests"], recoveryNotes: [] });
  assert.match(text, /## Crosby progress — #17/);
  assert.match(text, /131 tests/);
});

test("builds a consolidated parent summary", () => {
  const text = buildGitHubParentSummary({ parent: { identifier: "#14", title: "Feature" }, branch: "crosby/feature", children: [{ identifier: "#17", title: "Adapter" }] });
  assert.match(text, /Completed children/);
  assert.match(text, /#17 — Adapter/);
});

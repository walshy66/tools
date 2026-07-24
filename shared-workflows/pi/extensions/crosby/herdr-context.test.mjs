import assert from "node:assert/strict";
import test from "node:test";
import { requireCrosbyHerdrContext } from "./herdr-context.mjs";

test("requires Crosby to run inside a Herdr pane", () => {
  assert.throws(
    () => requireCrosbyHerdrContext({ HERDR_ENV: "", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" }),
    /must be run from a Herdr-managed Pi pane/i,
  );
});

test("uses the caller workspace instead of mutable UI focus", () => {
  assert.deepEqual(
    requireCrosbyHerdrContext({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" }),
    { workspace: "w1", pane: "w1:p1" },
  );
});

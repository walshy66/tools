import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardPaneCommand, dashboardPaneSplitArguments } from "./dashboard-launch.mjs";

test("opens the dashboard to the right of the trigger pane", () => {
  assert.deepEqual(
    dashboardPaneSplitArguments({ paneId: "w1:p1", sourcePath: "C:/repo" }),
    ["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", "C:/repo"],
  );
});

test("quotes Windows dashboard launch paths for PowerShell", () => {
  assert.equal(
    buildDashboardPaneCommand({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      runnerPath: "C:\\Users\\cam'er\\dashboard-runner.mjs",
      runId: "crosby-123",
      platform: "win32",
    }),
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\cam''er\\dashboard-runner.mjs' '--run' 'crosby-123'",
  );
});

test("quotes POSIX dashboard launch paths for the pane shell", () => {
  assert.equal(
    buildDashboardPaneCommand({
      nodePath: "/opt/node bin/node",
      runnerPath: "/tmp/crosby's/dashboard-runner.mjs",
      runId: "crosby-123",
      platform: "linux",
    }),
    "'/opt/node bin/node' '/tmp/crosby'\"'\"'s/dashboard-runner.mjs' '--run' 'crosby-123'",
  );
});

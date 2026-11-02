import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getCrosbyRunsRoot } from "./dashboard.mjs";

function required(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Dashboard launch requires ${name}.`);
  return result;
}

function shellQuote(value, platform) {
  const text = required(value, "a non-empty command argument");
  return platform === "win32"
    ? `'${text.replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function dashboardPaneSplitArguments({ paneId, sourcePath } = {}) {
  return [
    "pane",
    "split",
    required(paneId, "the trigger pane id"),
    "--direction",
    "right",
    "--no-focus",
    "--cwd",
    required(sourcePath, "the source path"),
  ];
}

export function buildDashboardPaneCommand({ nodePath, runnerPath, runId, runFile, platform = process.platform } = {}) {
  const args = [nodePath, runnerPath, runFile ? "--run-file" : "--run", runFile ?? runId].map((value) => shellQuote(value, platform));
  return `${platform === "win32" ? "& " : ""}${args.join(" ")}`;
}

// A binding belongs to the initiating pane, not to a transient Crosby run.
// Persist it so /reload and Pi restarts can reuse the same dashboard process.
export async function ensureDashboardPane({ exec, root = path.join(getCrosbyRunsRoot(), "dashboard-panes"), paneId, sourcePath, nodePath, runnerPath, runId } = {}) {
  const key = createHash("sha256").update(required(paneId, "the trigger pane id")).digest("hex");
  const runFile = path.join(root, `${key}.json`);
  const launchRunner = async (binding) => {
    const command = buildDashboardPaneCommand({ nodePath, runnerPath, runFile });
    const launch = await exec("herdr", ["pane", "run", binding.paneId, command]);
    if (launch.code !== 0) throw new Error(launch.stderr || "dashboard pane launch failed");
    fs.writeFileSync(runFile, JSON.stringify({ ...binding, launched: true }));
  };
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (binding?.paneId) {
    const inspection = await exec("herdr", ["pane", "get", binding.paneId]);
    if (inspection.code === 0) {
      const payload = JSON.parse(inspection.stdout);
      if (payload.error || !payload.result) throw new Error("Could not verify the existing Crosby dashboard pane.");
      binding = { ...binding, runId: required(runId, "the run id") };
      fs.writeFileSync(runFile, JSON.stringify(binding));
      if (!binding.launched) await launchRunner(binding);
      return { paneId: binding.paneId, runFile, reused: true };
    }
    // Only a confirmed missing pane permits a replacement, not a CLI outage.
    if (!/not found|unknown pane|no such pane|does not exist/i.test(`${inspection.stderr ?? ""} ${inspection.stdout ?? ""}`)) {
      throw new Error(inspection.stderr || inspection.stdout || "Dashboard pane inspection failed.");
    }
  }
  const split = await exec("herdr", dashboardPaneSplitArguments({ paneId, sourcePath }));
  if (split.code !== 0) throw new Error(split.stderr || "dashboard pane split failed");
  const payload = JSON.parse(split.stdout);
  const dashboardPaneId = payload?.result?.pane?.pane_id ?? payload?.result?.root_pane?.pane_id ?? payload?.result?.pane_id;
  if (!dashboardPaneId) throw new Error("Herdr did not return the dashboard pane id.");
  fs.mkdirSync(root, { recursive: true });
  binding = { paneId: dashboardPaneId, runId: required(runId, "the run id"), launched: false };
  fs.writeFileSync(runFile, JSON.stringify(binding));
  await launchRunner(binding);
  return { paneId: dashboardPaneId, runFile, reused: false };
}

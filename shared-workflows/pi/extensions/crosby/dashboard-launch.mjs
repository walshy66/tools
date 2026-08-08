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

export function buildDashboardPaneCommand({ nodePath, runnerPath, runId, platform = process.platform } = {}) {
  const args = [nodePath, runnerPath, "--run", runId].map((value) => shellQuote(value, platform));
  return `${platform === "win32" ? "& " : ""}${args.join(" ")}`;
}

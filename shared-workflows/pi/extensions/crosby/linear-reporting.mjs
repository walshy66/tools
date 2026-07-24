function bullets(entries, fallback = "- None.") {
  return Array.isArray(entries) && entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : fallback;
}

function commandResults(verification) {
  if (verification?.skipped) return ["Task contract declared verification: none (skipped)."];
  return (verification?.results ?? []).map((result) => `${result.command} (exit ${result.code ?? 0})`);
}

/** Detailed durable evidence belongs on the child, not the parent queue. */
export function buildChildIntegrationComment({ child, outcome, summary, changedPaths, verification, merge, retained } = {}) {
  const status = outcome === "done" ? "Integrated" : "Needs human review";
  const recovery = retained?.recoveryNotes ?? [];
  return [
    `## Crosby task report — ${status}`,
    "",
    `Task: ${child?.identifier ?? "unknown"} — ${child?.title ?? "Unknown task"}`,
    summary ? `Summary: ${summary}` : null,
    "",
    "Changed paths:",
    bullets(changedPaths),
    "",
    "Task verification:",
    bullets(commandResults(verification)),
    "",
    merge?.sha ? `Merge commit: \`${merge.sha}\`` : null,
    retained?.taskWorktreePath ? `Retained task worktree: \`${retained.taskWorktreePath}\`` : null,
    retained?.taskBranch ? `Retained task branch: \`${retained.taskBranch}\`` : null,
    recovery.length ? `Recovery notes:\n${bullets(recovery)}` : null,
  ].filter(Boolean).join("\n");
}

/** Parent comments intentionally link to detailed child evidence without copying it. */
export function buildParentIntegrationComment({ child, outcome, requiredHumanAction } = {}) {
  const link = child?.url ? `[${child.identifier}](${child.url})` : child?.identifier ?? "child issue";
  if (outcome === "done") return `${link} integrated successfully.`;
  return `${link} requires human action${requiredHumanAction ? `: ${requiredHumanAction}` : "."}`;
}

/** Compact operator-facing state; durable worker details remain in the registry. */
export function buildSupervisorStatusReport({ parentKey, status } = {}) {
  const taskKey = status?.taskKey ?? "unknown task";
  const lifecycle = status?.lifecycle ?? "unknown";
  const agent = status?.agent ? `${status.agent.name} (${status.agent.state})` : "none";
  const retained = status?.retained ?? {};
  return [
    `Crosby supervisor — ${parentKey ?? "unknown parent"}`,
    `Task: ${taskKey} (${lifecycle})`,
    `Attempts: ${Number(status?.attempts ?? 0)}; recoveries: ${Number(status?.recoveryAttempts ?? 0)}`,
    `Agent: ${agent}`,
    retained.tab ? `Retained tab: \`${retained.tab}\`` : null,
    retained.worktree ? `Retained worktree: \`${retained.worktree}\`` : null,
    retained.branch ? `Retained branch: \`${retained.branch}\`` : null,
  ].filter(Boolean).join("\n");
}

export function buildFinalIntegrationComment({ parent, children } = {}) {
  const childLinks = (Array.isArray(children) ? children : []).map((child) => child?.url ? `[${child.identifier}](${child.url})` : child?.identifier).filter(Boolean);
  return `${parent?.identifier ?? "Parent"} integration checks passed. Children: ${childLinks.join(", ") || "none"}.`;
}

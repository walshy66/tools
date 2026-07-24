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

export function buildFinalIntegrationComment({ parent, children } = {}) {
  const childLinks = (Array.isArray(children) ? children : []).map((child) => child?.url ? `[${child.identifier}](${child.url})` : child?.identifier).filter(Boolean);
  return `${parent?.identifier ?? "Parent"} integration checks passed. Children: ${childLinks.join(", ") || "none"}.`;
}

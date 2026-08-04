function bullets(values, fallback = "- None.") {
  return Array.isArray(values) && values.length ? values.map((value) => `- ${value}`).join("\n") : fallback;
}

export function buildGitHubChildProgress({ child, outcome, summary, changes, verification, recoveryNotes } = {}) {
  return [
    `## Crosby progress — ${child?.identifier ?? "unknown"}`,
    "",
    `Status: ${outcome ?? "unknown"}`,
    "",
    `Summary: ${summary ?? "No summary provided."}`,
    "",
    "Changes:",
    bullets(changes),
    "",
    "Verification:",
    bullets(verification),
    "",
    "Follow-up / risks:",
    bullets(recoveryNotes),
  ].join("\n");
}

export function buildGitHubParentSummary({ parent, children = [], branch, pullRequest } = {}) {
  return [
    `## Crosby final summary — ${parent?.identifier ?? "unknown"}`,
    "",
    `Parent: ${parent?.title ?? "Unknown parent"}`,
    `Branch: ${branch ?? parent?.branchName ?? "unknown"}`,
    ...(pullRequest ? [`Pull request: ${pullRequest}`] : []),
    "",
    "Completed children:",
    children.length ? children.map((child) => `- ${child.identifier} — ${child.title}`).join("\n") : "- None.",
  ].join("\n");
}

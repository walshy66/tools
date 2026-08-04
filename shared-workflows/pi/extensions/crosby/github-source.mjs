const STATUS_LABELS = [
  "status:ready",
  "status:execute",
  "status:ready-to-build",
  "status:building",
  "status:review",
];

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeRepositoryUrl(value) {
  const raw = text(value)
    .replace(/^git\+/, "")
    .replace(/\.git(?:\/)?$/, "")
    .replace(/\/$/, "");
  if (!raw) return "";
  const ssh = raw.match(/^git@github\.com:(.+)$/i);
  if (ssh) return `https://github.com/${ssh[1]}`.toLowerCase();
  const url = raw.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (url) return `https://github.com/${url[1]}`.toLowerCase();
  return raw.toLowerCase();
}

export function repositoryFromIssueUrl(url) {
  const match = text(url).match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i);
  return match ? normalizeRepositoryUrl(`https://github.com/${match[1]}`) : "";
}

export function normalizeIssueRef(value) {
  const raw = text(value);
  if (!raw) return "";
  const url = raw.match(/\/issues\/(\d+)\/?$/i);
  if (url) return url[1];
  const hash = raw.match(/^#?(\d+)$/);
  return hash ? hash[1] : raw;
}

export function issueNumber(issue) {
  return normalizeIssueRef(issue?.number ?? issue?.identifier);
}

export function issueIdentifier(issue) {
  const number = issueNumber(issue);
  return number ? `#${number}` : text(issue?.identifier) || "UNKNOWN-ISSUE";
}

export function issueLabels(issue) {
  const labels = issue?.labels;
  if (Array.isArray(labels)) {
    return labels.map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
  }
  if (Array.isArray(labels?.nodes)) return labels.nodes.map((label) => label?.name).filter(Boolean);
  return [];
}

export function labelValue(issue, prefix) {
  const hit = issueLabels(issue).find((label) => label.startsWith(prefix));
  return hit ? text(hit.slice(prefix.length)) || null : null;
}

export function statusFromIssue(issue) {
  if (text(issue?.state).toLowerCase() === "closed") return "Done";
  const labels = issueLabels(issue).map((label) => label.toLowerCase());
  if (labels.includes("status:building")) return "Building";
  if (labels.includes("status:execute")) return "Execute";
  if (labels.includes("status:ready-to-build")) return "Ready to Build";
  if (labels.includes("status:review")) return "Review";
  if (labels.includes("status:ready")) return "Ready";
  return "Unknown";
}

export function statusType(status) {
  if (status === "Done") return "completed";
  if (["Building", "Execute"].includes(status)) return "started";
  if (status === "Review") return "review";
  return "unstarted";
}

export function parseChildIssueRefs(body) {
  const section = text(body).match(/(?:^|\n)##\s+Child Issues\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? "";
  const refs = [];
  const seen = new Set();
  for (const match of section.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      refs.push(match[1]);
    }
  }
  return refs;
}

export function parseParentIssueRef(body) {
  const match = text(body).match(/(?:^|\n)\s*Parent:\s*#?(\d+)\b/i);
  return match ? `#${match[1]}` : undefined;
}

export function deriveBranchName(issue) {
  const bodyBranch = text(issue?.body).match(/(?:^|\n)\s*Branch:\s*([^\n]+)/i)?.[1];
  if (bodyBranch) return text(bodyBranch);
  const labelBranch = issueLabels(issue).find((label) => /^branch:/i.test(label));
  if (labelBranch) return text(labelBranch.replace(/^branch:/i, ""));
  const slug = text(issue?.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `issue-${issueNumber(issue)}${slug ? `-${slug}` : ""}`;
}

export function toCrosbyIssue(issue, children = []) {
  const status = statusFromIssue(issue);
  const parent = parseParentIssueRef(issue?.body);
  return {
    ...issue,
    identifier: issueIdentifier(issue),
    number: issueNumber(issue),
    title: text(issue?.title),
    description: issue?.body,
    body: issue?.body,
    branchName: deriveBranchName(issue),
    state: { name: status, type: statusType(status) },
    labels: { nodes: issueLabels(issue).map((name) => ({ name })) },
    parent: parent ? { identifier: parent } : undefined,
    children,
    comments: { nodes: issue?.comments?.nodes ?? issue?.comments ?? [] },
  };
}

export function targetLabelState(state) {
  switch (text(state).toLowerCase()) {
    case "building":
    case "build": return { add: "status:building", close: false };
    case "review":
    case "in review": return { add: "status:review", close: false };
    case "ready to build": return { add: "status:ready-to-build", close: false };
    case "ready": return { add: "status:ready", close: false };
    case "execute": return { add: "status:execute", close: false };
    case "done": return { add: undefined, close: true };
    default: return { add: undefined, close: false };
  }
}

export function editLabelArguments(issueRef, state) {
  const target = targetLabelState(state);
  if (target.close) return ["issue", "close", normalizeIssueRef(issueRef)];
  if (!target.add) return null;
  return ["issue", "edit", normalizeIssueRef(issueRef), "--add-label", target.add,
    ...STATUS_LABELS.filter((label) => label !== target.add).flatMap((label) => ["--remove-label", label])];
}

export function isAutomatedIssue(issue) {
  return issueLabels(issue).some((label) => label.toLowerCase() === "mode:afk");
}

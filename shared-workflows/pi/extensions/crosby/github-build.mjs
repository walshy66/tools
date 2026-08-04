import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function section(body, heading) {
  const match = String(body ?? "").match(new RegExp(`^##\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`, "im"));
  return match?.[1]?.trim() ?? "";
}

function bullets(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.match(/^\s*-\s+\[?\s?[x ]?\]?\s*(.+)$/i)?.[1]?.trim()).filter(Boolean);
}

function required(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`GitHub child issue is missing ${name}.`);
  return result;
}

export function taskIdForIssue(issue) {
  const number = String(issue?.number ?? issue?.identifier ?? "").match(/\d+/)?.[0];
  if (!number) throw new Error("GitHub child issue has no numeric issue number.");
  return `task-${number.padStart(3, "0")}`;
}

export function issueToBuildTask(issue, order) {
  const outcome = required(section(issue?.body, "Outcome"), `${issue.identifier} Outcome`);
  const criteria = bullets(section(issue?.body, "Acceptance Criteria"));
  const scope = bullets(section(issue?.body, "File Scope"));
  const verification = bullets(section(issue?.body, "Verification"));
  const guardrails = section(issue?.body, "Guardrails") || "Preserve Crosby safety and report a blocked outcome when the contract cannot be satisfied.";
  if (!criteria.length) throw new Error(`${issue.identifier} is missing Acceptance Criteria.`);
  if (!scope.length) throw new Error(`${issue.identifier} is missing File Scope.`);
  if (!verification.length) throw new Error(`${issue.identifier} is missing Verification.`);
  const labels = issue.labels?.nodes?.map((label) => label.name) ?? [];
  const modelHint = labels.find((label) => label.startsWith("model:"))?.slice("model:".length) || null;
  const effortHint = labels.find((label) => label.startsWith("effort:"))?.slice("effort:".length) || null;
  const mode = labels.some((label) => label === "mode:hitl") ? "HITL" : "AFK";
  return { id: taskIdForIssue(issue), title: issue.title, outcome, criteria, scope, verification, guardrails, mode, modelHint, effortHint, tabLabel: `Task #${issue.number}`, order };
}

export function renderGitHubBuild(queue) {
  const parentBranch = queue?.parent?.branchName;
  if (!parentBranch) throw new Error(`GitHub parent ${queue?.parent?.identifier ?? "unknown"} has no branch name.`);
  const tasks = queue.children.map(issueToBuildTask);
  const lines = [`# Build: github-${queue.parent.number}`, ``, `**Parent branch**: \`${parentBranch}\``, `**Execution**: sequential, list order`, ``];
  for (const task of tasks) {
    lines.push(`## ${task.id} — ${task.title}`, ``, `**Dependencies**: ${task.order === 0 ? "none" : `task-${String(queue.children[task.order - 1].number).padStart(3, "0")}`}`, ``, `**Outcome**: ${task.outcome}`, ...(task.modelHint ? [`**Model hint**: ${task.modelHint}`] : []), ...(task.effortHint ? [`**Effort hint**: ${task.effortHint}`] : []), ``, `### Acceptance criteria`, ...task.criteria.map((item) => `- ${item}`), ``, `### Crosby execution`, ``, `- Parallel: sequential`, `- File scope:`, ...task.scope.map((item) => `  - \`${item}\``), `- Verification:`, ...task.verification.map((item) => `  - \`${item}\``), ``, `### Guardrails`, ``, task.guardrails, ``, `### Instructions`, ``, task.outcome, ``);
  }
  return lines.join("\n");
}

export async function writeGitHubBuild(queue, root) {
  const folder = path.join(root, `.crosby-github-${queue.parent.number}`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "tasks.md"), renderGitHubBuild(queue), "utf8");
  return folder;
}

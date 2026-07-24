export class TaskContractError extends Error {
  constructor(message) {
    super(`${message} Recovery: correct the Crosby execution contract with narrow repository-relative scopes, then rerun the task.`);
    this.name = "TaskContractError";
  }
}

function stripMarkdown(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^`+|`+$/g, "").trim();
}

function contractError(message) {
  throw new TaskContractError(message);
}

export function normalizeScope(value) {
  const original = stripMarkdown(value);
  if (!original) contractError("File scope must not be empty.");
  if (/^[!]/.test(original)) contractError(`File scope '${original}' must not be negated.`);
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(original)) {
    contractError(`File scope '${original}' must be repository-relative, not absolute.`);
  }
  if (/[\\]/.test(original)) contractError(`File scope '${original}' must use '/' separators.`);
  if (/[?*\[\]{}]/.test(original)) contractError(`File scope '${original}' must be an exact file or directory, not a glob.`);

  const directory = /\/$/.test(original);
  const segments = original.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) contractError(`File scope '${original}' must not cover the whole repository.`);
  if (segments.some((segment) => segment === "..")) {
    contractError(`File scope '${original}' must not contain parent traversal.`);
  }

  return { path: segments.join("/"), type: directory ? "directory" : "file" };
}

function normalizeScopeEntry(scope) {
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    if ((scope.type !== "file" && scope.type !== "directory") || typeof scope.path !== "string") {
      contractError("Normalized file scopes must contain a path and a file or directory type.");
    }
    return normalizeScope(scope.type === "directory" ? `${scope.path}/` : scope.path);
  }
  return normalizeScope(scope);
}

export function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) contractError("File scope must list at least one path.");
  return scopes.map(normalizeScopeEntry);
}

function scopeContains(container, candidate) {
  if (container.type !== "directory") return container.path === candidate.path && candidate.type === "file";
  return candidate.path === container.path || candidate.path.startsWith(`${container.path}/`);
}

export function scopesOverlap(leftScopes, rightScopes) {
  const left = normalizeScopes(leftScopes);
  const right = normalizeScopes(rightScopes);
  return left.some((leftScope) => right.some((rightScope) => scopeContains(leftScope, rightScope) || scopeContains(rightScope, leftScope)));
}

export const hasScopeOverlap = scopesOverlap;

function extractContractSection(description) {
  const text = String(description ?? "");
  const header = /^#{1,6}\s+Crosby execution\s*$/im.exec(text);
  if (!header) return null;

  const afterHeader = text.slice(header.index + header[0].length);
  return afterHeader.split(/^#{1,6}\s+/m, 1)[0];
}

function extractField(section, label) {
  const pattern = new RegExp(`^[\\t ]*(?:[-*+][\\t ]*)?${label}[\\t ]*:[\\t ]*(.*?)[\\t ]*$`, "im");
  const match = pattern.exec(section);
  if (!match) return null;

  const values = [];
  const inline = stripMarkdown(match[1]);
  if (inline) values.push(inline);

  const followingLines = section.slice(match.index + match[0].length).split(/\r?\n/);
  for (const line of followingLines) {
    if (/^\s*(?:[-*+]\s*)?(?:Parallel|File scope|Verification)\s*:/i.test(line)) break;
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    if (bullet) values.push(stripMarkdown(bullet[1]));
  }

  return values;
}

function parseParallel(section) {
  const values = extractField(section, "Parallel");
  if (!values || values.length !== 1) contractError("Parallel must be declared exactly once as 'allowed' or 'sequential'.");
  const parallel = values[0].toLowerCase();
  if (parallel !== "allowed" && parallel !== "sequential") {
    contractError("Parallel must be 'allowed' or 'sequential'.");
  }
  return parallel;
}

function parseVerification(section) {
  const values = extractField(section, "Verification");
  if (!values || values.length === 0) contractError("Verification must list command(s), or 'none' for documented copy-only work.");
  if (values.some((value) => !value)) contractError("Verification commands must not be empty.");
  if (values.includes("none") && values.length !== 1) contractError("Verification 'none' cannot be combined with commands.");
  return values;
}

export function parseTaskContract(description) {
  const text = String(description ?? "");
  const section = extractContractSection(text);
  const hasDeclaredField = /(?:^|\n)\s*(?:[-*+]\s*)?(?:Parallel|File scope|Verification)\s*:/im.test(text);

  if (!section) {
    if (hasDeclaredField) contractError("Crosby metadata must be contained in a '## Crosby execution' section.");
    return { kind: "legacy", parallel: "sequential", fileScopes: [], verification: [] };
  }

  const scopes = extractField(section, "File scope");
  if (!scopes || scopes.length === 0) contractError("File scope must list at least one repository-relative path.");

  return {
    kind: "declared",
    parallel: parseParallel(section),
    fileScopes: normalizeScopes(scopes),
    verification: parseVerification(section),
  };
}

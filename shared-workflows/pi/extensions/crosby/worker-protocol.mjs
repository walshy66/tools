export class WorkerReportError extends Error {
  constructor(message) {
    super(`${message} Recovery: submit an explicit complete or blocked Crosby worker report with the required task evidence, then retry the supervisor action.`);
    this.name = "WorkerReportError";
  }
}

function fail(message) {
  throw new WorkerReportError(`Worker report ${message}`);
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object.");
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

function stringList(value, field, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${field} must be ${required ? "a non-empty " : "an "}array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function pathList(value) {
  const paths = stringList(value, "changes.paths", { required: true });
  if (paths.some((pathname) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)|(?:^|\/)\.\.(?:\/|$)|[\\\0]/.test(pathname))) {
    fail("changes.paths must contain repository-relative paths without traversal.");
  }
  return paths;
}

function verificationList(value) {
  if (!Array.isArray(value) || value.length === 0) fail("verification must be a non-empty array.");
  return value.map((item, index) => {
    const entry = object(item);
    const command = text(entry.command, `verification[${index}].command`);
    const result = text(entry.result, `verification[${index}].result`);
    if (result !== "passed" && result !== "skipped") {
      fail(`verification[${index}].result must be 'passed' or 'skipped'.`);
    }
    return { command, result };
  });
}

function completionReport(report) {
  return {
    outcome: "complete",
    taskOutcome: text(report.taskOutcome, "taskOutcome"),
    summary: text(report.summary, "summary"),
    changes: {
      paths: pathList(object(report.changes).paths),
      commit: text(report.changes?.commit, "changes.commit"),
    },
    verification: verificationList(report.verification),
    risks: stringList(report.risks, "risks"),
  };
}

function blockedReport(report) {
  if (report.requestHerdrBlocked !== true) fail("blocked reports must set requestHerdrBlocked to true.");
  return {
    outcome: "blocked",
    summary: text(report.summary, "summary"),
    requiredHumanAction: text(report.requiredHumanAction, "requiredHumanAction"),
    recoveryNotes: stringList(report.recoveryNotes, "recoveryNotes", { required: true }),
    requestHerdrBlocked: true,
  };
}

export function validateWorkerReport(value) {
  const report = object(value);
  if (report.outcome === "complete") return completionReport(report);
  if (report.outcome === "blocked") return blockedReport(report);
  fail("outcome must be 'complete' or 'blocked'.");
}

export function isWorkerCompletionReport(value) {
  try {
    return validateWorkerReport(value).outcome === "complete";
  } catch {
    return false;
  }
}

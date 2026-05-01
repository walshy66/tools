export function parseSingleIssueKeyArg(args) {
  const tokens = String(args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 0) {
    throw new Error("Usage: /crosby <PARENT-ISSUE-KEY>");
  }

  throw new Error(
    "/crosby accepts exactly one issue key. Recovery: rerun /crosby with a single parent issue key, e.g. /crosby COA-116.",
  );
}

export function loadParentQueueFromIssue(issue) {
  const children = Array.isArray(issue?.children) ? issue.children : [];

  if (issue?.parent) {
    throw new Error(
      `/crosby requires a parent issue with child execution issues. ${issue.identifier} is a child of ${issue.parent.identifier}. Recovery: rerun /crosby with the parent issue key.`,
    );
  }

  if (children.length === 0) {
    throw new Error(
      `/crosby requires a parent issue with child execution issues. ${issue?.identifier ?? "The supplied issue"} has no child issues. Recovery: add child execution issues first, then rerun /crosby.`,
    );
  }

  return {
    parent: issue,
    children,
  };
}

function getStateName(child) {
  return child?.state?.name ?? "Unknown";
}

function getPriorityRank(child) {
  return Number.isFinite(child?.priority) ? child.priority : Number.MAX_SAFE_INTEGER;
}

function compareIssueKeys(a, b) {
  return String(a.identifier ?? "").localeCompare(String(b.identifier ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareChildren(a, b) {
  const priorityDiff = getPriorityRank(a) - getPriorityRank(b);
  return priorityDiff !== 0 ? priorityDiff : compareIssueKeys(a, b);
}

function hasUnresolvedBlockers(child) {
  const blockedBy = Array.isArray(child?.relations?.blockedBy) ? child.relations.blockedBy : [];
  return blockedBy.some((blocker) => blocker?.state?.name !== "Done");
}

function getNonRunnableReason(child) {
  if (hasUnresolvedBlockers(child)) return "blocked";

  switch (getStateName(child)) {
    case "Build Ready":
      return null;
    case "Building":
      return "building";
    case "Review":
      return "review";
    case "Done":
      return "done";
    default:
      return "unknown-state";
  }
}

function getBuildingChildren(children) {
  return (Array.isArray(children) ? children : [])
    .filter((child) => child?.state?.name === "Building")
    .sort(compareIssueKeys);
}

function buildConcurrentSupervisorError(queue, buildingChildren = getBuildingChildren(queue?.children)) {
  const buildingIssueKeys = buildingChildren.map((child) => child.identifier);
  const buildingSuffix = buildingIssueKeys.length > 0 ? ` Active Building child issues: ${buildingIssueKeys.join(", ")}.` : "";

  return new Error(
    `Another active supervisor run is already in progress for ${queue?.parent?.identifier ?? "the supplied parent"}.${buildingSuffix} Recovery: wait for the active run to finish or clear the stuck Building child in Linear, then rerun /crosby ${queue?.parent?.identifier ?? "PARENT-ISSUE-KEY"}.`,
  );
}

function assertNoConcurrentSupervisor(queue) {
  const buildingChildren = getBuildingChildren(queue?.children);
  if (buildingChildren.length > 0) {
    throw buildConcurrentSupervisorError(queue, buildingChildren);
  }
}

function orderRunnableChildren(runnable) {
  const childMap = new Map(runnable.map((child) => [child.identifier, child]));
  const indegree = new Map(runnable.map((child) => [child.identifier, 0]));
  const outgoing = new Map(runnable.map((child) => [child.identifier, []]));

  for (const child of runnable) {
    const blockedChildren = Array.isArray(child?.relations?.blocks) ? child.relations.blocks : [];
    for (const blocked of blockedChildren) {
      if (!childMap.has(blocked?.identifier)) continue;
      outgoing.get(child.identifier).push(blocked.identifier);
      indegree.set(blocked.identifier, indegree.get(blocked.identifier) + 1);
    }
  }

  const ready = runnable.filter((child) => indegree.get(child.identifier) === 0).sort(compareChildren);
  const ordered = [];

  while (ready.length > 0) {
    const next = ready.shift();
    ordered.push(next);

    for (const blockedIdentifier of outgoing.get(next.identifier)) {
      indegree.set(blockedIdentifier, indegree.get(blockedIdentifier) - 1);
      if (indegree.get(blockedIdentifier) === 0) {
        ready.push(childMap.get(blockedIdentifier));
        ready.sort(compareChildren);
      }
    }
  }

  if (ordered.length !== runnable.length) {
    const remaining = runnable
      .filter((child) => !ordered.some((orderedChild) => orderedChild.identifier === child.identifier))
      .sort(compareChildren);
    ordered.push(...remaining);
  }

  return ordered;
}

export function classifyChildIssues(children) {
  const runnable = [];
  const nonRunnable = [];

  for (const child of Array.isArray(children) ? children : []) {
    const reason = getNonRunnableReason(child);
    if (reason === null) {
      runnable.push(child);
      continue;
    }

    nonRunnable.push({ child, reason });
  }

  nonRunnable.sort((a, b) => compareIssueKeys(a.child, b.child));

  const reasonSummary = nonRunnable.reduce((summary, entry) => {
    summary[entry.reason] ??= [];
    summary[entry.reason].push(entry.child.identifier);
    return summary;
  }, {});

  return {
    runnable: orderRunnableChildren(runnable),
    nonRunnable,
    reasonSummary,
  };
}

export function buildRalphLoopPrompt(issueKey) {
  return [
    `/skill:ralph-loop ${issueKey}`,
    "Return JSON only with this schema:",
    '{"issueKey":"ISSUE-KEY","issueTitle":"Issue title","outcome":"done|review|fatal","summary":"Concise summary","changes":["key change"],"tests":["test or verification run"],"requiredHumanAction":"Required for review/fatal outcomes","recoveryNotes":["Required for review/fatal outcomes"]}',
  ].join("\n");
}

function formatBulletList(entries, fallback = "- None.") {
  return Array.isArray(entries) && entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : fallback;
}

function getOutcomeStateLabel(outcome) {
  if (outcome === "done") return "Done";
  if (outcome === "review") return "Review";
  return "Fatal";
}

export function buildParentProgressComment(execution) {
  const followUpNotes =
    execution.workerResult.outcome === "review"
      ? [execution.workerResult.requiredHumanAction, ...(execution.workerResult.recoveryNotes ?? [])]
      : execution.workerResult.recoveryNotes ?? [];

  return [
    `${execution.child.identifier} — ${execution.child.title}`,
    "",
    `Status: ${getOutcomeStateLabel(execution.workerResult.outcome)}`,
    "",
    `Summary: ${execution.workerResult.summary}`,
    "",
    "Key changes:",
    formatBulletList(execution.workerResult.changes),
    "",
    "Tests/verifications:",
    formatBulletList(execution.workerResult.tests),
    "",
    "Follow-up notes / risks:",
    formatBulletList(followUpNotes),
  ].join("\n");
}

function collectSectionBullets(lines, headingPattern) {
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return [];

  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (bullets.length > 0) break;
      continue;
    }
    if (/^[A-Za-z][A-Za-z /-]*:\s*$/.test(trimmed)) break;
    if (trimmed.startsWith("- ")) {
      bullets.push(trimmed.slice(2));
    }
  }

  return bullets;
}

function summarizeChildFromExistingProgressComment(child, commentBody) {
  const lines = String(commentBody ?? "").split(/\r?\n/);
  const statusLine = lines.find((line) => /^Status:/i.test(line.trim()));
  const summaryLine = lines.find((line) => /^Summary:/i.test(line.trim()));

  return {
    identifier: child.identifier,
    title: child.title,
    status: statusLine ? statusLine.replace(/^Status:\s*/i, "").trim() : child?.state?.name ?? "Done",
    summary: summaryLine ? summaryLine.replace(/^Summary:\s*/i, "").trim() : "See earlier parent progress comment.",
    changes: collectSectionBullets(lines, /^Key changes:/i),
    tests: collectSectionBullets(lines, /^Tests(?:\/verifications(?: run)?)?:/i),
    followUp: collectSectionBullets(lines, /^Follow-up notes(?: \/ risks)?:/i),
  };
}

function summarizeChildForFinalComment(child, completedChildren, parentComments) {
  const currentRunEntry = completedChildren.find((entry) => entry.child.identifier === child.identifier);
  if (currentRunEntry) {
    const workerResult = currentRunEntry.workerResult;
    return {
      identifier: child.identifier,
      title: child.title,
      status: getOutcomeStateLabel(workerResult.outcome),
      summary: workerResult.summary,
      changes: workerResult.changes,
      tests: workerResult.tests,
      followUp:
        workerResult.outcome === "review"
          ? [workerResult.requiredHumanAction, ...(workerResult.recoveryNotes ?? [])]
          : workerResult.recoveryNotes ?? [],
    };
  }

  const matchingComment = (Array.isArray(parentComments) ? parentComments : []).find((comment) =>
    String(comment?.body ?? "").includes(child.identifier),
  );

  return summarizeChildFromExistingProgressComment(child, matchingComment?.body ?? "");
}

function areAllChildrenDone(children) {
  return Array.isArray(children) && children.length > 0 && children.every((child) => child?.state?.name === "Done");
}

export function buildFinalParentSummary(queue, completedChildren = []) {
  const parentComments = queue?.parent?.comments?.nodes ?? [];
  const completedSummaries = (Array.isArray(queue?.children) ? queue.children : [])
    .filter((child) => child?.state?.name === "Done")
    .sort(compareIssueKeys)
    .map((child) => summarizeChildForFinalComment(child, completedChildren, parentComments));

  const verificationLines = [...new Set(completedSummaries.flatMap((summary) => summary.tests).filter(Boolean))];
  const followUpLines = [...new Set(completedSummaries.flatMap((summary) => summary.followUp).filter(Boolean))];

  return [
    `${queue.parent.identifier} — ${queue.parent.title} final summary`,
    "",
    "Completed child outcomes:",
    ...completedSummaries.flatMap((summary) => [
      `- ${summary.identifier} — ${summary.title} (${summary.status})`,
      `  Summary: ${summary.summary}`,
      `  Key changes: ${summary.changes.length > 0 ? summary.changes.join("; ") : "See earlier parent progress comment."}`,
      `  Tests/verifications: ${summary.tests.length > 0 ? summary.tests.join("; ") : "See earlier parent progress comment."}`,
      `  Follow-up notes: ${summary.followUp.length > 0 ? summary.followUp.join("; ") : "None."}`,
    ]),
    "",
    "Verification rollup:",
    formatBulletList(verificationLines),
    "",
    "Follow-up notes / risks:",
    formatBulletList(followUpLines),
  ].join("\n");
}

async function reportChildOutcomeToParent(queue, execution, addComment) {
  try {
    await addComment(queue.parent.identifier, buildParentProgressComment(execution));
  } catch (error) {
    throw new Error(
      `Failed to post required parent progress comment for ${execution.child.identifier} after finalizing ${getOutcomeStateLabel(execution.workerResult.outcome)}. Recovery: add the parent progress comment on ${queue.parent.identifier}, then rerun /crosby ${queue.parent.identifier}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function finalizeParentIfComplete(queue, completedChildren, operations) {
  if (!areAllChildrenDone(queue?.children)) return;

  const finalSummary = buildFinalParentSummary(queue, completedChildren);

  try {
    await operations.addComment(queue.parent.identifier, finalSummary);
  } catch (error) {
    throw new Error(
      `Failed to post final parent summary comment for ${queue.parent.identifier}. Recovery: add the consolidated summary comment, then rerun /crosby ${queue.parent.identifier}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await operations.moveIssue(queue.parent.identifier, "Review");
  } catch (error) {
    throw new Error(
      `Failed to move parent issue ${queue.parent.identifier} to Review after all children reached Done. Recovery: move the parent to Review after confirming the final summary comment, then rerun /crosby ${queue.parent.identifier}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseStructuredWorkerResult(workerResult, child) {
  const rawOutput = String(workerResult?.stdout ?? "").trim();
  if (!rawOutput) {
    throw new Error(`Structured worker result missing for ${child.identifier}. Recovery: rerun the child worker and ensure it returns JSON only.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new Error(
      `Structured worker result invalid for ${child.identifier}. Recovery: worker output must be valid JSON with the required fields.`,
    );
  }

  const requiredString = ["issueKey", "issueTitle", "outcome", "summary"];
  for (const field of requiredString) {
    if (typeof parsed?.[field] !== "string" || parsed[field].trim() === "") {
      throw new Error(`Structured worker result missing required field '${field}' for ${child.identifier}.`);
    }
  }

  if (!Array.isArray(parsed?.changes) || parsed.changes.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Structured worker result missing required field 'changes' for ${child.identifier}.`);
  }

  if (!Array.isArray(parsed?.tests) || parsed.tests.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Structured worker result missing required field 'tests' for ${child.identifier}.`);
  }

  if (!["done", "review", "fatal"].includes(parsed.outcome)) {
    throw new Error(`Structured worker result has invalid outcome '${parsed.outcome}' for ${child.identifier}.`);
  }

  if (parsed.issueKey !== child.identifier) {
    throw new Error(`Structured worker result issue key mismatch for ${child.identifier}.`);
  }

  if (parsed.issueTitle !== child.title) {
    throw new Error(`Structured worker result issue title mismatch for ${child.identifier}.`);
  }

  if (["review", "fatal"].includes(parsed.outcome)) {
    if (typeof parsed.requiredHumanAction !== "string" || parsed.requiredHumanAction.trim() === "") {
      throw new Error(`Structured worker result missing requiredHumanAction for ${child.identifier} ${parsed.outcome} outcome.`);
    }

    if (
      !Array.isArray(parsed.recoveryNotes) ||
      parsed.recoveryNotes.length === 0 ||
      parsed.recoveryNotes.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
      throw new Error(`Structured worker result missing recoveryNotes for ${child.identifier} ${parsed.outcome} outcome.`);
    }
  }

  return parsed;
}

export function summarizeRemainingChildren(classification) {
  return Object.entries(classification?.reasonSummary ?? {}).reduce((summary, [reason, issueKeys]) => {
    if (reason === "done") return summary;
    summary[reason] = issueKeys;
    return summary;
  }, {});
}

export function selectNextRunnableChild(queue) {
  const classification = classifyChildIssues(queue?.children ?? []);
  const child = classification.runnable[0];

  if (!child) {
    const remainingByReason = summarizeRemainingChildren(classification);
    const suffix = Object.keys(remainingByReason).length ? ` Remaining children: ${JSON.stringify(remainingByReason)}.` : "";
    throw new Error(
      `/crosby found no runnable child issues under ${queue?.parent?.identifier ?? "the supplied parent"}.${suffix}`,
    );
  }

  return {
    child,
    classification,
  };
}

export async function runSingleChildExecution(queue, operations) {
  const { child, classification } = selectNextRunnableChild(queue);

  try {
    await operations.moveIssue(child.identifier, "Building");
  } catch (error) {
    if (typeof operations.refreshQueue === "function") {
      const refreshedQueue = await operations.refreshQueue(queue.parent.identifier);
      const refreshedChild = (refreshedQueue?.children ?? []).find((entry) => entry?.identifier === child.identifier);
      if (refreshedChild?.state?.name === "Building") {
        throw buildConcurrentSupervisorError(refreshedQueue);
      }
    }

    throw new Error(
      `Failed to move child issue ${child.identifier} to Building. Recovery: inspect the child state in Linear, then rerun /crosby ${queue.parent.identifier}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const movedParentToBuilding = queue?.parent?.state?.name !== "Building";
  if (movedParentToBuilding) {
    try {
      await operations.moveIssue(queue.parent.identifier, "Building");
    } catch (error) {
      throw new Error(
        `Failed to move parent issue ${queue.parent.identifier} to Building after claiming ${child.identifier}. Recovery: fix the parent workflow state in Linear before worker launch, then rerun /crosby ${queue.parent.identifier}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const workerPrompt = buildRalphLoopPrompt(child.identifier);
  const rawWorkerResult = await operations.runWorker({
    parentIssueKey: queue.parent.identifier,
    childIssueKey: child.identifier,
    prompt: workerPrompt,
  });
  const workerResult = parseStructuredWorkerResult(rawWorkerResult, child);

  if (workerResult.outcome === "done") {
    await operations.moveIssue(child.identifier, "Done");
  }

  if (workerResult.outcome === "review") {
    await operations.moveIssue(child.identifier, "Review");
  }

  return {
    child,
    classification,
    movedParentToBuilding,
    workerPrompt,
    workerResult,
  };
}

export async function runQueueExecution(initialQueue, operations) {
  const completedChildren = [];
  let queue = initialQueue;
  let movedParentToBuilding = false;

  while (true) {
    assertNoConcurrentSupervisor(queue);
    const classification = classifyChildIssues(queue?.children ?? []);
    if (classification.runnable.length === 0) {
      return {
        parent: queue.parent,
        completedChildren,
        movedParentToBuilding,
        finalClassification: classification,
        remainingByReason: summarizeRemainingChildren(classification),
      };
    }

    const execution = await runSingleChildExecution(queue, {
      moveIssue: operations.moveIssue,
      runWorker: operations.runWorker,
      refreshQueue: operations.refreshQueue,
    });
    completedChildren.push(execution);
    movedParentToBuilding ||= execution.movedParentToBuilding;

    if (execution.workerResult.outcome === "fatal") {
      return {
        parent: queue.parent,
        completedChildren,
        movedParentToBuilding,
        finalClassification: classification,
        remainingByReason: summarizeRemainingChildren(classification),
      };
    }

    await reportChildOutcomeToParent(queue, execution, operations.addComment);
    queue = await operations.refreshQueue(queue.parent.identifier);
    await finalizeParentIfComplete(queue, completedChildren, operations);
  }
}

export async function fetchParentQueue(issueKey, loadIssue) {
  const issue = await loadIssue(issueKey);
  return loadParentQueueFromIssue(issue);
}

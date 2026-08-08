export class TaskListError extends Error {
  constructor(message) {
    super(`${message} Recovery: fix the build tasks.md input and rerun Crosby.`);
    this.name = "TaskListError";
  }
}

function fail(message) {
  throw new TaskListError(message);
}

function required(value, field) {
  const result = String(value ?? "").trim();
  if (!result) fail(`${field} must be provided.`);
  return result;
}

function unquote(value) {
  return String(value ?? "").trim().replace(/^`|`$/g, "");
}

function section(taskText, name) {
  const heading = new RegExp(`^### ${name}\\s*$`, "im").exec(taskText);
  if (!heading) return "";
  const start = heading.index + heading[0].length;
  const remainder = taskText.slice(start);
  const nextHeading = /^### /im.exec(remainder);
  return remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
}

function metadata(taskText, name) {
  const match = taskText.match(new RegExp(`^\\s*(?:-\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function listItems(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map(unquote);
}

function dependencies(taskText, taskId) {
  const value = metadata(taskText, "Dependencies");
  if (!value) fail(`${taskId} is missing Dependencies.`);
  if (/^none$/i.test(value)) return [];
  const result = value.split(",").map((item) => required(item, `${taskId} dependency`));
  if (result.some((item) => !/^task-\d+$/i.test(item))) fail(`${taskId} has an invalid dependency ID.`);
  return result;
}

function fileScope(taskText, taskId) {
  const execution = section(taskText, "Crosby execution");
  const scopeStart = execution.match(/^\s*-\s*File scope:\s*$/im);
  if (!scopeStart) fail(`${taskId} is missing File scope.`);
  const after = execution.slice(scopeStart.index + scopeStart[0].length);
  const untilNext = after.split(/^\s*-\s*(?:Verification|Parallel):/im)[0];
  const paths = listItems(untilNext);
  if (!paths.length) fail(`${taskId} must declare at least one file-scope path.`);
  for (const pathname of paths) {
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})|(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:\.|\*)$/.test(pathname)) {
      fail(`${taskId} has an unsafe file-scope path '${pathname}'.`);
    }
    if (/\0|[\r\n]/.test(pathname)) fail(`${taskId} has an invalid file-scope path.`);
  }
  return paths;
}

function verification(taskText, taskId) {
  const execution = section(taskText, "Crosby execution");
  const verificationStart = execution.match(/^\s*-\s*Verification:\s*$/im);
  if (!verificationStart) fail(`${taskId} is missing Verification.`);
  const commands = listItems(execution.slice(verificationStart.index + verificationStart[0].length));
  if (!commands.length) fail(`${taskId} must declare a verification command or none.`);
  if (commands.some((command) => /[\r\n\0]/.test(command))) fail(`${taskId} has invalid verification text.`);
  if (commands.length > 1 && commands.some((command) => /^none$/i.test(command))) fail(`${taskId} cannot mix none with verification commands.`);
  return commands;
}

function parseTask(block, index) {
  const heading = block.match(/^##\s+(task-\d+)\s+—\s+(.+)\s*$/im);
  if (!heading) fail(`Task ${index + 1} has an invalid heading; expected '## task-NNN — title'.`);
  const id = heading[1];
  const title = required(heading[2], `${id} title`);
  const outcome = required(metadata(block, "Outcome"), `${id} Outcome`);
  const executionMode = (metadata(block, "Execution mode") || "AFK").toUpperCase();
  if (executionMode !== "AFK" && executionMode !== "HITL") fail(`${id} Execution mode must be AFK or HITL.`);
  const acceptanceCriteria = listItems(section(block, "Acceptance criteria"));
  if (!acceptanceCriteria.length) fail(`${id} must declare acceptance criteria.`);
  const execution = section(block, "Crosby execution");
  if (!execution) fail(`${id} is missing Crosby execution.`);
  const parallel = metadata(execution, "Parallel").toLowerCase();
  if (parallel !== "sequential" && parallel !== "allowed") fail(`${id} Parallel must be sequential or allowed.`);
  const instructions = section(block, "Instructions") || outcome;
  const guardrails = section(block, "Guardrails");
  if (!guardrails) fail(`${id} must declare Guardrails.`);
  return {
    id,
    title,
    dependencies: dependencies(block, id),
    outcome,
    executionMode,
    acceptanceCriteria,
    parallel,
    fileScope: fileScope(block, id),
    verification: verification(block, id),
    instructions,
    guardrails,
    modelHint: metadata(block, "Model hint") || null,
    thinkingHint: metadata(block, "Thinking") || metadata(block, "Thinking hint") || null,
    order: index,
  };
}

export function parseBuildTaskList(markdown) {
  const source = required(markdown, "tasks.md");
  const build = source.match(/^#\s+Build:\s*(\S+)\s*$/im);
  if (!build) fail("tasks.md must declare '# Build: <build-id>'.");
  const parentBranchMatch = source.match(/^\*\*Parent branch\*\*:\s*(.+)$/im);
  const parentBranch = unquote(required(parentBranchMatch?.[1], "Parent branch"));
  const blocks = source.split(/^##\s+/m).slice(1).map((block) => `## ${block.trim()}`).filter((block) => /^##\s+task-\d+\s+—/i.test(block));
  if (!blocks.length) fail("tasks.md must contain at least one task.");
  const tasks = blocks.map(parseTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) fail(`Duplicate task ID '${task.id}'.`);
    ids.add(task.id);
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) fail(`${task.id} depends on ${dependency}, which must appear earlier in the task list.`);
    }
  }
  return { buildId: build[1], parentBranch, tasks };
}

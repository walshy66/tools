import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchParentQueue, parseSingleIssueKeyArg, runQueueExecution } from "./lib.mjs";

async function loadIssueFromLinear(pi: ExtensionAPI, issueKey: string) {
  const result = await pi.exec("linear", ["issue", "view", issueKey, "--json"]);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to load ${issueKey} from Linear. ${details}`
        : `Failed to load ${issueKey} from Linear. Check Linear CLI authentication and try again.`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse Linear queue data for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function moveIssue(pi: ExtensionAPI, issueKey: string, state: string) {
  const result = await pi.exec("linear", ["issue", "move", issueKey, state]);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to move ${issueKey} to ${state}. ${details}`
        : `Failed to move ${issueKey} to ${state}. Check Linear CLI authentication and try again.`,
    );
  }
}

async function addIssueComment(pi: ExtensionAPI, issueKey: string, body: string) {
  const result = await pi.exec("linear", ["issue", "comment", "add", issueKey, body]);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to add comment to ${issueKey}. ${details}`
        : `Failed to add comment to ${issueKey}. Check Linear CLI authentication and try again.`,
    );
  }
}

function getPiInvocation() {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }

  return { command: "pi", args: [] };
}

async function runIsolatedWorker(pi: ExtensionAPI, prompt: string) {
  const invocation = getPiInvocation();
  const result = await pi.exec(invocation.command, [...invocation.args, "--mode", "text", "-p", "--no-session", prompt]);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Isolated worker failed. ${details}`
        : "Isolated worker failed before returning output.",
    );
  }

  return result;
}

export default function crosbyExtension(pi: ExtensionAPI) {
  pi.registerCommand("crosby", {
    description: "Validate a parent Linear issue, claim one runnable child, and launch an isolated worker", 
    handler: async (args, ctx) => {
      try {
        const issueKey = parseSingleIssueKeyArg(args);
        const queue = await fetchParentQueue(issueKey, (key) => loadIssueFromLinear(pi, key));
        const execution = await runQueueExecution(queue, {
          moveIssue: (targetIssueKey, state) => moveIssue(pi, targetIssueKey, state),
          addComment: (targetIssueKey, body) => addIssueComment(pi, targetIssueKey, body),
          runWorker: ({ prompt }) => runIsolatedWorker(pi, prompt),
          refreshQueue: (parentIssueKey) => fetchParentQueue(parentIssueKey, (key) => loadIssueFromLinear(pi, key)),
        });

        pi.appendEntry("crosby-queue-loaded", {
          issueKey,
          parentTitle: queue.parent.title,
          childCount: queue.children.length,
          childKeys: queue.children.map((child) => child.identifier),
          completedChildKeys: execution.completedChildren.map((entry) => entry.child.identifier),
          completedChildOutcomes: execution.completedChildren.map((entry) => ({
            issueKey: entry.child.identifier,
            outcome: entry.workerResult.outcome,
          })),
          movedParentToBuilding: execution.movedParentToBuilding,
          remainingByReason: execution.remainingByReason,
          loadedAt: new Date().toISOString(),
        });

        const lastExecution = execution.completedChildren.at(-1);
        const parentTransition = execution.movedParentToBuilding ? ` Parent ${queue.parent.identifier} moved to Building.` : "";
        const remaining = Object.keys(execution.remainingByReason).length
          ? ` Remaining: ${JSON.stringify(execution.remainingByReason)}.`
          : "";
        const message =
          !lastExecution
            ? `No runnable child issues remain under ${queue.parent.identifier}.${remaining}`
            : lastExecution.workerResult.outcome === "fatal"
              ? `${lastExecution.child.identifier} returned fatal outcome after ${execution.completedChildren.length} child run(s). Recovery: ${lastExecution.workerResult.recoveryNotes.join(" ")}.${parentTransition}`
              : `Processed ${execution.completedChildren.length} child issue(s) under ${queue.parent.identifier}.${parentTransition}${remaining}`;
        ctx.ui.notify(message, lastExecution?.workerResult.outcome === "fatal" ? "error" : "success");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

import os from "node:os";
import path from "node:path";
import { createGitHubClient } from "./github-client.mjs";
import { writeGitHubBuild } from "./github-build.mjs";
import { buildGitHubChildProgress, buildGitHubParentSummary } from "./github-reporting.mjs";

export async function runGitHubParent({ issueRef, exec, repository, runBuild, buildOptions = {}, onTaskIntegrated } = {}) {
  if (typeof runBuild !== "function") throw new Error("GitHub Crosby requires the durable build runner.");
  const client = createGitHubClient({ exec, repository });
  const queue = await client.loadParentQueue(issueRef);
  const folder = await writeGitHubBuild(queue, path.join(os.tmpdir(), "crosby-github"));
  const result = await runBuild({
    ...buildOptions,
    buildFolder: folder,
    adapters: {
      ...(buildOptions.adapters ?? {}),
      onTaskIntegrated: async (event) => {
        const issueNumber = event.task.id.replace(/^task-0*/, "");
        await client.moveIssue(issueNumber, "Done");
        await client.addComment(issueNumber, buildGitHubChildProgress({
          child: { identifier: `#${issueNumber}` },
          outcome: event.report.outcome,
          summary: event.report.summary,
          changes: event.report.changes?.paths ?? [event.report.changes?.commit ?? "recorded in the durable worktree"],
          verification: event.report.verification?.map((entry) => `${entry.command}: ${entry.result}`),
          recoveryNotes: event.report.risks,
        }));
        await onTaskIntegrated?.({ ...event, issueNumber, queue });
      },
    },
  });
  const refreshed = await client.loadParentQueue(issueRef);
  if (refreshed.children.every((child) => child.state.name === "Done")) {
    await client.addComment(refreshed.parent.identifier, buildGitHubParentSummary({ parent: refreshed.parent, children: refreshed.children.filter((child) => child.state.name === "Done") }));
    await client.moveIssue(refreshed.parent.identifier, "Review");
  }
  return { ...result, queue: refreshed };
}

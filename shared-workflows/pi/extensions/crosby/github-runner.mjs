import os from "node:os";
import path from "node:path";
import { createGitHubClient } from "./github-client.mjs";
import { writeGitHubBuild } from "./github-build.mjs";

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
        await client.addComment(issueNumber, `Crosby completed this task. Commit: ${event.report.changes?.commit ?? "recorded in the durable worktree"}.`);
        await onTaskIntegrated?.({ ...event, issueNumber, queue });
      },
    },
  });
  const refreshed = await client.loadParentQueue(issueRef);
  if (refreshed.children.every((child) => child.state.name === "Done")) {
    await client.addComment(refreshed.parent.identifier, `Crosby completed all child tasks for ${refreshed.parent.title}.`);
    await client.moveIssue(refreshed.parent.identifier, "Review");
  }
  return { ...result, queue: refreshed };
}

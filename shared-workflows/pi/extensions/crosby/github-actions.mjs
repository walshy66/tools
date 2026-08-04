export function parseGitHubCommand(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0] === "--watch") return { mode: "watch" };
  if (tokens.length === 2 && ["push", "review"].includes(tokens[0].toLowerCase())) return { mode: tokens[0].toLowerCase(), issueRef: tokens[1] };
  if (tokens.length === 1 && (/^#?\d+$/.test(tokens[0]) || /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/i.test(tokens[0]))) return { mode: "parent", issueRef: tokens[0] };
  return null;
}

export async function runGitHubWatch({ client, runParent, pollIntervalMs = 60000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal } = {}) {
  if (!client || typeof client.loadExecuteParentQueues !== "function") throw new Error("GitHub watch requires a GitHub client.");
  if (typeof runParent !== "function") throw new Error("GitHub watch requires a parent runner.");
  const cycles = [];
  while (!signal?.aborted) {
    const queues = await client.loadExecuteParentQueues();
    for (const queue of queues) {
      if (queue.children.some((child) => child.state.name === "Building")) continue;
      cycles.push(await runParent(queue.parent.identifier));
    }
    if (signal?.aborted) break;
    await sleep(pollIntervalMs);
  }
  return cycles;
}

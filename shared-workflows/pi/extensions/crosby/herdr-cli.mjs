function herdrResult(payload, operation) {
  if (payload?.error) throw new Error(payload.error.message ?? `Herdr ${operation} failed.`);
  if (!payload?.result || typeof payload.result !== "object") throw new Error(`Herdr ${operation} returned no result.`);
  return payload.result;
}

function argumentsFor(operation, input) {
  switch (operation) {
    case "snapshot":
      return ["api", "snapshot"];
    case "createTab":
      return ["tab", "create", "--workspace", input.workspace, "--label", input.label, "--cwd", input.cwd, ...(input.focus ? ["--focus"] : ["--no-focus"]), ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
    case "closeTab":
      return ["tab", "close", input.tab];
    case "startAgent":
      return ["agent", "start", input.name, "--kind", "pi", "--pane", input.pane, ...(input.agentArgs?.length ? ["--", ...input.agentArgs] : [])];
    case "promptAgent":
      return ["agent", "prompt", input.agent, input.prompt, ...(input.wait ? ["--wait"] : [])];
    case "waitForAgent":
      return ["agent", "wait", input.agent, ...input.until.flatMap((state) => ["--until", state]), ...(input.timeout ? ["--timeout", String(input.timeout)] : [])];
    case "readAgent":
      return ["agent", "read", input.agent, "--source", input.source ?? "recent-unwrapped", ...(input.lines ? ["--lines", String(input.lines)] : [])];
    case "renameAgent":
      return ["agent", "rename", input.agent, input.name];
    case "inspectAgent":
      return ["agent", "get", input.agent];
    default:
      throw new Error(`Unsupported Herdr operation '${operation}'.`);
  }
}

export function createHerdrCliInvoker({ exec } = {}) {
  if (typeof exec !== "function") throw new Error("Herdr CLI invoker requires an exec(command, args) function.");

  return async function invokeHerdrCli(operation, input) {
    const args = argumentsFor(operation, input);
    const result = await exec("herdr", args);
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    if (result.code !== 0) throw new Error(details || `Herdr ${operation} failed with exit code ${result.code}.`);

    if (operation === "readAgent") return { text: String(result.stdout ?? "") };

    let raw;
    try {
      raw = herdrResult(JSON.parse(result.stdout), operation);
    } catch (error) {
      throw new Error(`Could not parse Herdr ${operation} response: ${error instanceof Error ? error.message : String(error)}`);
    }
    const agent = raw.agent ?? raw;

    switch (operation) {
      case "snapshot":
        return raw.snapshot;
      case "createTab":
        return { workspace: raw.workspace ?? raw.workspace_id, tab: raw.tab ?? raw.tab_id, pane: raw.pane ?? raw.pane_id };
      case "closeTab":
        return { tab: raw.tab ?? raw.tab_id ?? input.tab };
      case "startAgent":
        return { name: agent.name ?? agent.agent, pane: agent.pane ?? agent.pane_id, state: agent.state ?? agent.agent_status };
      case "promptAgent":
      case "waitForAgent":
      case "renameAgent":
      case "inspectAgent":
        return { ...agent, name: agent.name ?? agent.agent, state: agent.state ?? agent.agent_status };
      default:
        return raw;
    }
  };
}

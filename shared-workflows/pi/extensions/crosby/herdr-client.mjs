const AGENT_STATES = new Set(["working", "idle", "blocked", "done", "unknown"]);

export class HerdrClientError extends Error {
  constructor(message) {
    super(`${message} Recovery: verify Herdr is running and retry the worker operation; inspect the Herdr tab manually if the problem persists.`);
    this.name = "HerdrClientError";
  }
}

function fail(message) {
  throw new HerdrClientError(message);
}

function text(value, name) {
  const result = String(value ?? "").trim();
  if (!result) fail(`${name} must be a non-empty string.`);
  return result;
}

function object(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Herdr ${operation} returned a malformed response object.`);
  }
  return value;
}

function agentState(value, operation) {
  const state = text(value, `Herdr ${operation} response state`);
  if (!AGENT_STATES.has(state)) fail(`Herdr ${operation} returned unknown agent state '${state}'.`);
  return state;
}

function responseWithState(value, operation) {
  const response = object(value, operation);
  return { ...response, state: agentState(response.state, operation) };
}

export function createHerdrClient({ invoke } = {}) {
  if (typeof invoke !== "function") fail("Herdr client requires an invoke(operation, input) function.");

  async function call(operation, input) {
    try {
      return await invoke(operation, input);
    } catch (error) {
      if (error instanceof HerdrClientError) throw error;
      const detail = error instanceof Error ? error.message : String(error ?? "unknown error");
      fail(`Herdr ${operation} failed: ${detail}`);
    }
  }

  return {
    async snapshot() {
      return object(await call("snapshot", {}), "snapshot");
    },

    async createTaskTab({ workspace, label, cwd, focus = false, env } = {}) {
      const input = {
        workspace: text(workspace, "workspace"),
        label: text(label, "label"),
        cwd: text(cwd, "cwd"),
        focus: focus === true,
      };
      if (env !== undefined) {
        if (!env || typeof env !== "object" || Array.isArray(env)) fail("env must be an object of environment variables.");
        input.env = Object.fromEntries(
          Object.entries(env).map(([key, value]) => {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail(`env key '${key}' is invalid.`);
            const normalized = text(value, `env ${key}`);
            if (/[\r\n\0]/.test(normalized)) fail(`env ${key} must not contain control characters.`);
            return [key, normalized];
          }),
        );
      }
      const response = object(await call("createTab", input), "createTab");
      return {
        workspace: text(response.workspace, "Herdr createTab response workspace"),
        tab: text(response.tab, "Herdr createTab response tab"),
        pane: text(response.pane, "Herdr createTab response pane"),
      };
    },

    async closeTaskTab({ tab } = {}) {
      const response = object(await call("closeTab", { tab: text(tab, "tab") }), "closeTab");
      return { tab: text(response.tab, "Herdr closeTab response tab") };
    },

    async startPiAgent({ pane, name, agentArgs } = {}) {
      const input = { pane: text(pane, "pane"), kind: "pi" };
      if (name !== undefined) input.name = text(name, "name");
      if (agentArgs !== undefined) {
        if (!Array.isArray(agentArgs) || agentArgs.some((argument) => typeof argument !== "string")) {
          fail("agentArgs must be an array of strings.");
        }
        input.agentArgs = [...agentArgs];
      }
      const response = responseWithState(await call("startAgent", input), "startAgent");
      return {
        ...response,
        name: text(response.name, "Herdr startAgent response name"),
        pane: text(response.pane, "Herdr startAgent response pane"),
      };
    },

    async promptAgent({ agent, prompt, wait = false } = {}) {
      const response = await call("promptAgent", {
        agent: text(agent, "agent"),
        prompt: text(prompt, "prompt"),
        wait: wait === true,
      });
      return responseWithState(response, "promptAgent");
    },

    async waitForAgent({ agent, until, timeout } = {}) {
      const states = Array.isArray(until) && until.length ? until : ["idle", "done", "blocked"];
      if (states.some((state) => typeof state !== "string" || !AGENT_STATES.has(state))) {
        fail("until must contain known Herdr agent lifecycle states.");
      }
      const input = { agent: text(agent, "agent"), until: [...states] };
      if (timeout !== undefined) {
        if (!Number.isInteger(timeout) || timeout < 1) fail("timeout must be a positive integer.");
        input.timeout = timeout;
      }
      return responseWithState(await call("waitForAgent", input), "waitForAgent");
    },

    async readAgent({ agent, lines, source = "recent-unwrapped" } = {}) {
      if (!["visible", "recent", "recent-unwrapped", "detection"].includes(source)) {
        fail("source must be a supported Herdr read source.");
      }
      const input = { agent: text(agent, "agent"), source };
      if (lines !== undefined) {
        if (!Number.isInteger(lines) || lines < 1) fail("lines must be a positive integer.");
        input.lines = lines;
      }
      const response = object(await call("readAgent", input), "readAgent");
      if (typeof response.text !== "string") fail("Herdr readAgent returned a response without text output.");
      return response;
    },

    async renameAgent({ agent, name } = {}) {
      const response = responseWithState(await call("renameAgent", {
        agent: text(agent, "agent"),
        name: text(name, "name"),
      }), "renameAgent");
      return { ...response, name: text(response.name, "Herdr renameAgent response name") };
    },

    async sendAgentKeys({ agent, keys } = {}) {
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string" || !key.trim())) {
        fail("keys must be a non-empty array of strings.");
      }
      return responseWithState(await call("sendAgentKeys", { agent: text(agent, "agent"), keys: [...keys] }), "sendAgentKeys");
    },

    async stopAgent({ agent } = {}) {
      return responseWithState(await call("stopAgent", { agent: text(agent, "agent") }), "stopAgent");
    },

    async inspectAgent({ agent } = {}) {
      const response = responseWithState(await call("inspectAgent", { agent: text(agent, "agent") }), "inspectAgent");
      return { ...response, name: text(response.name, "Herdr inspectAgent response name") };
    },
  };
}

export { AGENT_STATES };

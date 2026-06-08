import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type FlyRunResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

const FLY_CANDIDATES = ["fly", "flyctl", "fly.exe", "flyctl.exe"] as const;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;

function isMissingCommandError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ENOENT|not found|is not recognized|cannot find the file specified/i.test(message);
}

function combineOutput(stdout: string, stderr: string): string {
  const parts = [] as string[];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.join("\n\n") || "(no output)";
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runFly(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<FlyRunResult> {
  let lastError: unknown;

  for (const command of FLY_CANDIDATES) {
    try {
      const result = await pi.exec(command, args, { signal, timeout: DEFAULT_TIMEOUT });
      return {
        command,
        args,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
        killed: result.killed ?? false,
      };
    } catch (error) {
      lastError = error;
      if (!isMissingCommandError(error)) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not find fly or flyctl on PATH.");
}

function resultText(result: FlyRunResult): string {
  return [
    `command: ${commandLine(result.command, result.args)}`,
    `code: ${result.code}`,
    `killed: ${result.killed}`,
    combineOutput(result.stdout, result.stderr),
  ].join("\n");
}

function addAppFlag(args: string[], app?: string) {
  if (app?.trim()) {
    args.push("-a", app.trim());
  }
}

function addOptionalFlag(args: string[], flag: string, value?: string | number | boolean) {
  if (value === undefined || value === null) return;
  if (typeof value === "boolean") {
    if (value) args.push(flag);
    return;
  }
  const trimmed = String(value).trim();
  if (!trimmed) return;
  args.push(flag, trimmed);
}

function parseFlyArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) args.push(current);
  return args;
}

function commandToArgs(command: string, args: string): string[] {
  const parsed = parseFlyArgs(args);
  return command ? [command, ...parsed] : parsed;
}

const appOptionalSchema = Type.Object({
  app: Type.Optional(Type.String({ description: "Fly app name" })),
});

const appRequiredSchema = Type.Object({
  app: Type.String({ minLength: 1, description: "Fly app name" }),
});

const deploySchema = Type.Object({
  app: Type.Optional(Type.String({ description: "Fly app name" })),
  image: Type.Optional(Type.String({ description: "Deploy a prebuilt image" })),
  config: Type.Optional(Type.String({ description: "Path to fly.toml" })),
  remoteOnly: Type.Optional(Type.Boolean({ description: "Skip local build and deploy remotely" })),
  detach: Type.Optional(Type.Boolean({ description: "Do not wait for deployment to finish" })),
  buildOnly: Type.Optional(Type.Boolean({ description: "Build only, do not deploy" })),
  strategy: Type.Optional(Type.String({ description: "Deployment strategy" })),
  extraArgs: Type.Optional(Type.Array(Type.String({ description: "Additional raw flyctl deploy args" }))),
});

const logsSchema = Type.Object({
  app: Type.String({ minLength: 1, description: "Fly app name" }),
  region: Type.Optional(Type.String({ description: "Filter logs by region" })),
  machine: Type.Optional(Type.String({ description: "Filter by machine ID" })),
  json: Type.Optional(Type.Boolean({ description: "JSON output" })),
  noTail: Type.Optional(Type.Boolean({ description: "Do not continually stream logs" })),
});

const secretsSchema = Type.Object({
  app: Type.String({ minLength: 1, description: "Fly app name" }),
  secrets: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      value: Type.String({ minLength: 1 }),
    }),
    { minItems: 1 },
  ),
});

const machinesSchema = Type.Object({
  app: Type.String({ minLength: 1, description: "Fly app name" }),
});

const machineActionSchema = Type.Object({
  app: Type.String({ minLength: 1, description: "Fly app name" }),
  machineId: Type.String({ minLength: 1, description: "Fly machine id" }),
});

async function executeFlyTool(pi: ExtensionAPI, args: string[], signal?: AbortSignal) {
  const result = await runFly(pi, args, signal);
  return {
    content: [{ type: "text" as const, text: resultText(result) }],
    details: result,
  };
}

function registerFlyCommand(pi: ExtensionAPI, name: string, description: string, command: string) {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      const flyArgs = commandToArgs(command, args);
      const result = await runFly(pi, flyArgs);
      ctx.ui.notify(resultText(result), result.code === 0 ? "info" : "error");
    },
  });
}

export default function registerFlyExtension(pi: ExtensionAPI) {
  registerFlyCommand(pi, "fly", "Run an arbitrary flyctl command", "");
  registerFlyCommand(pi, "fly-version", "Show the installed Fly CLI version", "version");
  registerFlyCommand(pi, "fly-auth-whoami", "Show the currently authenticated Fly identity", "auth whoami");
  registerFlyCommand(pi, "fly-apps-list", "List Fly apps", "apps list");
  registerFlyCommand(pi, "fly-app-info", "Show Fly app status and metadata", "status");
  registerFlyCommand(pi, "fly-status", "Show the current Fly app status", "status");
  registerFlyCommand(pi, "fly-logs", "Fetch logs for a Fly app", "logs");
  registerFlyCommand(pi, "fly-deploy", "Deploy a Fly app", "deploy");
  registerFlyCommand(pi, "fly-secrets-set", "Set Fly app secrets", "secrets set");
  registerFlyCommand(pi, "fly-secrets-list", "List Fly app secrets", "secrets list");
  registerFlyCommand(pi, "fly-machines-list", "List Fly Machines", "machines list");
  registerFlyCommand(pi, "fly-machines-restart", "Restart a Fly machine", "machines restart");
  registerFlyCommand(pi, "fly-machines-stop", "Stop a Fly machine", "machines stop");
  registerFlyCommand(pi, "fly-machines-destroy", "Destroy a Fly machine", "machines destroy");

  pi.registerTool({
    name: "fly_version",
    label: "Fly Version",
    description: "Show the installed Fly CLI version.",
    promptSnippet: "Check the installed Fly CLI version.",
    promptGuidelines: ["Use fly_version when you need to verify the local Fly CLI install."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return executeFlyTool(pi, ["version"], signal);
    },
  });

  pi.registerTool({
    name: "fly_auth_whoami",
    label: "Fly Auth Whoami",
    description: "Show the currently authenticated Fly user or service identity.",
    promptSnippet: "Check which Fly account is authenticated.",
    promptGuidelines: ["Use fly_auth_whoami when you need to verify Fly login state."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return executeFlyTool(pi, ["auth", "whoami"], signal);
    },
  });

  pi.registerTool({
    name: "fly_apps_list",
    label: "Fly Apps List",
    description: "List Fly apps, optionally scoped to an organization.",
    promptSnippet: "List Fly apps.",
    promptGuidelines: ["Use fly_apps_list when you need to find existing Fly apps."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return executeFlyTool(pi, ["apps", "list"], signal);
    },
  });

  pi.registerTool({
    name: "fly_app_info",
    label: "Fly App Info",
    description: "Show Fly app status and metadata.",
    promptSnippet: "Inspect a Fly app.",
    promptGuidelines: ["Use fly_app_info when you need app-level status or metadata."],
    parameters: appRequiredSchema,
    async execute(_toolCallId, params, signal) {
      return executeFlyTool(pi, ["status", "-a", params.app], signal);
    },
  });

  pi.registerTool({
    name: "fly_status",
    label: "Fly Status",
    description: "Show the current Fly app status.",
    promptSnippet: "Show Fly app status.",
    promptGuidelines: ["Use fly_status when you need deployment/runtime status for an app."],
    parameters: appOptionalSchema,
    async execute(_toolCallId, params, signal) {
      const args = ["status"];
      if (params.app) addAppFlag(args, params.app);
      return executeFlyTool(pi, args, signal);
    },
  });

  pi.registerTool({
    name: "fly_logs",
    label: "Fly Logs",
    description: "Stream or fetch logs for a Fly app.",
    promptSnippet: "Fetch Fly logs.",
    promptGuidelines: ["Use fly_logs when you need recent logs from a Fly app."],
    parameters: logsSchema,
    async execute(_toolCallId, params, signal) {
      const args = ["logs", "-a", params.app];
      addOptionalFlag(args, "--region", params.region);
      addOptionalFlag(args, "--machine", params.machine);
      addOptionalFlag(args, "--json", params.json);
      addOptionalFlag(args, "--no-tail", params.noTail);
      return executeFlyTool(pi, args, signal);
    },
  });

  pi.registerTool({
    name: "fly_deploy",
    label: "Fly Deploy",
    description: "Deploy a Fly app using flyctl.",
    promptSnippet: "Deploy a Fly app.",
    promptGuidelines: ["Use fly_deploy when you need to deploy or rebuild a Fly app."],
    parameters: deploySchema,
    async execute(_toolCallId, params, signal) {
      const args = ["deploy"];
      if (params.app) addAppFlag(args, params.app);
      addOptionalFlag(args, "--image", params.image);
      addOptionalFlag(args, "--config", params.config);
      addOptionalFlag(args, "--remote-only", params.remoteOnly);
      addOptionalFlag(args, "--detach", params.detach);
      addOptionalFlag(args, "--build-only", params.buildOnly);
      addOptionalFlag(args, "--strategy", params.strategy);
      if (params.extraArgs?.length) args.push(...params.extraArgs.filter((part) => part.trim()));
      return executeFlyTool(pi, args, signal);
    },
  });

  pi.registerTool({
    name: "fly_secrets_set",
    label: "Fly Secrets Set",
    description: "Set one or more Fly app secrets.",
    promptSnippet: "Set Fly secrets.",
    promptGuidelines: ["Use fly_secrets_set when you need to store app secrets in Fly."],
    parameters: secretsSchema,
    async execute(_toolCallId, params, signal) {
      const args = ["secrets", "set", ...params.secrets.map((secret) => `${secret.name}=${secret.value}`), "-a", params.app];
      return executeFlyTool(pi, args, signal);
    },
  });

  pi.registerTool({
    name: "fly_secrets_list",
    label: "Fly Secrets List",
    description: "List secrets configured on a Fly app.",
    promptSnippet: "List Fly app secrets.",
    promptGuidelines: ["Use fly_secrets_list when you need to inspect which secrets exist on an app."],
    parameters: appRequiredSchema,
    async execute(_toolCallId, params, signal) {
      return executeFlyTool(pi, ["secrets", "list", "-a", params.app], signal);
    },
  });

  pi.registerTool({
    name: "fly_machines_list",
    label: "Fly Machines List",
    description: "List Machines for a Fly app.",
    promptSnippet: "List Fly Machines.",
    promptGuidelines: ["Use fly_machines_list when you need to inspect the machines for an app."],
    parameters: machinesSchema,
    async execute(_toolCallId, params, signal) {
      return executeFlyTool(pi, ["machines", "list", "-a", params.app], signal);
    },
  });

  pi.registerTool({
    name: "fly_machines_restart",
    label: "Fly Machines Restart",
    description: "Restart a specific Fly machine.",
    promptSnippet: "Restart a Fly Machine.",
    promptGuidelines: ["Use fly_machines_restart when you need to restart a specific machine."],
    parameters: machineActionSchema,
    async execute(_toolCallId, params, signal) {
      return executeFlyTool(pi, ["machines", "restart", params.machineId, "-a", params.app], signal);
    },
  });

  pi.registerTool({
    name: "fly_machines_stop",
    label: "Fly Machines Stop",
    description: "Stop a specific Fly machine.",
    promptSnippet: "Stop a Fly Machine.",
    promptGuidelines: ["Use fly_machines_stop when you need to stop a specific machine."],
    parameters: machineActionSchema,
    async execute(_toolCallId, params, signal) {
      return executeFlyTool(pi, ["machines", "stop", params.machineId, "-a", params.app], signal);
    },
  });

  pi.registerTool({
    name: "fly_machines_destroy",
    label: "Fly Machines Destroy",
    description: "Destroy a specific Fly machine after confirmation.",
    promptSnippet: "Destroy a Fly Machine.",
    promptGuidelines: ["Use fly_machines_destroy only after the user explicitly confirms they want to delete the machine."],
    parameters: machineActionSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const confirmed = await ctx.ui.confirm(
        "Destroy Fly machine?",
        `This will permanently destroy machine ${params.machineId} in app ${params.app}. Continue?`,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text" as const, text: "Cancelled." }],
          details: { cancelled: true },
        };
      }
      return executeFlyTool(pi, ["machines", "destroy", params.machineId, "-a", params.app], signal);
    },
  });
}

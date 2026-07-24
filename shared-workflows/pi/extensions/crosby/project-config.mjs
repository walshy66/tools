export const PROJECT_CONFIG_PATH = ".pi/crosby.json";
export const PROJECT_CONFIG_VERSION = 1;

export class ProjectConfigError extends Error {
  constructor(message) {
    super(`${message} Recovery: create or correct ${PROJECT_CONFIG_PATH} with version ${PROJECT_CONFIG_VERSION} and ordered finalIntegrationCommands, then retry integration.`);
    this.name = "ProjectConfigError";
  }
}

function configError(message) {
  throw new ProjectConfigError(message);
}

export function validateProjectConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    configError("Project configuration must be a JSON object.");
  }

  if (config.version !== PROJECT_CONFIG_VERSION) {
    configError(`Project configuration version must be ${PROJECT_CONFIG_VERSION}.`);
  }

  const commands = config.finalIntegrationCommands;
  if (!Array.isArray(commands) || commands.length === 0) {
    configError("Project configuration finalIntegrationCommands must be a non-empty ordered array.");
  }

  if (commands.some((command) => typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command))) {
    configError("Each finalIntegrationCommands entry must be one non-empty command without newlines.");
  }

  return {
    version: PROJECT_CONFIG_VERSION,
    finalIntegrationCommands: commands.map((command) => command.trim()),
  };
}

export function parseProjectConfig(source) {
  if (source === undefined || source === null || String(source).trim() === "") {
    configError(`Project configuration ${PROJECT_CONFIG_PATH} is missing or empty.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(source));
  } catch {
    configError(`Project configuration ${PROJECT_CONFIG_PATH} contains invalid JSON.`);
  }

  return validateProjectConfig(parsed);
}

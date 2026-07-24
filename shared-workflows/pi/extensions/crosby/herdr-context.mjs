function required(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Crosby must be run from a Herdr-managed Pi pane. Recovery: start or attach Pi inside Herdr, then rerun /crosby. Missing ${name}.`);
  return result;
}

export function requireCrosbyHerdrContext(env = process.env) {
  if (env?.HERDR_ENV !== "1") {
    throw new Error("Crosby must be run from a Herdr-managed Pi pane. Recovery: start or attach Pi inside Herdr, then rerun /crosby.");
  }

  return {
    workspace: required(env.HERDR_WORKSPACE_ID, "HERDR_WORKSPACE_ID"),
    pane: required(env.HERDR_PANE_ID, "HERDR_PANE_ID"),
  };
}

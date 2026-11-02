import test from "node:test";
import assert from "node:assert/strict";
import { ProjectConfigError, parseProjectConfig, validateProjectConfig } from "./project-config.mjs";

test("validates a versioned project configuration and preserves integration command order", () => {
  const config = validateProjectConfig({
    version: 1,
    finalIntegrationCommands: ["node --test", "npm run lint"],
  });

  assert.deepEqual(config, {
    version: 1,
    finalIntegrationCommands: ["node --test", "npm run lint"],
  });
});

test("parses project configuration JSON", () => {
  assert.deepEqual(parseProjectConfig('{"version":1,"finalIntegrationCommands":["npm test"]}'), {
    version: 1,
    finalIntegrationCommands: ["npm test"],
  });
});

test("missing or malformed project configuration fails closed with recovery guidance", () => {
  assert.throws(() => parseProjectConfig(), ProjectConfigError);
  assert.throws(() => parseProjectConfig("{not json}"), /\.pi\/crosby\.json.*Recovery/i);
  assert.throws(() => validateProjectConfig({ version: 1 }), /finalIntegrationCommands.*Recovery/i);
  assert.throws(
    () => validateProjectConfig({ version: 2, finalIntegrationCommands: ["npm test"] }),
    /version.*Recovery/i,
  );
});

test("rejects unsafe or ambiguous final integration commands", () => {
  for (const commands of [[], [""], ["  "], ["npm test", 42]]) {
    assert.throws(() => validateProjectConfig({ version: 1, finalIntegrationCommands: commands }), ProjectConfigError);
  }
});

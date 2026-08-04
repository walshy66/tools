import test from "node:test";
import assert from "node:assert/strict";
import { buildModelCandidates, selectTaskModel } from "./model-selector.mjs";

const task = {
  id: "task-003",
  title: "Enforce workspace isolation",
  outcome: "Cross-workspace reads are denied server-side.",
  acceptanceCriteria: ["Repository access is workspace scoped.", "Regression tests cover denial."],
  fileScope: ["backend/src/modules/current-state"],
  verification: ["npm test"],
  guardrails: "Do not weaken backend authority.",
};

const candidates = [
  { model: "openai-codex/gpt-5.6-luna", reasoning: true, contextWindow: 272000 },
  { model: "openai-codex/gpt-5.6-sol", reasoning: true, contextWindow: 272000 },
  { model: "openai-codex/gpt-5.6-terra", reasoning: true, contextWindow: 272000 },
];

test("builds a focused candidate pool from available models on the parent provider", () => {
  const pool = buildModelCandidates({
    currentModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
    availableModels: [
      { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true, contextWindow: 272000 },
      { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 272000 },
      { provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true, contextWindow: 128000 },
      { provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true, contextWindow: 272000 },
      { provider: "openai-codex", id: "gpt-5.6-sol-20260101", reasoning: true, contextWindow: 272000 },
      { provider: "anthropic", id: "claude-sonnet-5", reasoning: true, contextWindow: 1000000 },
    ],
  });

  assert.deepEqual(pool.map((candidate) => candidate.model), [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-sol",
  ]);
});

test("asks the orchestrator to select an allowed task model and fixes thinking at medium", async () => {
  let assessmentPrompt = "";
  const selection = await selectTaskModel({
    task,
    candidates,
    assess: async (prompt) => {
      assessmentPrompt = prompt;
      return "openai-codex/gpt-5.6-terra";
    },
  });

  assert.deepEqual(selection, {
    model: "openai-codex/gpt-5.6-terra",
    thinking: "medium",
    source: "orchestrator",
  });
  assert.match(assessmentPrompt, /Enforce workspace isolation/);
  assert.match(assessmentPrompt, /openai-codex\/gpt-5\.6-luna/);
  assert.match(assessmentPrompt, /Return exactly one model identifier/);
});

test("fails closed when the orchestrator returns a model outside the allowed pool", async () => {
  await assert.rejects(
    selectTaskModel({ task, candidates, assess: async () => "openrouter/auto" }),
    /selected unavailable model 'openrouter\/auto'/,
  );
});

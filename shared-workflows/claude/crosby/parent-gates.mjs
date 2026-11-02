import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectConfig, PROJECT_CONFIG_PATH } from './project-config.mjs';
import { readRegistry, updateRegistry } from './registry.mjs';
import { runTaskGates } from './gate-runner.mjs';
import { assertStableRevision } from './gate-stage.mjs';
import { buildContractHash } from './quality-gates.mjs';

export function createParentVerifier({ herdr, stage, exec }) {
  return async ({ build, parentWorktree, store }) => {
    try {
      if (build.contractError || !build.parentReviewContext || !build.parentBrowserAcceptance) throw new Error(`Parent review contract incomplete: ${build.contractError || 'add Review Context and Browser Acceptance with explicit required/not applicable and scenario criteria to the parent issue.'}`);
      const config = parseProjectConfig(await readFile(path.join(parentWorktree.path, PROJECT_CONFIG_PATH), 'utf8'));
      if (config.finalIntegrationCommands.some((command) => command.toLowerCase() === 'none')) throw new Error('Parent finalIntegrationCommands cannot waive integration verification with none.');
      const registry = await readRegistry(store);
      let pane = registry.parentGatePane;
      if (pane && !JSON.stringify(await herdr.snapshot()).includes(JSON.stringify(pane.pane))) pane = null;
      if (!pane) {
        pane = await herdr.createTaskTab({ workspace: registry.supervisor?.workspace ?? store.spaceId, label: `Crosby #${build.buildId.replace(/^github-/, '')}`, cwd: parentWorktree.path, focus: false });
        await updateRegistry(store, (current) => ({ ...current, parentGatePane: pane }));
      }
      const task = {
        id: `parent-${build.buildId}`, title: 'Combined parent integration verification',
        outcome: 'Verify the combined delivered parent, including repository final integration commands and declared cross-issue browser journeys. Leave the parent open for the operator.',
        acceptanceCriteria: build.parentAcceptanceCriteria ?? [],
        reviewContext: build.parentReviewContext,
        browserAcceptance: build.parentBrowserAcceptance,
        verification: config.finalIntegrationCommands,
        guardrails: 'Report only. Use documented isolated environments. Parent failures must identify exact findings and assistance needed; do not mutate code or close the parent.',
        dependencies: build.tasks.map((task) => task.id),
        childContracts: build.tasks,
        reviewEnvironment: 'Follow repository instructions to prepare the completed parent for human taste/interaction review. Report its approved URL or repeatable startup instructions and ownership/shutdown details; never deploy automatically.',
      };
      const result = await runTaskGates({ task, taskWorktree: parentWorktree, worker: pane, stage, store, build });
      // Only explicit attribution to a declared buildable child can enter automatic repair.
      if (result.outcome === 'changes-required' && result.repairable === true && build.tasks.some((task) => task.id === result.repairTaskId && task.executionMode !== 'HITL')) return result;
      if (result.outcome !== 'passed') return { ...result, outcome: 'blocked', requiredHumanAction: result.requiredHumanAction || `Review parent integration findings and identify the owning child for repair: ${result.summary}` };
      await assertStableRevision(exec, parentWorktree.path, result.revision);
      return { ...result, buildContractHash: buildContractHash(build), finalIntegrationCommands: config.finalIntegrationCommands, reviewWorktree: parentWorktree.path, reviewInstructions: build.parentReviewContext };
    } catch (error) {
      const summary = error.message ?? String(error);
      return { outcome: 'blocked', summary, requiredHumanAction: `Correct the parent issue review/browser contract and ${PROJECT_CONFIG_PATH} with repository-defined finalIntegrationCommands and documented safe prerequisites. ${summary} Then run /crosby resume #${build.buildId.replace(/^github-/, '')}.` };
    }
  };
}

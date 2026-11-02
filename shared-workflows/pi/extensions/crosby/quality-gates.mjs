import { createHash } from 'node:crypto';

export function contractHash(task) {
  return createHash('sha256').update(JSON.stringify({ id: task.id, contractError: task.contractError, executionMode: task.executionMode, outcome: task.outcome, criteria: task.acceptanceCriteria, fileScope: task.fileScope, instructions: task.instructions, childContracts: task.childContracts, reviewContext: task.reviewContext, browserAcceptance: task.browserAcceptance, verification: task.verification, guardrails: task.guardrails, dependencies: task.dependencies })).digest('hex');
}

export function buildContractHash(build) {
  return createHash('sha256').update(JSON.stringify({ tasks: build.tasks.map(contractHash), parentReviewContext: build.parentReviewContext, parentBrowserAcceptance: build.parentBrowserAcceptance, parentAcceptanceCriteria: build.parentAcceptanceCriteria, contractError: build.contractError })).digest('hex');
}

export function validateGateReport(report, request) {
  if (!report || !request) throw new Error('Missing gate report/request.');
  for (const key of ['runId', 'stage', 'revision', 'contractHash']) {
    if (!request[key] || report[key] !== request[key]) throw new Error(`Gate ${key} mismatch; report is stale or belongs to another run.`);
  }
  if (!['passed', 'changes-required', 'blocked'].includes(report.outcome)) throw new Error('Invalid gate outcome.');
  if (!report.summary?.trim() || !report.reportPath?.trim()) throw new Error('Gate requires summary and durable reportPath.');
  if (report.outcome === 'blocked' && !report.requiredHumanAction?.trim()) throw new Error('Blocked gate requires a human recovery action.');
  if (report.outcome === 'passed') {
    if (report.safety !== 'confirmed') throw new Error('Gate safety prerequisites were not confirmed.');
    if (request.stage === 'review' && report.architecture !== 'passed') throw new Error('Architectural review must pass.');
    for (const command of request.commands ?? []) {
      if (!report.checks?.some((check) => check.command === command && check.result === 'passed')) throw new Error(`Missing passed verification: ${command}`);
    }
    if (request.stage === 'test') {
      for (const scenario of request.scenarios ?? []) {
        if (!report.scenarios?.some((entry) => entry.id === scenario.id && entry.result === 'passed')) throw new Error(`Missing passed browser scenario: ${scenario.id}`);
      }
      if (report.scenarios?.some((entry) => entry.result !== 'passed')) throw new Error('Browser scenarios contain unresolved failures.');
      if (!report.provenance?.trim()) throw new Error('Browser runtime provenance is required.');
      if (report.cleanup !== 'passed') throw new Error('Required browser cleanup must pass.');
    }
    if (report.checks?.some((check) => check.result !== 'passed' && check.required !== false)) throw new Error('Required checks did not pass.');
  }
  return structuredClone(report);
}

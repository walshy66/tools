import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGateReport } from './quality-gates.mjs';

test('browser pass requires every prescribed scenario, provenance and cleanup', () => {
  const req = { ...request, stage: 'test', commands: [], scenarios: [{ id: 'PW-01', criteria: ['AC-01'] }] };
  const result = { ...report, ...req, scenarios: [{ id: 'PW-01', result: 'passed' }], provenance: 'local build aaaaa', cleanup: 'passed' };
  assert.equal(validateGateReport(result, req).outcome, 'passed');
  assert.throws(() => validateGateReport({ ...result, scenarios: [] }, req), /PW-01/);
  assert.throws(() => validateGateReport({ ...result, provenance: '' }, req), /provenance/);
  assert.throws(() => validateGateReport({ ...result, cleanup: 'blocked' }, req), /cleanup/);
});

const request = { runId: 'run-1', stage: 'review', revision: 'a'.repeat(40), contractHash: 'contract', commands: ['npm test'], scenarios: [] };
const report = { ...request, outcome: 'passed', summary: 'Approved', reportPath: '/artifacts/review.md', checks: [{ command: 'npm test', result: 'passed' }], scenarios: [], architecture: 'passed', safety: 'confirmed', requiredHumanAction: '' };
test('a review cannot pass with missing declared command evidence or a stale revision', () => {
  assert.equal(validateGateReport(report, request).outcome, 'passed');
  assert.throws(() => validateGateReport({ ...report, checks: [] }, request), /npm test/);
  assert.throws(() => validateGateReport({ ...report, revision: 'b'.repeat(40) }, request), /revision/);
});

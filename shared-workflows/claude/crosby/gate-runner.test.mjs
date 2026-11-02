import test from 'node:test';
import assert from 'node:assert/strict';
import { runTaskGates } from './gate-runner.mjs';
test('scope or requirement decisions do not trigger an automatic repair', async () => {
  const result = await runTaskGates({task, stage: async () => ({outcome:'changes-required',summary:'Requires scope expansion',repairable:false})});
  assert.equal(result.outcome,'blocked');
  assert.match(result.requiredHumanAction,/scope/i);
});
test('review and browser evidence cannot approve different revisions', async () => {
 const result=await runTaskGates({task,stage:async({stage})=>({outcome:'passed',summary:'ok',revision:stage==='review'?'sha-a':'sha-b'})});
 assert.equal(result.outcome,'blocked');assert.match(result.summary,/revision/i);
});
const task = { id: 'task-001', verification: ['npm test'], reviewContext: 'repo rules', browserAcceptance: { required: true, scenarios: [{ id: 'PW-01' }] } };
test('review failure returns to builder without browser launch, successful review then tests', async () => {
  const calls = [];
  const input = { task, taskWorktree: {path:'/repo'}, worker: {pane:'p'}, stage: async ({stage}) => { calls.push(stage); return { outcome: stage === 'review' ? 'changes-required' : 'passed', summary:'fix', repairable: true }; } };
  assert.equal((await runTaskGates(input)).outcome, 'changes-required');
  assert.deepEqual(calls, ['review']);
  calls.length = 0;
  input.stage = async ({stage}) => { calls.push(stage); return {outcome:'passed', summary:'ok', revision:'sha-a'}; };
  assert.equal((await runTaskGates(input)).outcome, 'passed');
  assert.deepEqual(calls, ['review','test']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { integrateTask } from './integration.mjs';
import { contractHash } from './quality-gates.mjs';
const task = { id:'task-005',fileScope:['src/'],verification:['node --test'],reviewContext:'rules',browserAcceptance:{required:false,reason:'backend only',scenarios:[]} };
const taskWorktree={path:'/task',branch:'task',baseSha:'base'},parentWorktree={path:'/parent',branch:'parent'};
const revision='a'.repeat(40);
function gates() {return {outcome:'passed',revision,contractHash:contractHash(task),reports:[{runId:'r',stage:'review',revision,contractHash:contractHash(task),outcome:'passed',summary:'ok',reportPath:'/evidence.md',safety:'confirmed',architecture:'passed',checks:[{command:'node --test',result:'passed'}]}]};}
function ops(overrides={}) {const calls=[];return {calls,assertStableRevision:async()=>revision,collectChangedPaths:async()=>['src/a'],validateChangedPaths:()=>{},serializedMerge:async()=>{calls.push('merge');return {merged:true};},retainTaskFailure:()=>({outcome:'review-required'}),...overrides};}
test('integration refuses missing, stale or failed gates even on direct/manual invocation',async()=>{
 for(const proof of [undefined,{...gates(),revision:'old'},{...gates(),outcome:'blocked'}]){
  const operations=ops();await assert.rejects(integrateTask({task,taskWorktree,parentWorktree,gates:proof,operations}),/gate|revision/i);assert.deepEqual(operations.calls,[]);
 }
});
test('integration merges only clean verified revision without rerunning unsafe shell or auto-committing changes',async()=>{
 const operations=ops();const result=await integrateTask({task,taskWorktree,parentWorktree,gates:gates(),operations});assert.equal(result.merge.merged,true);assert.deepEqual(operations.calls,['merge']);
});
test('integration retains out-of-scope changes and refuses browser bypass',async()=>{
 const operations=ops({validateChangedPaths:()=>{throw new Error('outside scope');}});await assert.rejects(integrateTask({task,taskWorktree,parentWorktree,gates:gates(),operations}),/outside scope/);
 const browserTask={...task,browserAcceptance:{required:true,scenarios:[{id:'PW-01'}]}};
 const proof=gates();proof.contractHash=contractHash(browserTask);proof.reports[0].contractHash=proof.contractHash;
 await assert.rejects(integrateTask({task:browserTask,taskWorktree,parentWorktree,gates:proof,operations:ops()}),/test gate/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistryStore, updateRegistry } from './registry.mjs';
import { createGateStage, persistGateReport, validateSubmittedGateReport, ensureGateAgentsSettled } from './gate-stage.mjs';
const revision='a'.repeat(40);
const task={id:'task-007',title:'Example',outcome:'works',verification:['npm test'],reviewContext:'repo rules',browserAcceptance:{required:false,reason:'backend',scenarios:[]}};
function gitExec(dirty=false){return async (_cmd,args)=>({code:0,stdout:args[0]==='rev-parse'?revision:dirty?' M src/a':'',stderr:''});}
test('fresh verifier runs in builder tab sibling, reports revision-bound evidence, and preserves focus',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'crosby-gate-'));let requestPath;const calls=[];const exec=gitExec();
 const herdr={
  waitForAgent:async()=>({state:'idle'}),
  createVerifierPane:async(input)=>{calls.push(input);requestPath=input.env.CROSBY_GATE_REQUEST;return {pane:'verifier-pane',tab:'builder-tab'};},
  startClaudeAgent:async(input)=>{calls.push(input);return {name:'fresh-reviewer'};},
  promptAgent:async(input)=>{const req=JSON.parse(await readFile(requestPath,'utf8'));assert(!input.prompt.includes('builder conversation'));const reportPath=path.join(req.artifactDir,'review.md');await writeFile(reportPath,'Sanitised review evidence');await persistGateReport({requestPath,pane:'verifier-pane',exec,report:{outcome:'passed',summary:'approved',reportPath,safety:'confirmed',architecture:'passed',checks:[{command:'npm test',result:'passed'}]}});},
 };
 const stage=createGateStage({herdr,exec,root,selectModel:async()=>({model:'opus',thinking:'low',source:'issue-label'}),timeoutMs:1000,pollMs:1});
 const result=await stage({task,taskWorktree:{path:root,baseSha:'base'},worker:{pane:'builder-pane',agent:'builder'},stage:'review'});
 assert.equal(result.outcome,'passed');assert.equal(result.revision,revision);assert.equal(calls[0].pane,'builder-pane');assert.equal(calls[1].pane,'verifier-pane');
 const req=JSON.parse(await readFile(requestPath,'utf8'));assert.equal(req.pane,'verifier-pane');
 await assert.rejects(persistGateReport({requestPath,pane:'builder-pane',exec,report:{}}),/independent verifier/);
 await assert.rejects(validateSubmittedGateReport({...result,submission:undefined},req),/receipt/);
 await writeFile(result.reportPath,'Tampered evidence');
 await assert.rejects(validateSubmittedGateReport(result,req),/evidence changed/);
});
test('parent retries cannot overlap a retained active verifier',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'crosby-parent-active-'));
 const store=createRegistryStore({root,repositoryIdentity:'repo',parentKey:'parent'});
 await updateRegistry(store,r=>({...r,gateRuns:{run:{taskId:'parent-github-1',lifecycle:'blocked',pane:'verifier',agent:'test'}}}));
 await assert.rejects(ensureGateAgentsSettled({store,taskId:'parent-github-1',herdr:{inspectAgent:async()=>({state:'working'})}}),/settle or stop/);
});
test('dirty revision blocks before verifier launch instead of restoring user changes',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'crosby-dirty-'));
 const stage=createGateStage({root,exec:gitExec(true),herdr:{},selectModel:async()=>{throw new Error('must not select');}});
 const result=await stage({task,taskWorktree:{path:root},worker:{pane:'builder'},stage:'review'});
 assert.equal(result.outcome,'blocked');assert.match(result.summary,/clean/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistryStore, updateRegistry } from './registry.mjs';
import { resolveRegistrySpace } from './registry-discovery.mjs';
import { verifiedPublicationTarget } from './publication-gate.mjs';
import { buildContractHash } from './quality-gates.mjs';
import { createParentRepairPreparation } from './parent-repair.mjs';
import { createHerdrCliInvoker } from './herdr-cli.mjs';

test('resume discovers durable progress from a different workspace without dropping state',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'crosby-discovery-'));
 const identity={root,repositoryIdentity:'repo',parentKey:'parent',buildId:'build'};
 const store=createRegistryStore({...identity,spaceId:'old-workspace'});
 await updateRegistry(store,r=>({...r,workers:{one:{repairAttempts:3}}}));
 assert.equal(await resolveRegistrySpace({...identity,workspace:'new-workspace'}),'old-workspace');
 const conflict=createRegistryStore({...identity,spaceId:'second'});
 await updateRegistry(conflict,r=>({...r,workers:{two:{}}}));
 await assert.rejects(resolveRegistrySpace({...identity,workspace:'new-workspace'}),/Multiple durable/);
});
test('publication validates managed worktree/ref and rejects changed or malformed contracts',async()=>{
 const build={tasks:[{id:'task-1',contractError:'',verification:[]}],parentReviewContext:'rules',parentBrowserAcceptance:{required:false,reason:'no UI'},parentAcceptanceCriteria:['AC-01']};
 const registry={readyForReview:true,parentWorktree:{path:'/managed-parent'},parentVerification:{outcome:'passed',revision:'a'.repeat(40),buildContractHash:buildContractHash(build)}};
 const calls=[];
 const exec=async(_cmd,args,options)=>{calls.push({args,options});return {code:0,stdout:args[0]==='rev-parse'?'a'.repeat(40):args[0]==='symbolic-ref'?'parent-branch':''};};
 const target=await verifiedPublicationTarget({state:{build,registry},branch:'parent-branch',exec});
 assert.equal(target.cwd,'/managed-parent');assert(calls.every(c=>c.options.cwd==='/managed-parent'));assert(!calls.some(c=>c.args.includes('checkout')));
 await assert.rejects(verifiedPublicationTarget({state:{build,registry},branch:'wrong-branch',exec}),/Publication branch/);
 const invalid={...build,tasks:[{...build.tasks[0],contractError:'Duplicate Review Context'}]};
 assert.notEqual(buildContractHash(invalid),buildContractHash(build));
 await assert.rejects(verifiedPublicationTarget({state:{build:invalid,registry},branch:'parent-branch',exec}),/contracts/);
});
test('parent repair fast-forwards retained child to combined parent without reset or rebase',async()=>{
 const calls=[];const revision='b'.repeat(40);
 const prepare=createParentRepairPreparation(async(_cmd,args,options)=>{calls.push(args);return {code:0,stdout:args[0]==='rev-parse'?revision:'',stderr:''};});
 const worktree=await prepare({worker:{taskWorktree:{path:'/child',branch:'child',baseSha:'old'}},parentWorktree:{path:'/parent'}});
 assert.equal(worktree.baseSha,revision);assert.deepEqual(calls.find(a=>a[0]==='merge'),['merge','--ff-only',revision]);assert(!calls.some(a=>a.includes('reset')||a.includes('rebase')));
});
test('Herdr verifier split passes required direction and keys use the current CLI',async()=>{
 const calls=[];const invoke=createHerdrCliInvoker({exec:async(_cmd,args)=>{calls.push(args);return {code:0,stdout:JSON.stringify({result:{pane:{pane_id:'p2',tab_id:'t1'},agent:{name:'reviewer',state:'working'}}})};}});
 assert.deepEqual(await invoke('splitPane',{pane:'p1',cwd:'/repo',direction:'right',env:{CROSBY_GATE_REQUEST:'/request'}}),{pane:'p2',tab:'t1'});
 assert(calls[0].includes('--direction'));assert(calls[0].includes('--no-focus'));
 await invoke('sendAgentKeys',{agent:'reviewer',keys:['enter']});assert.deepEqual(calls[1],['agent','send-keys','reviewer','enter']);
});

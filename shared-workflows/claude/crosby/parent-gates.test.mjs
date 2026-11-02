import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {createParentVerifier} from './parent-gates.mjs';import {createRegistryStore,updateRegistry} from './registry.mjs';import {buildContractHash} from './quality-gates.mjs';
const revision='c'.repeat(40);
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'crosby-parent-'));await mkdir(path.join(root,'.pi'));await writeFile(path.join(root,'.pi/crosby.json'),JSON.stringify({version:1,finalIntegrationCommands:['npm run verify']}));const store=createRegistryStore({root,repositoryIdentity:'repo',parentKey:'parent'});const build={buildId:'github-1',tasks:[{id:'task-002',executionMode:'AFK'}],parentReviewContext:'Follow repository safe testing instructions',parentAcceptanceCriteria:['AC-01'],parentBrowserAcceptance:{required:true,scenarios:[{id:'PW-01',criteria:['AC-01']}]},contractError:''};return {root,store,build,parentWorktree:{path:root,baseSha:'base'}};}
const exec=async(_command,args)=>({code:0,stdout:args[0]==='rev-parse'?revision:''});
test('parent final gates use repository commands and recreate a confirmed closed parent tab',async()=>{
 const input=await fixture();await updateRegistry(input.store,r=>({...r,parentGatePane:{pane:'closed',tab:'old'}}));const calls=[];
 const verify=createParentVerifier({exec,herdr:{snapshot:async()=>({panes:[]}),createTaskTab:async(args)=>{calls.push(args);return {pane:'new',tab:'new'};}},stage:async({task,stage})=>{calls.push({stage,commands:task.verification});return {outcome:'passed',revision,summary:'ok'};}});
 const result=await verify(input);assert.equal(result.outcome,'passed');assert.equal(calls[0].label,'Crosby #1');assert.deepEqual(calls.slice(1).map(x=>x.stage),['review','test']);assert.deepEqual(calls[1].commands,['npm run verify']);assert.equal(result.buildContractHash,buildContractHash(input.build));
});
test('parent defects require concrete child attribution for automatic repair',async()=>{
 const input=await fixture();const herdr={createTaskTab:async()=>({pane:'new',tab:'new'}),snapshot:async()=>({panes:['new']})};
 const make=repairTaskId=>createParentVerifier({exec,herdr,stage:async()=>({outcome:'changes-required',repairable:true,repairTaskId,summary:'regression'})});
 assert.equal((await make('task-002')(input)).outcome,'changes-required');assert.equal((await make('unknown')(input)).outcome,'blocked');
});
test('missing final integration configuration blocks before any verifier launch',async()=>{
 const input=await fixture();input.parentWorktree.path=path.join(input.root,'missing');
 const result=await createParentVerifier({exec,herdr:{createTaskTab:async()=>{throw new Error('must not launch');}},stage:async()=>{throw new Error('must not execute');}})(input);
 assert.equal(result.outcome,'blocked');assert.match(result.requiredHumanAction,/finalIntegrationCommands/);
});

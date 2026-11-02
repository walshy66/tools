import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistryStore, readRegistry, updateRegistry } from './registry.mjs';
import { acknowledgeManualAction } from './manual-recovery.mjs';
import { createProgressNotifier } from './progress-notifier.mjs';
test('manual acknowledgement does not integrate code or reset repair budgets',async()=>{
 const store=createRegistryStore({root:await mkdtemp(path.join(tmpdir(),'crosby-manual-')),repositoryIdentity:'repo',parentKey:'parent'});
 await updateRegistry(store,r=>({...r,tasks:{one:{id:'one',executionMode:'AFK'}},workers:{one:{lifecycle:'review',repairAttempts:3,taskWorktree:{path:'/work'},report:{outcome:'blocked'}}}}));
 assert.equal((await acknowledgeManualAction({store,taskId:'one'})).manualOnly,false);
 const worker=(await readRegistry(store)).workers.one;assert.equal(worker.lifecycle,'review');assert.equal(worker.repairAttempts,3);assert.equal(worker.report.outcome,'blocked');assert.equal(worker.humanApproval.approved,true);
});
test('status notifications are one concise line and deduplicated',()=>{
 const lines=[];const notify=createProgressNotifier(line=>lines.push(line));
 notify('Crosby #1\nreviewing');notify('Crosby #1 reviewing');notify('x'.repeat(400));
 assert.equal(lines.length,2);assert(!lines.some(line=>line.includes('\n')));assert.equal(lines[1].length,180);
});

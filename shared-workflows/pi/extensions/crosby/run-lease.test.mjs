import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {acquireRunLease} from './run-lease.mjs';
test('one parent cannot execute concurrently even from another Herdr workspace',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'crosby-lease-'));const input={root,repositoryIdentity:'repo',parentKey:'parent',buildId:'build'};
 const release=await acquireRunLease({...input,workspace:'one'});
 await assert.rejects(acquireRunLease({...input,workspace:'two'}),/already running/);
 await release();const again=await acquireRunLease(input);await again();
});

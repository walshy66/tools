import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const blocked = () => ({ registry: {}, readyForReview: false, blockers: [{ summary: 'Synthetic assistance required' }], build: { buildId: 'test', parentBranch: 'test' }, completed: [] });

// Execute the real command registration, replacing only imported IO boundaries.
// No GitHub, provider, terminal, process or managed-worktree operations are run.
async function harness(runBuild, overrides = {}) {
  const commands = new Map(), events = new Map(), notices = [], entries = [];
  let gateSignal;
  const pi = {
    on: (name, handler) => events.set(name, handler),
    registerTool: () => {},
    registerCommand: (name, options) => commands.set(name, options.handler),
    exec: async () => ({ code: 0, stdout: 'https://github.com/example/synthetic', stderr: '' }),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  const ctx = {
    model: { provider: 'synthetic', id: 'test' },
    modelRegistry: { getAvailable: () => [] },
    ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }) },
  };
  let source = stripTypeScriptTypes(await readFile(new URL('./index.ts', import.meta.url), 'utf8'));
  source = source.replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?\s*$/gm, '')
    .replace('export default function crosbyExtension', 'function crosbyExtension')
    .replaceAll('import.meta.url', JSON.stringify(new URL('./index.ts', import.meta.url).href));
  const [load, monitor] = vm.runInNewContext(`${source}\n[crosbyExtension, startGitHubQueueMonitor]`, {
    process: { env: {}, cwd: () => '/synthetic-checkout' }, path, AbortController, setTimeout, clearTimeout,
    homedir: () => '/synthetic-home',
    Type: new Proxy({}, { get: () => () => ({}) }),
    registerGateWorker: () => false,
    parseGitHubCommand: () => null,
    parseBuildCommandArgs: () => ({ mode: 'run', buildFolder: '/synthetic-build' }),
    requireCrosbyHerdrContext: () => ({ workspace: 'test-workspace', pane: 'test-pane' }),
    createHerdrCliInvoker: () => () => {}, createHerdrClient: () => ({}),
    buildModelCandidates: () => [],
    createGateStage: ({ signal }) => { gateSignal = signal; return () => {}; },
    createParentVerifier: () => () => {}, createParentRepairPreparation: () => () => {},
    createProgressNotifier: (notify) => (message, level = 'info') => notify(message, level),
    oneLine: (text) => String(text).replaceAll('\n', ' '),
    readBuildStatus: async () => ({ progress: {} }), formatBuildProgress: () => 'synthetic progress',
    runBuild, ...overrides,
  }, { filename: 'crosby-command-under-test.js' });
  load(pi);
  return { monitor, invoke: (args = 'run /synthetic-build') => commands.get('crosby')(args, ctx), shutdown: () => events.get('session_shutdown')(), notices, entries, signal: () => gateSignal };
}

test('trigger accepts the next normal input while the real Crosby command awaits its build', async (t) => {
  const build = deferred();
  let started = 0, returned = false;
  const app = await harness(async () => { started++; return build.promise; });
  const command = Promise.resolve(app.invoke()).then(() => { returned = true; });
  t.after(async () => { build.resolve(blocked()); await command; });
  await turn();
  assert.equal(started, 1, JSON.stringify(app.notices));
  assert.equal(returned, true, 'Crosby must release Pi submission before the build settles');
  const conversation = [];
  await command;
  conversation.push('ordinary user input processed');
  assert.equal(conversation.length, 1);
  assert.equal(app.entries.some(entry => entry.type === 'crosby-build-settled'), false);
});

test('a second Crosby invocation cannot launch a duplicate while supervision is pending', async (t) => {
  const build = deferred();
  let starts = 0;
  const app = await harness(async () => { starts++; return build.promise; });
  t.after(async () => { build.resolve(blocked()); await turn(); });
  await app.invoke();
  await turn();
  await app.invoke();
  await turn();
  assert.equal(starts, 1);
  assert(app.notices.some(entry => /already running/i.test(entry.message)));
});

test('background failure stays visible and releases the invocation guard for explicit retry', async () => {
  let starts = 0;
  const app = await harness(async () => { starts++; throw new Error('Synthetic supervisor failure'); });
  await app.invoke();
  await turn();
  assert(app.notices.some(entry => /Synthetic supervisor failure/.test(entry.message)));
  assert.equal(app.entries.some(entry => entry.type === 'crosby-build-settled'), false);
  await app.invoke();
  await turn();
  assert.equal(starts, 2);
});

test('shutdown aborts supervision and suppresses late completion and further launches', async () => {
  const build = deferred();
  let starts = 0;
  const app = await harness(async () => { starts++; return build.promise; });
  await app.invoke();
  await turn();
  await app.shutdown();
  assert.equal(app.signal().aborted, true);
  const noticeCount = app.notices.length, entryCount = app.entries.length;
  build.resolve(blocked());
  await turn();
  assert.equal(app.notices.length, noticeCount, 'No stale-session notification after shutdown');
  assert.equal(app.entries.length, entryCount, 'No late completion claimed after shutdown');
  await app.invoke();
  await turn();
  assert.equal(starts, 1);
});

test('shutdown during command setup prevents a late worker launch', async () => {
  let starts = 0;
  const app = await harness(async () => { starts++; return blocked(); });
  // The command is returned to Pi before its first IO resumes.
  await app.invoke();
  await app.shutdown();
  await turn();
  assert.equal(starts, 0);
  assert.equal(app.entries.some(entry => entry.type === 'crosby-build-settled'), false);
});

test('stopping an idle queue monitor drains in-flight IO without resuming a stale build', async () => {
  const fetch = deferred();
  let scheduled, refreshed = 0, writes = 0, starts = 0, stopped = false;
  const app = await harness(async () => blocked(), {
    setTimeout: (callback) => { scheduled = callback; return 1; }, clearTimeout: () => {},
    writeGitHubBuild: async () => { writes++; return '/synthetic-build'; },
  });
  const queue = { parent: { identifier: '#100', body: 'old', state: { name: 'Building' } }, children: [] };
  const stop = app.monitor({ client: { loadParentQueue: () => fetch.promise }, queue,
    dashboardController: { queueRefreshed: () => { refreshed++; } },
    runBuild: async () => { starts++; return blocked(); } });
  const polling = scheduled();
  const stopping = Promise.resolve(stop()).then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false, 'A new command must not race the old monitor IO');
  fetch.resolve({ ...queue, parent: { ...queue.parent, body: 'new' } });
  await polling;
  await stopping;
  assert.equal(refreshed, 0);
  assert.equal(writes, 0);
  assert.equal(starts, 0);
});

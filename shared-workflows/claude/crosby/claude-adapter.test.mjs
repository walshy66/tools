import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeLaunchCommand, prepareClaudeLaunch, resolveClaudeModel, validClaudeSelection } from './claude-launch.mjs';
import { callTool, persistAdhocReport, toolsFor } from './crosby-mcp.mjs';
import { decide } from './crosby-hook.mjs';
import { createRegistryStore, readRegistry, updateRegistry } from './registry.mjs';

test('the child issue label decides the Claude model and Haiku is never used', () => {
  assert.deepEqual(resolveClaudeModel({ modelHint: 'sonnet', thinkingHint: 'high' }), { model: 'sonnet', thinking: 'high', source: 'issue-label' });
  assert.deepEqual(resolveClaudeModel({ modelHint: 'anthropic/claude-opus-5-5' }), { model: 'claude-opus-5-5', thinking: null, source: 'issue-label' });
  assert.deepEqual(resolveClaudeModel({ modelHint: 'openai-codex/gpt-6-luna', thinkingHint: 'minimal' }), { model: 'opus', thinking: 'low', source: 'default' });
  assert.deepEqual(resolveClaudeModel({}), { model: 'opus', thinking: null, source: 'default' });
  assert.throws(() => resolveClaudeModel({ modelHint: 'haiku' }), /Haiku is not permitted/);
  assert.throws(() => resolveClaudeModel({ modelHint: 'claude-haiku-4-5-20251001' }), /Haiku is not permitted/);
  assert.throws(() => resolveClaudeModel({ fallbackModel: 'haiku' }), /Haiku/);
  assert.equal(validClaudeSelection({ model: 'opus', thinking: 'medium', source: 'issue-label' }), true);
  assert.equal(validClaudeSelection({ model: 'openai-codex/gpt-6-luna', thinking: 'medium', source: 'orchestrator' }), false);
  assert.equal(validClaudeSelection({ model: 'claude-haiku-4-5', thinking: null, source: 'issue-label' }), false);
});

test('launch command quotes paths for the pane shell and refuses Haiku', () => {
  assert.equal(
    claudeLaunchCommand({ model: 'opus', effort: 'high', mcpConfig: "C:\\a b\\it's\\mcp.json", settings: 'C:\\s.json', name: 'task-001', platform: 'win32' }),
    "claude --dangerously-skip-permissions --model opus --effort high --mcp-config 'C:\\a b\\it''s\\mcp.json' --settings 'C:\\s.json' -n 'task-001'",
  );
  assert.throws(() => claudeLaunchCommand({ model: 'haiku', mcpConfig: 'm', settings: 's' }), /Refusing/);
  assert.throws(() => claudeLaunchCommand({ model: 'opus', mcpConfig: 'a\nb', settings: 's' }), /single-line/);
});

test('prepared launch wires the crosby MCP server and PreToolUse hook to one context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crosby-launch-'));
  const launch = await prepareClaudeLaunch({ root, name: 'task-001-abc', mode: 'worker', context: { env: { CROSBY_TASK_KEY: 'task-001' } } });
  const mcp = JSON.parse(await readFile(launch.mcpConfig, 'utf8'));
  const settings = JSON.parse(await readFile(launch.settings, 'utf8'));
  assert.deepEqual(mcp.mcpServers.crosby.args.slice(-2), ['--context', launch.contextPath]);
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /crosby-hook\.mjs" --context ".+context\.json"$/);
  assert.equal(JSON.parse(await readFile(launch.contextPath, 'utf8')).mode, 'worker');
  await assert.rejects(prepareClaudeLaunch({ root, name: 'x', mode: 'builder' }), /Unsupported/);
});

async function workerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'crosby-mcp-worker-'));
  const env = { CROSBY_REGISTRY_ROOT: root, CROSBY_REPOSITORY_ID: 'repo', CROSBY_PARENT_KEY: 'crosby/parent', CROSBY_TASK_KEY: 'task-001', CROSBY_BUILD_ID: 'github-1', CROSBY_SPACE_ID: 'w1' };
  const store = createRegistryStore({ root, repositoryIdentity: 'repo', parentKey: 'crosby/parent', buildId: 'github-1', spaceId: 'w1' });
  await updateRegistry(store, (registry) => ({ ...registry, workers: { 'task-001': { taskId: 'task-001', lifecycle: 'working' } } }));
  return { context: { mode: 'worker', env }, store };
}

test('worker report tool persists a validated report and the hook then freezes the builder', async () => {
  const { context, store } = await workerFixture();
  assert.deepEqual(toolsFor(context).map((tool) => tool.name), ['crosby_worker_report']);
  assert.equal(await decide(context, { tool_name: 'Edit', tool_input: {} }), null);
  await assert.rejects(callTool(context, 'crosby_worker_report', { outcome: 'complete', summary: 'done' }), /taskOutcome/);
  await assert.rejects(callTool(context, 'crosby_gate_report', {}), /not available/);
  const reply = await callTool(context, 'crosby_worker_report', { outcome: 'complete', taskOutcome: 'Works', summary: 'done', changes: { paths: ['src/a.mjs'], commit: 'abc' }, verification: [{ command: 'npm test', result: 'passed' }], risks: [] });
  assert.match(reply, /recorded for task-001/);
  assert.equal((await readRegistry(store)).workers['task-001'].lifecycle, 'reported');
  assert.match(await decide(context, { tool_name: 'Bash', tool_input: { command: 'git commit' } }), /report submitted/);
  assert.equal(await decide(context, { tool_name: 'Read', tool_input: {} }), null);
});

async function verifierFixture(mode) {
  const dir = await mkdtemp(path.join(tmpdir(), `crosby-${mode}-`));
  const artifactDir = path.join(dir, 'artifacts');
  const cwd = path.join(dir, 'repo');
  await mkdir(artifactDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const resultPath = path.join(artifactDir, 'result.json');
  if (mode === 'gate') {
    const requestPath = path.join(artifactDir, 'request.json');
    await writeFile(requestPath, JSON.stringify({ artifactDir, resultPath, cwd }));
    return { context: { mode, requestPath, pane: 'p1' }, artifactDir, resultPath, cwd };
  }
  return { context: { mode, artifactDir, resultPath, cwd }, artifactDir, resultPath, cwd };
}

test('verifier hook stays report-only and writes only flat artifacts', async () => {
  const { context, artifactDir, resultPath, cwd } = await verifierFixture('gate');
  assert.match(await decide(context, { tool_name: 'Edit', tool_input: {} }), /report-only/);
  assert.match(await decide(context, { tool_name: 'mcp__github__create_issue', tool_input: {} }), /report-only/);
  assert.equal(await decide(context, { tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  assert.equal(await decide(context, { tool_name: 'Write', tool_input: { file_path: path.join(artifactDir, 'review.md') } }), null);
  assert.match(await decide(context, { tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'src.mjs') } }), /flat report/);
  assert.match(await decide(context, { tool_name: 'Write', tool_input: { file_path: path.join(artifactDir, 'nested', 'x.md') } }), /flat report/);
  assert.match(await decide(context, { tool_name: 'Write', tool_input: { file_path: path.join(artifactDir, 'result.json') } }), /flat report/);
  await writeFile(resultPath, '{}');
  assert.match(await decide(context, { tool_name: 'Read', tool_input: {} }), /already submitted/);
});

test('ad-hoc reviewer reports inside its artifact dir and stays read-only afterwards', async () => {
  const { context, artifactDir, resultPath, cwd } = await verifierFixture('adhoc');
  const outside = path.join(cwd, 'review.md');
  await writeFile(outside, 'x');
  await assert.rejects(persistAdhocReport({ context, report: { outcome: 'passed', summary: 's', reportPath: outside } }), /inside the assigned artifact/);
  await assert.rejects(persistAdhocReport({ context, report: { outcome: 'approved', summary: 's', reportPath: outside } }), /outcome/);
  const reportPath = path.join(artifactDir, 'review.md');
  await writeFile(reportPath, '# Review\nAPPROVED');
  const reply = await callTool(context, 'crosby_gate_report', { outcome: 'passed', summary: 'Looks good', reportPath });
  assert.match(reply, /Review recorded: passed/);
  const saved = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(saved.submission.artifactHash.length, 64);
  await assert.rejects(callTool(context, 'crosby_gate_report', { outcome: 'passed', summary: 'again', reportPath }), /EEXIST/);
  assert.equal(await decide(context, { tool_name: 'Grep', tool_input: {} }), null);
  assert.match(await decide(context, { tool_name: 'Bash', tool_input: {} }), /already submitted/);
});

test('hook fails closed on an unknown mode', async () => {
  assert.match(await decide({ mode: 'builder' }, { tool_name: 'Read' }), /Unknown Crosby agent mode/);
});

test('MCP server speaks JSON-RPC over stdio and lists the mode tool', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'crosby-mcp-stdio-'));
  const contextPath = path.join(dir, 'context.json');
  await writeFile(contextPath, JSON.stringify({ mode: 'adhoc', artifactDir: dir, resultPath: path.join(dir, 'result.json'), cwd: dir }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'crosby-mcp.mjs'), '--context', contextPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const responses = [];
  let buffer = '';
  const done = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
    if (responses.length === 3) resolve();
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crosby_gate_report', arguments: { outcome: 'passed', summary: 's', reportPath: path.join(dir, 'missing.md') } } })}\n`);
  await done;
  child.kill();
  assert.equal(responses[0].result.serverInfo.name, 'crosby');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['crosby_gate_report']);
  assert.equal(responses[1].result.tools[0].inputSchema.type, 'object');
  assert.equal(responses[2].result.isError, true);
});

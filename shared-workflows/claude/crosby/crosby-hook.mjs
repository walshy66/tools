#!/usr/bin/env node
// Claude PreToolUse hook for Crosby-launched agents (equivalent of the Pi tool_call hooks).
// Not an OS sandbox: Bash stays available for tests/browser CLI; revision checks catch mutation.
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistryStore, readRegistry } from './registry.mjs';

export const VERIFIER_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'TodoWrite', 'Skill', 'ToolSearch', 'mcp__crosby__crosby_gate_report']);
const PROTOCOL_FILES = new Set(['request.json', 'result.json']);

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function workerDecision(context, event) {
  if (event.tool_name === 'Read') return null;
  const env = context.env;
  const store = createRegistryStore({ root: env.CROSBY_REGISTRY_ROOT, repositoryIdentity: env.CROSBY_REPOSITORY_ID, parentKey: env.CROSBY_PARENT_KEY, buildId: env.CROSBY_BUILD_ID || 'default', buildFolder: env.CROSBY_BUILD_FOLDER, parentBranch: env.CROSBY_PARENT_BRANCH, spaceId: env.CROSBY_SPACE_ID || 'default' });
  const worker = (await readRegistry(store)).workers?.[env.CROSBY_TASK_KEY];
  if (worker?.report) return 'Builder report submitted. Remain idle until Crosby assigns a repair or resume.';
  return null;
}

async function verifierDecision(context, event) {
  const request = context.mode === 'gate' ? JSON.parse(await readFile(context.requestPath, 'utf8')) : context;
  if (await exists(request.resultPath)) {
    // Ad-hoc reviewers stay available for read-only follow-up questions from the operator.
    if (context.mode === 'adhoc' && ['Read', 'Grep', 'Glob'].includes(event.tool_name)) return null;
    return 'Report already submitted; verification is finished. Stop now.';
  }
  if (!VERIFIER_TOOLS.has(event.tool_name)) return 'Verifier is report-only; implementation edits and external management tools are disabled.';
  if (event.tool_name !== 'Write') return null;
  const root = await realpath(request.artifactDir);
  const target = path.resolve(request.cwd, String(event.tool_input?.file_path ?? ''));
  const relative = path.relative(root, target);
  // Flat artifacts only: no symlinked parent escape and no overwrite of protocol files.
  if (!relative || path.dirname(relative) !== '.' || PROTOCOL_FILES.has(relative)) return `Write only flat report/helper artifacts in ${request.artifactDir}.`;
  try {
    const actual = await realpath(target);
    if (path.dirname(actual) !== root) return 'Artifact symlink escapes the assigned directory.';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return null;
}

export async function decide(context, event) {
  if (context.mode === 'worker') return workerDecision(context, event);
  if (context.mode === 'gate' || context.mode === 'adhoc') return verifierDecision(context, event);
  return `Unknown Crosby agent mode '${context.mode}'.`;
}

async function main() {
  const index = process.argv.indexOf('--context');
  let reason;
  try {
    const context = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    reason = await decide(context, JSON.parse(input));
  } catch (error) {
    // Fail closed: an unreadable contract must not silently permit tool use.
    reason = `Crosby hook could not validate this tool call: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
// Minimal stdio MCP server exposing Crosby's terminal report tools to Claude agents.
// Claude equivalent of the Pi extension's crosby_worker_report / crosby_gate_report tools.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { persistWorkerReport } from './worker-report.mjs';
import { persistGateReport } from './gate-stage.mjs';

const execute = promisify(execFile);
export async function exec(command, args, options) {
  try { const result = await execute(command, args, { ...options, windowsHide: true }); return { ...result, code: 0 }; }
  catch (error) { return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? '' }; }
}

const text = { type: 'string' };
const strings = { type: 'array', items: text };

export const WORKER_TOOL = {
  name: 'crosby_worker_report',
  description: 'Submit the final validated completion or human-block report for this Crosby task. This is the worker\'s final action; stop working after it succeeds. Report a human block instead of guessing or continuing unsafely.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['complete', 'blocked', 'failed', 'cancelled'] },
      taskOutcome: { ...text, description: 'complete only: the delivered task outcome' },
      summary: text,
      changes: { type: 'object', description: 'complete only', properties: { paths: { ...strings, description: 'repository-relative changed paths' }, commit: text }, required: ['paths', 'commit'] },
      verification: { type: 'array', description: 'complete only', items: { type: 'object', properties: { command: text, result: { type: 'string', enum: ['passed', 'skipped'] } }, required: ['command', 'result'] } },
      risks: { ...strings, description: 'complete only' },
      requiredHumanAction: { ...text, description: 'blocked only' },
      recoveryNotes: { ...strings, description: 'blocked/failed/cancelled' },
      requestHerdrBlocked: { type: 'boolean', description: 'blocked only: must be true' },
    },
    required: ['outcome', 'summary'],
  },
};

export const GATE_TOOL = {
  name: 'crosby_gate_report',
  description: 'Submit the independent revision-bound review/browser result after writing a sanitised Markdown report. Final action; no implementation changes. Stop working after it succeeds.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { ...text, description: 'passed, changes-required, or blocked' },
      summary: text,
      reportPath: { ...text, description: 'absolute path of the Markdown report inside the assigned artifact directory' },
      safety: { ...text, description: 'confirmed only after safe environment and command prerequisites verified' },
      architecture: text,
      checks: { type: 'array', items: { type: 'object', properties: { command: text, result: text, required: { type: 'boolean' } }, required: ['command', 'result'] } },
      scenarios: { type: 'array', items: { type: 'object', properties: { id: text, result: text }, required: ['id', 'result'] } },
      provenance: text,
      cleanup: text,
      repairTaskId: { ...text, description: 'Parent verification only: exact child task-NNN proven to own this defect within its allowed scope; omit when attribution is ambiguous.' },
      repairable: { type: 'boolean', description: 'True only for a concrete defect repairable inside approved scope; never for environment, permissions, scope or requirement decisions.' },
      requiredHumanAction: { ...text, description: 'Exact assistance needed when blocked or not safely repairable; empty for pass.' },
    },
    required: ['outcome', 'summary', 'reportPath', 'safety', 'checks', 'scenarios', 'repairable', 'requiredHumanAction'],
  },
};

// Ad-hoc /reviewer runs are not revision-gated integration evidence, so the
// working tree may be dirty; the report must still stay inside its artifact dir.
export async function persistAdhocReport({ context, report }) {
  const outcome = String(report?.outcome ?? '');
  if (!['passed', 'changes-required', 'blocked'].includes(outcome)) throw new Error('outcome must be passed, changes-required, or blocked.');
  if (!String(report?.summary ?? '').trim()) throw new Error('summary is required.');
  const artifacts = await realpath(context.artifactDir);
  const reportReal = await realpath(String(report.reportPath ?? ''));
  const relative = path.relative(artifacts, reportReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('reportPath must be inside the assigned artifact directory.');
  const evidence = await readFile(reportReal, 'utf8');
  if (!evidence.trim()) throw new Error('Report artifact is empty.');
  const saved = { ...report, outcome, reportPath: reportReal, stage: 'adhoc-review', submission: { artifactHash: createHash('sha256').update(evidence).digest('hex'), submittedAt: new Date().toISOString() } };
  await writeFile(context.resultPath, JSON.stringify(saved, null, 2), { flag: 'wx' });
  return saved;
}

export function toolsFor(context) {
  return context.mode === 'worker' ? [WORKER_TOOL] : [GATE_TOOL];
}

export async function callTool(context, name, args) {
  if (context.mode === 'worker' && name === WORKER_TOOL.name) {
    const saved = await persistWorkerReport({ report: args, env: context.env });
    return `Crosby worker report recorded for ${context.env.CROSBY_TASK_KEY} (${saved.report.outcome}). Your task is finished: stop now and remain idle until Crosby assigns a repair or resume.`;
  }
  if (context.mode === 'gate' && name === GATE_TOOL.name) {
    const saved = await persistGateReport({ requestPath: context.requestPath, report: args, pane: context.pane, exec });
    return `Crosby ${saved.stage}: ${saved.outcome}. Report: ${saved.reportPath}. Verification is finished: stop now.`;
  }
  if (context.mode === 'adhoc' && name === GATE_TOOL.name) {
    const saved = await persistAdhocReport({ context, report: args });
    return `Review recorded: ${saved.outcome}. Report: ${saved.reportPath}. Stop now; the operator may continue the conversation here.`;
  }
  throw new Error(`Tool ${name} is not available in Crosby ${context.mode} mode.`);
}

async function main() {
  const index = process.argv.indexOf('--context');
  const context = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const { id, method, params } = message;
    if (id === undefined) continue; // notifications
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'crosby', version: '1.0.0' } } });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: toolsFor(context) } });
      } else if (method === 'tools/call') {
        try {
          const reply = await callTool(context, params?.name, params?.arguments ?? {});
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: reply }] } });
        } catch (error) {
          send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } });
        }
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (error) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

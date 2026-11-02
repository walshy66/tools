import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { persistGateReport } from './gate-stage.mjs';

export function registerGateWorker(pi: ExtensionAPI) {
  const requestPath = process.env.CROSBY_GATE_REQUEST;
  if (!requestPath) return false;
  let reported = false;
  const request = async () => JSON.parse(await readFile(requestPath, 'utf8'));
  pi.on('tool_call', async (event: any) => {
    if (reported) return { block: true, reason: 'Gate already reported; verification is finished.', terminate: true };
    if (!['read', 'bash', 'write', 'crosby_gate_report'].includes(event.toolName)) return { block: true, reason: 'Verifier is report-only; implementation edits and external management tools are disabled.' };
    if (event.toolName === 'write') {
      const contract = await request();
      const root = await realpath(contract.artifactDir);
      const target = path.resolve(contract.cwd, String(event.input.path ?? ''));
      const relative = path.relative(root, target);
      // Flat artifacts only: no symlinked parent escape and no overwrite of protocol files.
      if (!relative || path.dirname(relative) !== '.' || ['request.json', 'result.json'].includes(relative)) return { block: true, reason: 'Write only flat report/helper artifacts in the assigned artifact directory.' };
      try {
        const actual = await realpath(target);
        if (path.dirname(actual) !== root) return { block: true, reason: 'Artifact symlink escapes assigned directory.' };
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    // Bash is needed for repository test commands/browser CLI. This is NOT an OS sandbox.
    // Revision + dirty-tree checks before reporting and integration detect mutations.
  });
  pi.registerTool({
    name: 'crosby_gate_report',
    label: 'Crosby Verification Report',
    description: 'Submit the independent revision-bound review/browser result after writing a sanitised Markdown report. Final action; no implementation changes.',
    parameters: Type.Object({
      outcome: Type.String({ description: 'passed, changes-required, or blocked' }),
      summary: Type.String(), reportPath: Type.String(),
      safety: Type.String({ description: 'confirmed only after safe environment and command prerequisites verified' }),
      architecture: Type.Optional(Type.String()),
      checks: Type.Array(Type.Object({ command: Type.String(), result: Type.String(), required: Type.Optional(Type.Boolean()) })),
      scenarios: Type.Array(Type.Object({ id: Type.String(), result: Type.String() })),
      provenance: Type.Optional(Type.String()), cleanup: Type.Optional(Type.String()),
      repairTaskId: Type.Optional(Type.String({ description: 'Parent verification only: exact child task-NNN proven to own this defect within its allowed scope; omit when attribution is ambiguous.' })),
      repairable: Type.Boolean({ description: 'True only for a concrete defect repairable inside approved scope; never for environment, permissions, scope or requirement decisions.' }),
      requiredHumanAction: Type.String({ description: 'Exact assistance needed when blocked or not safely repairable; empty for pass.' }),
    }),
    async execute(_id, params) {
      const saved = await persistGateReport({ requestPath, report: params, pane: process.env.HERDR_PANE_ID, exec: (command: string, args: string[], options: any) => pi.exec(command, args, options) });
      reported = true;
      return { content: [{ type: 'text', text: `Crosby ${saved.stage}: ${saved.outcome}. Report: ${saved.reportPath}` }], details: saved, terminate: true };
    },
  });
  return true;
}

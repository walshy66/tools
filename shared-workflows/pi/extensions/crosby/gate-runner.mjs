import { contractHash } from './quality-gates.mjs';

export async function runTaskGates({ task, stage, ...context }) {
  if (task.contractError || !task.reviewContext || !task.browserAcceptance) return { outcome: 'blocked', summary: task.contractError || 'Missing review/browser contract.', requiredHumanAction: 'Update the issue using to-issues; preserve approved criteria and supply the missing sections.' };
  if (typeof stage !== 'function') throw new Error('Independent gate stage adapter is required.');
  const reports = [];
  for (const role of ['review', ...(task.browserAcceptance.required ? ['test'] : [])]) {
    const report = await stage({ ...context, task, stage: role, expectedRevision: reports[0]?.revision });
    reports.push(report);
    if (report.outcome === 'passed' && (!report.revision || report.revision !== reports[0].revision)) return { outcome: 'blocked', summary: 'Verification reports do not refer to one stable revision.', requiredHumanAction: 'Stop concurrent changes and rerun verification on a stable revision.', reports };
    if (report.outcome === 'changes-required' && report.repairable !== true) return { ...report, outcome: 'blocked', requiredHumanAction: report.requiredHumanAction || `Resolve the scope/requirement decision: ${report.summary}`, reports };
    if (report.outcome !== 'passed') return { ...report, reports };
  }
  return { outcome: 'passed', summary: 'Required code review and browser gates passed.', reports, revision: reports[0].revision, contractHash: contractHash(task) };
}

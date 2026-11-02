import { readRegistry, updateRegistry } from './registry.mjs';

export async function acknowledgeManualAction({ store, taskId, approvedBy = 'operator' }) {
  const registry = await readRegistry(store);
  const task = registry.tasks[taskId], worker = registry.workers[taskId];
  if (!task || !worker) throw new Error('No retained task exists. Resume the parent first.');
  if (worker.report?.dependencyBlocked) throw new Error('This task is waiting for prerequisites; complete the prerequisite, not this dependent task.');
  const manualOnly = task.executionMode === 'HITL' && !worker.taskWorktree && !worker.agent && !worker.completionReport;
  await updateRegistry(store, (current) => ({ ...current, queueState: 'ready', currentTask: null, workers: { ...current.workers, [taskId]: { ...current.workers[taskId], humanApproval: { approved: true, approvedBy, approvedAt: new Date().toISOString() } } } }));
  // Code-bearing tasks still pass the same review/test/integration gates on resume.
  return { manualOnly, task };
}

const TRANSITIONS = {
  ready: { start: "working" },
  working: { pause: "paused", complete: "ready", review: "ready", blocked: "blocked", failed: "failed", cancelled: "cancelled" },
  paused: { resume: "working", cancelled: "cancelled" },
  blocked: {},
  review: {},
  failed: {},
  cancelled: {},
};

export class StateTransitionError extends Error {
  constructor(message) {
    super(`${message} Recovery: reconcile the durable queue state before continuing.`);
    this.name = "StateTransitionError";
  }
}

export function transitionQueue(state, event, { taskId = null } = {}) {
  if (!state || typeof state !== "object") throw new StateTransitionError("Queue state must be an object.");
  const current = state.queueState;
  const next = TRANSITIONS[current]?.[event];
  if (!next) throw new StateTransitionError(`Cannot apply '${event}' while queue is '${current}'.`);
  if (["complete", "review", "blocked", "failed", "cancelled"].includes(event) && state.currentTask !== taskId) {
    throw new StateTransitionError(`Task '${taskId}' cannot report '${event}' for current task '${state.currentTask}'.`);
  }
  if (event === "start" && !taskId) throw new StateTransitionError("Starting the queue requires a task ID.");
  if (event === "start" && state.currentTask) throw new StateTransitionError("Cannot start a queue that already has a current task.");
  return {
    ...state,
    queueState: next,
    currentTask: ["start"].includes(event) ? taskId : ["complete", "review"].includes(event) ? null : state.currentTask,
  };
}

export function validateQueueState(state) {
  if (!state || typeof state !== "object" || !TRANSITIONS[state.queueState]) {
    throw new StateTransitionError("Queue state is missing a valid queueState.");
  }
  if (["working", "paused"].includes(state.queueState) && !state.currentTask) {
    throw new StateTransitionError(`Queue state '${state.queueState}' requires currentTask.`);
  }
  return state;
}

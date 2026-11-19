import type { State } from './types.js';

export const dispatchAllowed = (state: State): boolean => !state.executionControl || state.executionControl.status === 'running';

/** Pause drains an existing task; termination also closes its model/tool and acceptance boundaries. */
export function assertTaskNotCancelled(state: State, taskId?: string): void {
  if (state.executionControl?.status === 'terminated' || (taskId && state.tasks[taskId]?.cancel)) throw new Error('Execution cancelled by user');
}

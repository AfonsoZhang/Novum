import type { State, Task } from './types.js';

export function taskTimeLimit(state: State, task: Task, now = Date.now()): string | undefined {
  const total = Object.values(state.tasks).reduce((sum, t) => sum + t.elapsedSeconds + (t.startedAt ? (now - t.startedAt) / 1000 : 0), 0);
  if (total >= state.config.maxWallSeconds) return 'Project resource time budget exhausted';
  const reviewed = task.reviewElapsedSeconds ?? 0;
  if (task.reviewStartedAt !== undefined) {
    if (reviewed + (now - task.reviewStartedAt) / 1000 >= (state.config.maxReviewSeconds ?? 900)) return 'Review time budget exhausted';
  } else if (task.startedAt && (now - task.startedAt) / 1000 - reviewed >= state.config.maxTaskSeconds) {
    return 'Execution time budget exhausted';
  }
}

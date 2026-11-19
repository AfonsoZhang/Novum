import fs from 'node:fs';
import { alive, event, local } from './store.js';
import { changed, hashes } from './gates.js';
import { paperType } from './paper-types.js';
import { activePipelineTask } from './pipeline-plan.js';
import type { Review, State, Task } from './types.js';

export function validateTransition(task: Task, review: Pick<Review, 'verdict' | 'transition'>): void {
  const checkpoint = task.pipelineStep?.checkpoint; const decision = review.transition;
  if (!checkpoint) { if (decision) throw new Error('Only workflow checkpoints may request transitions'); return; }
  if (!decision) throw new Error('Workflow checkpoint review must return an explicit transition');
  const accepting = ['PASS', 'WARN', 'NOT_APPLICABLE'].includes(review.verdict);
  if ((decision.action === 'advance') !== accepting) throw new Error('Workflow transition conflicts with the review verdict');
  if (decision.action === 'revise') {
    if (!['FAIL', 'BLOCKED'].includes(review.verdict) || !decision.target || !checkpoint.reworkTargets.includes(decision.target)) throw new Error('Invalid workflow revision target or verdict');
  } else if (decision.target) throw new Error('Only a revision may specify a target');
}

export function descendants(state: State, target: string): Set<string> {
  const result = new Set([target]); let again = true;
  while (again) {
    again = false;
    for (const task of Object.values(state.tasks)) if (!result.has(task.id) && task.dependencies.some(dep => result.has(dep))) { result.add(task.id); again = true; }
  }
  return result;
}

/** Called only after a fresh, parsed independent review, never as an executor tool. */
export function queueTransition(state: State, task: Task, root: string): boolean {
  const decision = task.review?.transition;
  if (!decision || decision.action === 'advance') return false;
  validateTransition(task, task.review!);
  if (changed(root, task.review!.inputHashes).length || (task.researchInputs?.revision ?? 0) !== (state.researchInputs?.revision ?? 0)) throw new Error('Workflow decision evidence or research inputs changed; re-review required');
  task.execution = 'completed'; task.acceptance = 'blocked'; task.reasons = [decision.reason];
  if (decision.action === 'revise') {
    task.pendingRework = { target: decision.target!, reason: decision.reason, reviewSession: task.review!.session, inputRevision: state.researchInputs?.revision ?? 0 };
    event(state, 'workflow_revision_requested', { task: task.id, ...task.pendingRework });
  } else event(state, 'workflow_stopped', { task: task.id, reason: decision.reason, reviewSession: task.review!.session });
  return true;
}

export function waitingForRevision(state: State, id: string): boolean {
  return Object.values(state.tasks).some(task => task.pendingRework && descendants(state, task.pendingRework.target).has(id));
}

/** Runs at a scheduler boundary, after workers have exited. No uncertain call is replayed. */
export function applyWorkflowRevisions(state: State, root: string): void {
  for (const trigger of Object.values(state.tasks)) {
    const request = trigger.pendingRework; if (!request) continue;
    if (!state.pipelineGraph || request.inputRevision !== (state.researchInputs?.revision ?? 0) || !activePipelineTask(state, trigger) || trigger.paperType !== paperType(state)) {
      delete trigger.pendingRework; event(state, 'workflow_revision_cancelled', { task: trigger.id, reason: 'Workflow scope or research inputs changed' }); continue;
    }
    const target = state.tasks[request.target]; const affected = [...descendants(state, request.target)].map(id => state.tasks[id]).filter((task): task is Task => !!task);
    if (affected.some(task => task.execution === 'running' || alive(task.worker))) continue;
    const stop = (reason: string) => { delete trigger.pendingRework; trigger.execution = 'limited'; trigger.reasons = [reason]; event(state, 'workflow_stopped', { task: trigger.id, reason }); };
    if (!target?.pipeline || !activePipelineTask(state, target) || trigger.review?.session !== request.reviewSession || changed(root, trigger.review.inputHashes).length) { stop('Workflow revision evidence changed; explicit retry and re-review required'); continue; }
    if (affected.some(task => state.sessions[task.session]?.pending || (task.reviewSession && state.sessions[task.reviewSession]?.pending))) { stop('Uncertain dispatch requires explicit reconciliation before workflow revision'); continue; }
    if (state.topic.status !== 'APPROVED') { stop('Topic approval is required before workflow revision'); continue; }
    const elapsed = Object.values(state.tasks).reduce((sum, task) => sum + task.elapsedSeconds, 0);
    if (state.pipelineGraph.revisions >= (state.config.maxWorkflowRevisions ?? 3) || state.usage.requests >= state.config.maxRequests || elapsed >= state.config.maxWallSeconds) { stop('Workflow revision or project resource budget exhausted'); continue; }
    const baseline = hashes(root, target.outputs.filter(file => fs.existsSync(local(root, file))));
    state.pipelineGraph.revisions++;
    for (const task of affected) {
      if (!task.pipeline || !activePipelineTask(state, task)) {
        if (task.acceptance === 'accepted') { task.acceptance = 'stale'; task.reasons = ['Upstream workflow revision requires revalidation']; }
        continue;
      }
      event(state, 'workflow_node_reopened', { task: task.id, cycle: state.pipelineGraph.revisions, target: request.target, reason: request.reason, previous: { execution: task.execution, acceptance: task.acceptance, attempts: task.attempts, inputHashes: task.inputHashes, outputHashes: task.outputHashes, review: task.review, checks: task.checks, researchInputs: task.researchInputs } });
      task.execution = 'pending'; task.acceptance = 'pending'; task.reasons = []; task.noProgress = 0; task.cancel = false; task.diagnosis = request.reason;
      task.inputHashes = {}; task.outputHashes = {}; task.retrievals = [];
      delete task.researchInputs; delete task.inputLookups; delete task.checks; delete task.review; delete task.reviewSession; delete task.reviewFingerprint; delete task.reviewErrors;
      delete task.pendingRework; delete task.executionCompletedAt; delete task.reworkBaseline; delete task.fingerprint; delete task.outcome;
    }
    target.reworkBaseline = baseline;
    state.sessions[target.session].inbox.push({ role: 'user', content: `Runtime workflow revision ${state.pipelineGraph.revisions}: return to ${request.target}. Reason: ${request.reason}. Change the implicated artifacts and preserve failed attempts. Do not change the approved topic or retrofit success criteria. Downstream nodes require fresh acceptance.` });
    event(state, 'workflow_revision_applied', { task: trigger.id, target: request.target, reason: request.reason, reviewSession: request.reviewSession, cycle: state.pipelineGraph.revisions });
  }
}

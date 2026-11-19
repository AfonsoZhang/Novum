import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { alive, event, identity, local, Store } from './store.js';
import { changed, hashes, invalidate } from './gates.js';
import { taskTimeLimit } from './resource-budgets.js';
import { blockers } from './workflow.js';
import { runAgent } from './agent.js';
import { researchInputs } from './research-inputs.js';
import { paperType } from './paper-types.js';
import { refreshPipelineTask, syncPipeline } from './pipeline-plan.js';
import { applyWorkflowRevisions } from './loop-transitions.js';
import { Limited, UncertainDispatch } from './model.js';
import type { State, Task } from './types.js';
import { dispatchAllowed } from './execution-control.js';

export function usedSeconds(s: State): number { return Object.values(s.tasks).reduce((sum, t) => sum + t.elapsedSeconds + (t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0), 0); }

function memoryMb(pid: number, seen = new Set<number>()): number {
  if (seen.has(pid)) return 0; seen.add(pid);
  try {
    const rss = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) / 1024;
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    return rss + children.reduce((sum, child) => sum + memoryMb(child, seen), 0);
  } catch { return 0; }
}

export function overlaps(a: Task, b: Task): boolean {
  const overlapsPath = (x: string, y: string) => x === y || x.startsWith(y.replace(/\/$/, '') + '/') || y.startsWith(x.replace(/\/$/, '') + '/');
  return a.session === b.session || a.writes.some(x => [...b.writes, ...b.inputs].some(y => overlapsPath(x, y))) || b.writes.some(x => a.inputs.some(y => overlapsPath(x, y)));
}
function stopChildren(task: Task): void {
  for (const child of task.children) if (alive(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
}
export async function reconcile(store: Store): Promise<void> {
  await store.update(s => {
    invalidate(store.root, s);
    for (const task of Object.values(s.tasks)) {
      if (task.startedAt && task.execution !== 'running' && !alive(task.worker)) { task.elapsedSeconds += Math.max(0, ((task.heartbeat ?? task.startedAt) - task.startedAt) / 1000); delete task.startedAt; }
      if (task.execution !== 'running') continue;
      const living = alive(task.worker);
      const stalled = living && task.heartbeat && Date.now() - task.heartbeat > s.config.heartbeatTimeoutMs;
      if (living && !stalled) continue;
      if (stalled && task.worker) { try { process.kill(-task.worker.pid, 'SIGKILL'); } catch {} }
      stopChildren(task); task.children = []; task.execution = task.cancel || s.executionControl?.status === 'terminated' ? 'cancelled' : 'interrupted'; task.acceptance = 'blocked';
      task.reasons = [stalled ? 'Worker heartbeat expired; stopped and requires recovery' : 'Worker is no longer alive; inspect saved events and pending requests before retry'];
      if (task.startedAt) task.elapsedSeconds += Math.max(0, ((task.heartbeat ?? task.startedAt) - task.startedAt) / 1000);
      delete task.startedAt;
      event(s, 'worker_interrupted', { task: task.id, pending: s.sessions[task.session].pending ?? null });
    }
  });
}
export async function tick(store: Store, skillRoot: string, runId?: string): Promise<string[]> {
  await reconcile(store);
  return store.update(s => {
    if (!dispatchAllowed(s) || (runId && s.scheduler?.id !== runId)) return [];
    syncPipeline(s);
    applyWorkflowRevisions(s, store.root);
    const started: string[] = [];
    const running = Object.values(s.tasks).filter(t => t.startedAt && alive(t.worker));
    for (const task of Object.values(s.tasks)) {
      if (task.execution !== 'pending') continue;
      refreshPipelineTask(s, task);
      task.reasons = blockers(s, task.id); if (task.reasons.length) continue;
      if (usedSeconds(s) >= s.config.maxWallSeconds || s.usage.requests >= s.config.maxRequests) {
        task.execution = 'limited'; task.outcome = 'inconclusive'; task.reasons = ['Project resource budget exhausted']; continue;
      }
      if (running.length >= s.config.maxParallel || running.some(other => overlaps(task, other))) continue;
      const missingInputs = task.inputs.filter(name => !fs.existsSync(local(store.root, name)));
      if (missingInputs.length) { task.reasons = missingInputs.map(name => `Missing input: ${name}`); continue; }
      if (!task.reviewOnly) {
        task.inputHashes = hashes(store.root, task.inputs); task.topicVersion = s.topic.version;
        task.researchInputs = structuredClone(researchInputs(s)); delete task.inputLookups;
      }
      delete task.reviewStartedAt; task.reviewElapsedSeconds = 0;
      task.paperType = paperType(s);
      task.execution = 'running'; task.acceptance = 'pending'; task.lease = randomUUID(); task.attempts++; task.startedAt = Date.now(); task.heartbeat = Date.now(); task.cancel = false;
      s.startedAt ??= Date.now();
      const log = path.join(store.runtime, 'logs', `${task.id}-worker.log`); fs.mkdirSync(path.dirname(log), { recursive: true }); const fd = fs.openSync(log, 'a', 0o600);
      // Child waits on this record's lock, so it cannot run before the reservation is durable.
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), store.file, task.id, task.lease, skillRoot], { cwd: store.root, detached: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
      child.on('error', () => {}); child.unref(); task.worker = child.pid ? identity(child.pid) : undefined;
      if (!task.worker) { task.execution = 'failed'; task.reasons = ['Worker failed before startup']; }
      else { running.push(task); started.push(task.id); }
      event(s, 'task_dispatched', { task: task.id, sessionId: task.session, attempt: task.attempts, lease: task.lease, worker: task.worker, log });
    }
    return started;
  });
}

export async function worker(store: Store, id: string, lease: string, skillRoot: string): Promise<void> {
  const claim = await store.update(s => {
    const task = s.tasks[id];
    if (!task || task.lease !== lease || task.execution !== 'running' || task.worker?.pid !== process.pid) return false;
    event(s, 'worker_started', { task: id, attempt: task.attempts, sessionId: task.session, lease, worker: identity() }); return true;
  });
  if (!claim) return;
  const controller = new AbortController();
  let limited = false; let pendingPulse: Promise<void> | undefined;
  const persistPulse = async () => {
    try {
      await store.update(s => {
        const t = s.tasks[id]; t.heartbeat = Date.now();
        const memory = memoryMb(process.pid); t.peakMemoryMb = Math.max(t.peakMemoryMb ?? 0, memory);
        const limitReason = memory > s.config.maxMemoryMb ? 'Memory resource budget exhausted' : taskTimeLimit(s, t);
        if (limitReason) limited = true;
        if (t.requiresTopic && (s.topic.status !== 'APPROVED' || t.topicVersion !== s.topic.version)) controller.abort(new Error('Topic approval changed during execution'));
        if (limited || t.cancel || s.executionControl?.status === 'terminated' || t.lease !== lease) controller.abort(new Error(limitReason ?? (limited ? 'Resource budget exhausted' : 'Cancelled')));
      });
    } catch { controller.abort(new Error('Heartbeat persistence failed')); }
  };
  const pulse = () => pendingPulse ??= persistPulse().finally(() => { pendingPulse = undefined; });
  // Leave room for other writers; scale down for explicitly short heartbeat
  // timeouts. Cancellation and resource checks still run on every heartbeat.
  const heartbeatInterval = Math.max(1, Math.min(2000, Math.floor(store.read().config.heartbeatTimeoutMs / 4)));
  const timer = setInterval(() => { void pulse(); }, heartbeatInterval);
  const interrupt = () => controller.abort(new Error('Worker interrupted'));
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try {
    await pulse(); controller.signal.throwIfAborted();
    await runAgent(store, id, skillRoot, controller.signal);
  } catch (error) {
    await store.update(s => {
      const t = s.tasks[id]; t.execution = t.cancel || s.executionControl?.status === 'terminated' ? 'cancelled' : limited || error instanceof Limited ? 'limited' : controller.signal.aborted ? 'cancelled' : error instanceof UncertainDispatch ? 'interrupted' : 'failed';
      t.acceptance = 'blocked'; t.outcome = 'inconclusive'; t.reasons.push(String(error));
      event(s, 'task_stopped', { task: id, attempt: t.attempts, lease, execution: t.execution, error: String(error) });
    });
  } finally {
    clearInterval(timer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    await pendingPulse;
    await store.update(s => { const t = s.tasks[id]; stopChildren(t); t.children = []; t.elapsedSeconds += (Date.now() - t.startedAt!) / 1000; delete t.startedAt; event(s, 'worker_finished', { task: id, attempt: t.attempts, lease, execution: t.execution, elapsedSeconds: t.elapsedSeconds }); });
  }
}

export async function cancel(store: Store, id: string): Promise<void> {
  await store.update(s => { const t = s.tasks[id]; if (!t) throw new Error('Unknown task'); t.cancel = true; if (t.execution === 'pending') t.execution = 'cancelled'; event(s, 'cancel_requested', { task: id }); });
}
export async function retry(store: Store, id: string, diagnosis: string, reconcileNote?: string, reviewOnly = false): Promise<void> {
  await reconcile(store);
  await store.update(s => {
    const t = s.tasks[id]; if (!t || t.execution === 'running' || alive(t.worker)) throw new Error('Cannot retry a live/unknown task');
    if (s.executionControl?.status === 'terminated' && Object.values(s.tasks).some(task => task.startedAt || task.execution === 'running')) throw new Error('Wait for terminated workers to finish before retry');
    if (!diagnosis.trim()) throw new Error('A concrete diagnosis or changed approach is required');
    if (reviewOnly && (!t.executionCompletedAt || !t.review || t.review.verdict !== 'ERROR'
      || !t.outputs.every(name => t.outputHashes[name]) || changed(store.root, { ...t.inputHashes, ...t.outputHashes, ...t.review.inputHashes }).length
      || s.sessions[t.session].inbox.length)) throw new Error('Review-only retry requires unchanged completed artifacts, a failed review, and no pending executor steering');
    const sessions = [t.session, t.reviewSession].filter((x): x is string => !!x);
    for (const id of sessions) {
      const session = s.sessions[id];
      if (session.pending) {
        if (!reconcileNote?.trim()) throw new Error('Uncertain dispatch: inspect evidence and provide an explicit reconciliation note');
        // Close incomplete tool batches with explicit unknown outcomes; never replay a side effect.
        const lastAssistant = session.messages.findLastIndex(m => !!m.tool_calls?.length);
        if (lastAssistant >= 0) for (const call of session.messages[lastAssistant].tool_calls ?? []) {
          if (!session.messages.slice(lastAssistant + 1).some(m => m.tool_call_id === call.id)) session.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'unknown', reconciliation: reconcileNote, instruction: 'Inspect artifacts before any new action. This call was not replayed.' }) });
        }
        event(s, 'uncertain_dispatch_reconciled', { session: id, pending: session.pending, note: reconcileNote }); delete session.pending;
      }
    }
    t.execution = 'pending'; t.acceptance = 'pending'; t.noProgress = 0; t.diagnosis = diagnosis; t.reasons = []; t.cancel = false;
    t.reviewOnly = reviewOnly; delete t.reviewStartedAt; t.reviewElapsedSeconds = 0;
    delete t.pendingRework;
    syncPipeline(s);
    refreshPipelineTask(s, t);
    if (!reviewOnly) s.sessions[t.session].inbox.push({ role: 'user', content: `Changed approach for retry: ${diagnosis}` });
    event(s, 'retry_authorized', { task: id, diagnosis, reviewOnly });
    if (s.executionControl?.status === 'terminated') {
      s.executionControl = { status: 'running', revision: s.executionControl.revision + 1, updatedAt: new Date().toISOString() };
      event(s, 'execution_reopened', { task: id, reason: 'Explicit diagnosed retry after termination' });
    }
  });
}

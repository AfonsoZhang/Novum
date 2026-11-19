import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { alive, event, identity, isLockContention, local, Store } from './store.js';
import { blockers, initializePipeline } from './workflow.js';
import { activePipelineTask } from './pipeline-plan.js';
import { invalidate } from './gates.js';
import { researchGoal, researchInputs } from './research-inputs.js';
import { reconcile, tick, usedSeconds } from './scheduler.js';
import type { State } from './types.js';
import type { RunControl } from '../web/types.js';
import { dispatchAllowed } from './execution-control.js';

export const defaultSkillRoot = fileURLToPath(new URL('../../.claude/skills', import.meta.url));
const running = (state: State) => !!state.scheduler && ['starting', 'running'].includes(state.scheduler.status) && alive(state.scheduler.process);
export class StartError extends Error { constructor(message: string, readonly status = 409) { super(message); } }

/** Read-only projection; preflight must not initialize tasks or rewrite stale evidence. */
export function runControl(state: State, root?: string, skillRoot = defaultSkillRoot): RunControl {
  const active = Object.values(state.tasks).some(task => task.execution === 'running' || task.startedAt);
  const cancellable = Object.values(state.tasks).some(task => task.execution === 'pending' || task.pendingRework) || active || running(state);
  const result = (status: RunControl['status'], canStart: boolean, label: string, reason: string): RunControl => ({ status, canStart, label, reason, startedAt: state.scheduler?.startedAt, endedAt: state.scheduler?.endedAt,
    canPause: dispatchAllowed(state) && (active || running(state)), canResume: false,
    canTerminate: state.executionControl?.status !== 'terminated' && cancellable,
    revision: state.executionControl?.revision ?? 0, runId: state.scheduler?.id ?? null });
  if (state.executionControl?.status === 'terminated') return result(active ? 'terminating' : 'terminated', false, active ? '正在终止…' : '已终止', active ? '已停止派发，正在取消运行中的任务及其子进程。' : '本轮研究已终止，产物和 Trace 已保留。重新执行需先通过 retry 提供修复方案；不会自动重跑。');
  if (state.executionControl?.status === 'paused') {
    const next = runControl({ ...state, executionControl: undefined }, root, skillRoot);
    const canResume = next.canStart || next.status === 'running';
    return { ...result(active ? 'pausing' : 'paused', false, '已暂停', active ? '已暂停派发；当前任务继续执行至结束，之后不启动新任务。' : '已暂停，可点击“继续”恢复任务派发。'), canResume,
      ...(!canResume ? { reason: `已暂停。${next.reason}` } : {}) };
  }
  if (running(state)) return result('running', false, state.scheduler!.status === 'starting' ? '正在启动…' : '运行中', '后台调度已启动，进度和 Subagent 调用会实时更新。');
  if (state.initialization?.status === 'running') return result('blocked', false, '一键启动', alive(state.initialization.process) ? '项目正在初始化，可先编辑研究输入；初始化结束后再启动研究。' : '项目初始化已中断，请先重试初始化。');
  if (!researchGoal(state)) return result('blocked', false, '一键启动', '请先添加论文种子：研究方向、工程问题或参考论文。');
  const projected = structuredClone(state);
  if (root) invalidate(root, projected);
  const empty = !Object.keys(projected.tasks).length;
  if (empty && projected.mode === 'on_demand') return result('blocked', false, '一键启动', '按需模式尚无任务，请先通过 CLI 添加一个任务。');
  if (empty) initializePipeline(projected);
  const tasks = Object.values(projected.tasks).filter(task => activePipelineTask(projected, task) || task.execution === 'running');
  const unsettled = tasks.some(task => task.execution === 'running' || task.startedAt || task.pendingRework);
  if (!unsettled && projected.topic.status === 'AWAITING_TOPIC_APPROVAL') return result('waiting_approval', false, '等待选题确认', '请先查看选题报告并通过 approve-topic 明确确认，再继续启动。');
  if (tasks.length && tasks.every(task => task.acceptance === 'accepted')) return result('completed', false, '已完成', '当前工作流的全部任务已通过验收。');
  if (!unsettled && (usedSeconds(projected) >= projected.config.maxWallSeconds || projected.usage.requests >= projected.config.maxRequests)) return result('blocked', false, '一键启动', '项目资源额度已用尽，请先通过 CLI 调整已授权的额度。');
  const ready = tasks.filter(task => task.execution === 'pending' && !blockers(projected, task.id).length);
  if (!unsettled && !ready.length) return result('blocked', false, '一键启动', '暂无可执行任务。请处理等待条件；失败或过期任务需要先通过 retry 提供修复方案。');
  if (!unsettled && root && ready.every(task => task.inputs.some(file => !fs.existsSync(local(root, file))))) return result('blocked', false, '一键启动', '待执行任务缺少输入文件，请补齐后启动。');
  if (!process.env[projected.config.executor.apiKeyEnv]) return result('unavailable', false, '一键启动', '执行模型凭据未配置，请按 runtime 配置设置环境变量并重启看板。');
  if (!process.env[projected.config.reviewer.apiKeyEnv]) return result('unavailable', false, '一键启动', '审查模型凭据未配置，请按 runtime 配置设置环境变量并重启看板。');
  for (const skill of new Set(tasks.filter(task => task.execution === 'pending').flatMap(task => task.skills))) {
    if (!/^[a-z0-9-]+$/.test(skill) || !fs.existsSync(path.join(skillRoot, skill, 'SKILL.md'))) return result('unavailable', false, '一键启动', `缺少运行所需的技能：${skill}。请检查看板的 --skills 路径。`);
  }
  return result('ready', true, state.scheduler || unsettled ? '继续启动' : '一键启动', empty ? '启动后自动创建工作流，并按当前研究输入开始选题。' : '执行当前可运行的任务；遇到选题确认或资源限制时停止。');
}

/** The project lock serializes launch reservations across browsers and dashboard servers. */
export async function launchScheduler(store: Store, skillRoot: string, expectedRevision: number, topicVersion: number) {
  return store.update(state => {
    if (!dispatchAllowed(state)) throw new StartError(runControl(state, store.root, skillRoot).reason);
    if (running(state)) return { started: false, alreadyRunning: true, runId: state.scheduler!.id };
    if (researchInputs(state).revision !== expectedRevision || state.topic.version !== topicVersion) throw new StartError('研究输入或选题状态已更新，请刷新看板后启动。');
    const control = runControl(state, store.root, skillRoot);
    if (!control.canStart) throw new StartError(control.reason);
    return reserveScheduler(store, state, skillRoot, expectedRevision, topicVersion);
  });
}

/** Caller holds the project lock, including when replacing a drained paused runner. */
function reserveScheduler(store: Store, state: State, skillRoot: string, expectedRevision: number, topicVersion: number) {
    if (!Object.keys(state.tasks).length) initializePipeline(state);
    const id = randomUUID(); const log = path.join(store.runtime, 'logs', 'scheduler.log');
    fs.mkdirSync(path.dirname(log), { recursive: true }); const fd = fs.openSync(log, 'a', 0o600);
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(new URL('./runner.js', import.meta.url)), store.file, id, skillRoot], { cwd: store.root, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    child.on('error', () => { void store.update(current => { if (current.scheduler?.id === id) { current.scheduler.status = 'failed'; current.scheduler.endedAt = new Date().toISOString(); current.scheduler.reason = '后台调度进程启动失败。'; event(current, 'scheduler_failed', { runId: id, reason: current.scheduler.reason }); } }).catch(() => {}); });
    child.unref(); const processIdentity = child.pid ? identity(child.pid) : undefined;
    if (!processIdentity) throw new StartError('后台调度进程启动失败，请检查 runtime 安装。', 503);
    state.scheduler = { id, process: processIdentity, status: 'starting', startedAt: new Date().toISOString() };
    event(state, 'scheduler_start_requested', { runId: id, source: 'dashboard', inputRevision: expectedRevision, topicVersion, log });
    return { started: true, alreadyRunning: false, runId: id };
}

export interface ControlRequest {
  action: 'pause' | 'resume' | 'terminate'; runId: string | null; revision: number;
  expectedRevision: number; topicVersion: number;
}

/** Optimistic versions protect against stale tabs and controls for a previous run. */
export async function controlScheduler(store: Store, skillRoot: string, input: ControlRequest) {
  const result = await store.update(state => {
    if ((state.scheduler?.id ?? null) !== input.runId || (state.executionControl?.revision ?? 0) !== input.revision) throw new StartError('运行状态已变化，请刷新后重试。');
    const control = runControl(state, store.root, skillRoot);
    const allowed = input.action === 'pause' ? control.canPause : input.action === 'resume' ? control.canResume : control.canTerminate;
    if (!allowed) throw new StartError(control.reason);
    if (input.action === 'resume' && (researchInputs(state).revision !== input.expectedRevision || state.topic.version !== input.topicVersion)) throw new StartError('研究输入或选题状态已更新，请刷新后继续。');
    state.executionControl = { status: input.action === 'pause' ? 'paused' : input.action === 'terminate' ? 'terminated' : 'running', revision: input.revision + 1, updatedAt: new Date().toISOString() };
    event(state, `execution_${input.action === 'resume' ? 'resumed' : input.action === 'pause' ? 'paused' : 'terminated'}`, { runId: input.runId, revision: state.executionControl.revision, source: 'dashboard', reason: input.action === 'pause' ? 'User paused new task dispatch; active tasks drain' : input.action === 'resume' ? 'User resumed task dispatch' : 'User terminated active and queued work' });
    if (input.action === 'terminate') {
      for (const task of Object.values(state.tasks)) {
        if (task.execution !== 'pending' && task.execution !== 'running' && !task.pendingRework) continue;
        task.cancel = true; delete task.pendingRework;
        if (task.execution !== 'running') { task.execution = 'cancelled'; task.acceptance = 'blocked'; task.outcome = 'inconclusive'; }
        task.reasons = ['Project terminated by user'];
        event(state, 'cancel_requested', { task: task.id, runId: input.runId, reason: 'Project terminated by user' });
      }
    }
    if (input.action === 'resume' && !running(state)) reserveScheduler(store, state, skillRoot, input.expectedRevision, input.topicVersion);
    return { status: state.executionControl.status, revision: state.executionControl.revision, runId: state.scheduler?.id ?? null };
  });
  if (input.action === 'terminate') await reconcile(store);
  return result;
}

/** Shared by the foreground CLI and detached dashboard runner. Workers retain their own leases. */
export async function runScheduler(store: Store, skillRoot: string, options: { runId?: string; signal?: AbortSignal; onDispatch?: (ids: string[]) => void } = {}) {
  const id = options.runId ?? randomUUID();
  const claimed = await retryContention(() => store.update(state => {
    if (options.runId) {
      if (state.scheduler?.id !== id || state.scheduler.process.pid !== process.pid || !alive(state.scheduler.process)) return false;
    } else {
      if (!dispatchAllowed(state)) throw new StartError(runControl(state, store.root, skillRoot).reason);
      if (running(state)) return false;
      const own = identity(); if (!own) throw new Error('Cannot identify scheduler process');
      state.scheduler = { id, process: own, status: 'starting', startedAt: new Date().toISOString() };
    }
    state.scheduler!.status = 'running'; state.scheduler!.heartbeat = new Date().toISOString();
    event(state, 'scheduler_started', { runId: id, source: options.runId ? 'dashboard' : 'cli' }); return true;
  }));
  if (!claimed) return { alreadyRunning: true };
  let failed = false;
  try {
    while (!options.signal?.aborted) {
      const current = store.read(); if (current.scheduler?.id !== id) break;
      const before = workVersion(current);
      const dispatched = await retryContention(() => tick(store, skillRoot, id)); if (dispatched.length) options.onDispatch?.(dispatched);
      const stopped = await retryContention(() => store.update(s => {
        if (s.scheduler?.id !== id) return true;
        // Recheck under the same lock used by Resume, so it cannot revive a runner that is exiting.
        const active = Object.values(s.tasks).some(task => task.execution === 'running' || task.startedAt || (dispatchAllowed(s) && task.pendingRework));
        if (!active && workVersion(s) === before) { finishScheduler(s); return true; }
        if (Date.now() - Date.parse(s.scheduler.heartbeat ?? s.scheduler.startedAt) >= 2000) s.scheduler.heartbeat = new Date().toISOString();
        return false;
      }));
      if (stopped) break;
      try { await sleep(500, undefined, { signal: options.signal }); } catch (error) { if (!options.signal?.aborted) throw error; }
    }
  } catch (error) { failed = true; throw error; }
  finally {
    await retryContention(() => store.update(state => {
      if (state.scheduler?.id !== id || state.scheduler.status === 'stopped') return;
      finishScheduler(state, failed, options.signal?.aborted);
    }));
  }
  return { alreadyRunning: false };
}

// ELOCKED means acquisition failed before a transaction callback ran. Retry
// contention only, with a finite allowance; never replay failed model calls or
// suppress disk/permission errors. Each acquisition already waits about 10 s.
async function retryContention<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isLockContention(error) || attempt >= 2) throw error;
      await sleep(250 + Math.random() * 500);
    }
  }
}

const workVersion = (state: State) => JSON.stringify([state.executionControl?.revision, state.topic.version, Object.values(state.tasks).map(task => [task.id, task.execution, task.acceptance, task.startedAt, task.pendingRework])]);
function finishScheduler(state: State, failed = false, aborted = false) {
  const scheduler = state.scheduler!;
  scheduler.status = failed ? 'failed' : 'stopped'; scheduler.endedAt = new Date().toISOString();
  scheduler.reason = failed ? '后台调度失败，请查看运行日志。' : state.executionControl?.status === 'paused' ? '已暂停，当前任务已结束。' : state.executionControl?.status === 'terminated' ? '研究已终止。' : aborted ? '已停止继续派发；已启动的工作进程仍保留。' : state.topic.status === 'AWAITING_TOPIC_APPROVAL' ? '等待用户确认选题。' : '本轮调度结束，请查看任务验收和等待原因。';
  event(state, failed ? 'scheduler_failed' : 'scheduler_stopped', { runId: scheduler.id, reason: scheduler.reason });
}

import fs from 'node:fs';
import { alive, local } from './store.js';
import { blockers } from './workflow.js';
import { activePipelineTask } from './pipeline-plan.js';
import { overlaps, usedSeconds } from './scheduler.js';
import { stages, type State, type Task } from './types.js';
import { traceEntries } from './trace.js';
import type { AgentInvocation, TaskPhase, TaskProgress, TraceEntry, WorkerHealth, WorkflowCounts, WorkflowProgress } from '../web/types.js';

const activePhases = new Set<TaskPhase>(['preparing', 'retrieval', 'model', 'tool', 'checking', 'reviewing']);
const phaseEvents: Record<string, TaskPhase> = {
  task_dispatched: 'preparing', worker_started: 'preparing', skills_loaded: 'preparing',
  research_input_lookup_started: 'retrieval', adversarial_retrieval_started: 'retrieval', retrieval_completed: 'retrieval',
  model_request_started: 'model', model_request_completed: 'checking', tool_started: 'tool', tool_completed: 'preparing',
  process_started: 'tool', execution_artifacts_checked: 'checking', deterministic_check_started: 'checking', deterministic_check_completed: 'checking',
  independent_review_started: 'reviewing', independent_review_completed: 'checking', independent_review_failed: 'attention',
  validation_feedback: 'preparing', acceptance_blocked: 'preparing', task_accepted: 'completed', task_stopped: 'attention',
};
function phaseOf(entry: TraceEntry): TaskPhase | undefined {
  return entry.type === 'model_request_started' && entry.phase === 'reviewer' ? 'reviewing' : phaseEvents[entry.type];
}
function health(task: Task, state: State, now: number): WorkerHealth {
  if (task.execution !== 'running') return 'none';
  if (!alive(task.worker)) return 'offline';
  if (!task.heartbeat || now - task.heartbeat > state.config.heartbeatTimeoutMs) return 'late';
  return 'healthy';
}
const stoppedStatus = (execution: string): AgentInvocation['status'] => {
  if (['completed', 'failed', 'cancelled', 'limited', 'interrupted'].includes(execution)) return execution as AgentInvocation['status'];
  return 'interrupted';
};

/** A read-only projection of real task, worker and independent-review records. */
export function activitySnapshot(state: State, options: { root?: string; now?: number } = {}) {
  const now = options.now ?? Date.now(); const entries = traceEntries(state);
  const rawBySeq = new Map(state.events.map(event => [event.seq, event.data]));
  const byTask = new Map<string, TraceEntry[]>();
  for (const entry of entries) if (entry.task) { const events = byTask.get(entry.task) ?? []; events.push(entry); byTask.set(entry.task, events); }
  const tasks = Object.values(state.tasks);
  const occupied = tasks.filter(t => t.startedAt && alive(t.worker));
  const progress: Record<string, TaskProgress> = {};
  for (const task of tasks) {
    const events = byTask.get(task.id) ?? [];
    const dispatch = events.findLast(e => e.type === 'task_dispatched');
    const current = events.filter(e => e.seq >= (dispatch?.seq ?? 0) && (e.attempt === undefined || e.attempt === task.attempts));
    const step = current.findLast(e => phaseOf(e)); const workerHealth = health(task, state, now);
    const waitReasons: string[] = []; let phase: TaskPhase;
    if (task.acceptance === 'stale') phase = 'attention';
    else if (task.execution === 'running') phase = workerHealth === 'offline' ? 'offline' : workerHealth === 'late' ? 'stalled' : phaseOf(step ?? { type: '' } as TraceEntry) ?? 'preparing';
    else if (task.acceptance === 'accepted') phase = 'completed';
    else if (task.execution === 'pending') {
      waitReasons.push(...blockers(state, task.id).map(reason => reason === 'AWAITING_TOPIC_APPROVAL' ? '等待用户批准选题' : reason === 'WORKFLOW_REVISION_PENDING' ? '等待返工节点重新排队' : reason === 'WORKFLOW_NODE_RETIRED' ? '此节点属于旧论文类型流程' : reason === 'PAPER_TYPE_UNRESOLVED' ? '等待选题审查判断论文类型' : reason.replace('Unaccepted dependency: ', '等待上游验收：').replace('New diagnosis required after repeated no progress', '需要为重试记录新的诊断或方案')));
      if (usedSeconds(state) >= state.config.maxWallSeconds || state.usage.requests >= state.config.maxRequests) waitReasons.push('项目资源额度已用尽');
      if (occupied.length >= state.config.maxParallel) waitReasons.push('等待可用的并发执行名额');
      const conflicts = occupied.filter(other => other.id !== task.id && overlaps(task, other));
      if (conflicts.length) waitReasons.push(`等待会话或文件范围释放：${conflicts.map(t => t.id).join(', ')}`);
      if (options.root) for (const input of task.inputs) {
        try { if (!fs.existsSync(local(options.root, input))) waitReasons.push(`缺少输入产物：${input}`); }
        catch { waitReasons.push(`输入路径不可读取：${input}`); }
      }
      phase = waitReasons.length ? 'waiting' : 'ready';
    } else phase = task.execution === 'completed' && task.acceptance === 'pending' ? 'checking' : 'attention';
    const detail = phase === 'offline' ? '工作进程已离线，等待恢复检查' : phase === 'stalled' ? '工作进程心跳超时' : task.execution === 'pending' ? '' : step?.summary ?? '';
    progress[task.id] = { phase, detail, since: task.execution === 'pending' ? undefined : step?.time, waitReasons, health: workerHealth, lastEventSeq: events.at(-1)?.seq };
  }

  const agents = new Map<string, AgentInvocation>();
  const executorId = (task: string, attempt: number) => `executor:${task}:${attempt}`;
  const ensureExecutor = (task: Task, attempt: number): AgentInvocation => {
    const id = executorId(task.id, attempt); let agent = agents.get(id);
    if (!agent) {
      agent = { id, parentId: 'scheduler', task: task.id, attempt, role: 'executor', mode: 'session', session: task.session, status: 'queued', phase: 'preparing', detail: '', elapsedSeconds: 0, health: 'none', processCount: 0, calls: { model: 0, tools: 0, inputTokens: 0, outputTokens: 0, unknown: 0, reusedReviews: 0 } };
      agents.set(id, agent);
    }
    return agent;
  };
  for (const entry of entries) {
    if (!entry.task) continue; const task = state.tasks[entry.task];
    const raw = rawBySeq.get(entry.seq) ?? {};
    const attempt = entry.attempt ?? (entry.type === 'task_added' ? 0 : task.attempts);
    if (!attempt && !['skills_loaded', 'model_request_started', 'independent_review_started'].includes(entry.type)) continue;
    if (entry.type === 'task_added' || entry.type === 'topic_approved') continue;
    const executor = ensureExecutor(task, attempt);
    if (entry.type === 'task_dispatched' || entry.type === 'worker_started' || entry.type === 'skills_loaded') {
      executor.startedAt ??= entry.time; executor.status = 'running';
      if (entry.type !== 'skills_loaded') executor.mode = 'process';
      const worker = raw.worker as { pid?: number } | undefined; if (worker?.pid) executor.pid = worker.pid;
    }
    const reviewerId = entry.session ? `reviewer:${entry.session}` : undefined;
    if (entry.type === 'independent_review_started' && reviewerId) {
      agents.set(reviewerId, { id: reviewerId, parentId: executor.id, task: task.id, attempt, role: 'reviewer', mode: 'session', session: entry.session!, status: 'running', phase: 'reviewing', detail: '', startedAt: entry.time, elapsedSeconds: 0, health: 'none', processCount: 0, model: entry.model, calls: { model: 0, tools: 0, inputTokens: 0, outputTokens: 0, unknown: 0, reusedReviews: 0 } });
    }
    const agent = reviewerId && agents.has(reviewerId) ? agents.get(reviewerId)! : executor;
    agent.lastEventSeq = entry.seq; if (entry.model) agent.model = entry.model;
    if (entry.type === 'model_request_started') { agent.calls.model++; agent.status = 'running'; agent.startedAt ??= entry.time; }
    if (entry.type === 'tool_started') agent.calls.tools++;
    if (entry.type === 'model_request_failed' && entry.status === 'uncertain') agent.calls.unknown++;
    if (entry.tokens) { agent.calls.inputTokens += entry.tokens.input; agent.calls.outputTokens += entry.tokens.output; }
    if (entry.type === 'independent_review_reused') agent.calls.reusedReviews++;
    if (phaseOf(entry)) { agent.phase = phaseOf(entry)!; agent.detail = entry.summary; }
    if (agent.role === 'reviewer' && ['independent_review_completed', 'independent_review_failed', 'model_request_failed'].includes(entry.type)) {
      agent.status = entry.status === 'uncertain' ? 'uncertain' : entry.status === 'blocked' ? 'blocked' : entry.status === 'failed' ? 'failed' : 'completed';
      agent.finishedAt = entry.time; agent.verdict = ['PASS', 'WARN', 'BLOCKED', 'FAIL', 'ERROR', 'NOT_APPLICABLE'].includes(String(raw.verdict)) ? String(raw.verdict) : undefined;
    }
    if (entry.type === 'task_stopped' || entry.type === 'worker_finished' || entry.type === 'task_accepted' || entry.type === 'worker_interrupted') {
      executor.status = entry.type === 'task_accepted' ? 'completed' : stoppedStatus(typeof raw.execution === 'string' ? raw.execution : entry.type === 'worker_finished' && executor.status !== 'running' ? executor.status : 'interrupted');
      executor.finishedAt = entry.time;
    }
  }
  for (const task of tasks) {
    // Retrying queues a future attempt; it does not reopen the previous invocation.
    if (task.execution === 'pending') continue;
    if (!task.attempts && ![...agents.values()].some(agent => agent.task === task.id)) continue;
    const executor = ensureExecutor(task, task.attempts); const current = progress[task.id];
    if (task.worker) { executor.pid = task.worker.pid; executor.mode = 'process'; }
    executor.startedAt ??= task.startedAt ? new Date(task.startedAt).toISOString() : undefined;
    executor.phase = current.phase; executor.detail = current.detail; executor.health = current.health; executor.heartbeat = task.heartbeat;
    executor.processCount = task.children.filter(child => alive(child)).length;
    executor.lastEventSeq = current.lastEventSeq;
    executor.status = task.execution === 'running' ? current.health === 'offline' ? 'offline' : current.health === 'late' ? 'interrupted' : 'running' : stoppedStatus(task.execution);
    if (task.execution === 'running') delete executor.finishedAt;
    for (const reviewer of agents.values()) if (reviewer.parentId === executor.id && reviewer.role === 'reviewer' && reviewer.status === 'running') {
      reviewer.health = current.health; reviewer.heartbeat = task.heartbeat;
      if (task.execution !== 'running' || ['offline', 'late'].includes(current.health)) reviewer.status = 'interrupted';
    }
  }
  for (const agent of agents.values()) {
    const task = state.tasks[agent.task];
    // An unfinished old session cannot remain live after retry or parent exit.
    if (agent.status === 'running' && (agent.attempt !== task.attempts || task.execution !== 'running')) agent.status = 'interrupted';
    if (!agent.startedAt) continue;
    const lastEvent = agent.lastEventSeq ? state.events.find(e => e.seq === agent.lastEventSeq)?.time : undefined;
    const end = agent.finishedAt ? Date.parse(agent.finishedAt) : agent.status === 'running' ? now : Date.parse(lastEvent ?? agent.startedAt);
    agent.elapsedSeconds = Math.max(0, (end - Date.parse(agent.startedAt)) / 1000);
  }
  const counts = (subset: Task[]): WorkflowCounts => ({
    total: subset.length, executed: subset.filter(t => t.execution === 'completed').length, accepted: subset.filter(t => t.acceptance === 'accepted').length,
    active: subset.filter(t => t.execution === 'running' && activePhases.has(progress[t.id].phase)).length,
    blocked: subset.filter(t => ['attention', 'offline', 'stalled'].includes(progress[t.id].phase)).length,
    ready: subset.filter(t => progress[t.id].phase === 'ready').length, waiting: subset.filter(t => progress[t.id].phase === 'waiting').length,
  });
  const visible = tasks.filter(task => activePipelineTask(state, task) || task.execution === 'running');
  const totals = counts(visible); const invocations = [...agents.values()];
  const workflow: WorkflowProgress = { ...totals,
    status: !totals.total ? 'empty' : totals.active ? 'running' : totals.blocked ? 'attention' : state.topic.status === 'AWAITING_TOPIC_APPROVAL' ? 'waiting_approval' : totals.accepted === totals.total && state.topic.status === 'APPROVED' ? 'completed' : totals.ready ? 'ready' : 'waiting',
    stages: stages.map(stage => ({ stage, ...counts(visible.filter(t => t.stage === stage)) })),
    activeTaskIds: tasks.filter(t => t.execution === 'running' && activePhases.has(progress[t.id].phase)).map(t => t.id),
    activeExecutors: invocations.filter(a => a.role === 'executor' && a.status === 'running').length,
    activeReviewers: invocations.filter(a => a.role === 'reviewer' && a.status === 'running').length,
  };
  return { progress, workflow, agents: invocations };
}

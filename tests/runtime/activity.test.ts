import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activitySnapshot } from '../../src/activity.js';
import { testState } from './fixtures.js';
import { event, identity } from '../../src/store.js';

function fixture() {
  const state = testState(); const task = state.tasks.experiment;
  state.events = []; state.tasks = { experiment: task }; state.topic.status = 'APPROVED';
  task.execution = 'running'; task.attempts = 1;
  task.dependencies = []; task.worker = identity(); task.heartbeat = Date.now(); task.startedAt = Date.now() - 5000;
  return { state, task };
}

test('workflow counts execution and acceptance separately and projects live phases from real events', () => {
  const { state, task } = fixture();
  event(state, 'task_dispatched', { task: task.id, attempt: 1, worker: task.worker });
  for (const [type, phase] of [['research_input_lookup_started', 'retrieval'], ['model_request_started', 'model'], ['tool_started', 'tool'], ['deterministic_check_started', 'checking'], ['independent_review_started', 'reviewing']]) {
    event(state, type, { task: task.id });
    const projected = activitySnapshot(state); assert.equal(projected.progress[task.id].phase, phase); assert.equal(projected.workflow.active, 1);
  }
  task.execution = 'completed'; task.acceptance = 'blocked';
  let projected = activitySnapshot(state); assert.equal(projected.workflow.executed, 1); assert.equal(projected.workflow.accepted, 0); assert.equal(projected.workflow.status, 'attention');
  task.acceptance = 'accepted'; projected = activitySnapshot(state); assert.equal(projected.workflow.status, 'completed'); assert.equal(projected.workflow.stages.find(s => s.stage === 'experiment')!.accepted, 1);
  task.acceptance = 'stale'; assert.equal(activitySnapshot(state).workflow.accepted, 0);
});

test('review sessions are children of their executor attempt with independent call and token accounting', () => {
  const { state, task } = fixture();
  event(state, 'task_dispatched', { task: task.id, attempt: 1, worker: task.worker });
  event(state, 'model_request_started', { task: task.id, requestId: 'exec', sessionId: task.session, model: 'executor', phase: 'executor' });
  event(state, 'model_request_completed', { requestId: 'exec', usage: { prompt_tokens: 11, completion_tokens: 4 } });
  event(state, 'tool_started', { task: task.id, call: { id: 'tool1', function: { name: 'read_file' } } });
  event(state, 'independent_review_started', { task: task.id, session: 'review1', model: 'reviewer' });
  event(state, 'model_request_started', { task: task.id, requestId: 'review', sessionId: 'review1', model: 'reviewer', phase: 'reviewer' });
  let projection = activitySnapshot(state); const executor = projection.agents.find(a => a.role === 'executor')!; let reviewer = projection.agents.find(a => a.role === 'reviewer')!;
  assert.equal(reviewer.parentId, executor.id); assert.equal(executor.mode, 'process'); assert.equal(executor.pid, process.pid); assert.equal(reviewer.mode, 'session'); assert.equal(reviewer.pid, undefined);
  assert.equal(executor.calls.model, 1); assert.equal(executor.calls.tools, 1); assert.equal(executor.calls.inputTokens, 11); assert.equal(reviewer.calls.model, 1); assert.equal(reviewer.calls.inputTokens, 0);
  assert.equal(projection.workflow.activeReviewers, 1); assert.equal(projection.progress[task.id].phase, 'reviewing');
  event(state, 'model_request_completed', { requestId: 'review', usage: { prompt_tokens: 20, completion_tokens: 8 } });
  event(state, 'independent_review_completed', { task: task.id, session: 'review1', verdict: 'BLOCKED' });
  event(state, 'independent_review_reused', { task: task.id, session: 'review1' });
  projection = activitySnapshot(state); reviewer = projection.agents.find(a => a.role === 'reviewer')!;
  assert.equal(reviewer.status, 'blocked'); assert.equal(reviewer.verdict, 'BLOCKED'); assert.equal(reviewer.calls.inputTokens, 20); assert.equal(reviewer.calls.reusedReviews, 1); assert.equal(projection.workflow.activeReviewers, 0);
});

test('retry and stale review records do not fabricate live agents or reopen a closed attempt', () => {
  const { state, task } = fixture();
  event(state, 'task_dispatched', { task: task.id, attempt: 1 });
  event(state, 'independent_review_started', { task: task.id, session: 'review1', attempt: 1 });
  event(state, 'model_request_started', { task: task.id, requestId: 'r1', sessionId: 'review1', attempt: 1 });
  event(state, 'model_request_failed', { requestId: 'r1', uncertain: true });
  event(state, 'independent_review_failed', { task: task.id, session: 'review1', attempt: 1, uncertain: true });
  event(state, 'worker_finished', { task: task.id, attempt: 1, execution: 'interrupted' });
  task.execution = 'pending';
  let projected = activitySnapshot(state);
  assert.equal(projected.workflow.activeExecutors, 0); assert.equal(projected.workflow.activeReviewers, 0); assert.equal(projected.agents.length, 2);
  assert.equal(projected.agents[0].status, 'interrupted'); assert.equal(projected.agents[1].status, 'uncertain'); assert.equal(projected.agents[1].calls.unknown, 1);
  task.attempts = 2; task.execution = 'running';
  event(state, 'task_dispatched', { task: task.id, attempt: 2 });
  event(state, 'independent_review_started', { task: task.id, session: 'review2', attempt: 2 });
  projected = activitySnapshot(state); assert.equal(projected.agents.length, 4); assert.equal(projected.workflow.activeExecutors, 1); assert.equal(projected.workflow.activeReviewers, 1);
  assert.equal(projected.agents.find(a => a.session === 'review2')!.parentId, 'executor:experiment:2');
  // A legacy review without an end event must not remain live after its parent exits.
  state.events = state.events.filter(e => !['model_request_failed', 'independent_review_failed'].includes(e.type));
  assert.equal(activitySnapshot(state).agents.find(a => a.session === 'review1')!.status, 'interrupted');
});

test('heartbeat timeout and process identity produce attention without mutating or reconciling workers', () => {
  const { state, task } = fixture(); const now = Date.now();
  event(state, 'task_dispatched', { task: task.id, attempt: 1 });
  event(state, 'independent_review_started', { task: task.id, session: 'r1' });
  task.heartbeat = now - state.config.heartbeatTimeoutMs - 1; const before = structuredClone(state);
  let projected = activitySnapshot(state, { now }); assert.equal(projected.progress[task.id].phase, 'stalled'); assert.equal(projected.workflow.active, 0); assert.equal(projected.workflow.blocked, 1); assert.equal(projected.workflow.activeReviewers, 0); assert.deepEqual(state, before);
  task.worker = { pid: 99999999, start: 'gone' }; projected = activitySnapshot(state, { now }); assert.equal(projected.progress[task.id].phase, 'offline'); assert.equal(projected.agents[0].status, 'offline');
  task.worker = identity(); task.heartbeat = now; projected = activitySnapshot(state, { now }); assert.equal(projected.workflow.activeReviewers, 1); assert.equal(projected.progress[task.id].health, 'healthy');
  task.worker = undefined; assert.equal(activitySnapshot(state).progress[task.id].health, 'offline');
});

test('pending tasks explain topic, dependency, file, capacity, overlap, budget and diagnosis waits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-activity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = testState(); state.topic.status = 'AWAITING_TOPIC_APPROVAL';
  state.researchInputs!.paperType = 'empirical';
  const active = state.tasks.experiment; active.execution = 'running'; active.startedAt = Date.now(); active.heartbeat = Date.now(); active.worker = identity();
  const pending = state.tasks.analysis; pending.dependencies = ['experiment']; pending.inputs = ['missing.md']; pending.noProgress = state.config.maxNoProgress;
  state.config.maxParallel = 1; state.usage.requests = state.config.maxRequests;
  let projected = activitySnapshot(state, { root }); const reasons = projected.progress.analysis.waitReasons.join('\n');
  for (const expected of ['批准选题', '上游验收', '缺少输入产物', '并发执行名额', '会话或文件范围', '资源额度', '诊断']) assert.ok(reasons.includes(expected), reasons);
  pending.attempts = 0; state.tasks = { analysis: pending }; state.events = []; pending.noProgress = 0; pending.inputs = []; pending.dependencies = []; state.topic.status = 'APPROVED'; state.usage.requests = 0;
  projected = activitySnapshot(state, { root }); assert.equal(projected.workflow.status, 'ready'); assert.equal(projected.workflow.ready, 1); assert.deepEqual(projected.agents, []);
});

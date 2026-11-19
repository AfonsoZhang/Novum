import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../../src/dashboard.js';
import { testConfig } from './fixtures.js';
import { Store, event, identity } from '../../src/store.js';
import { addTask } from '../../src/workflow.js';
import type { DashboardSnapshot } from '../../web/types.js';

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-stream-')); const store = new Store(path.join(root, 'project.json'));
  await store.init('Live workflow fixture', testConfig());
  await addTask(store, { id: 'topic', stage: 'topic', prompt: 'Inspect topic', outputs: ['topic.md'], writes: ['topic.md'], requiresTopic: false });
  const server = await startDashboard({ record: store.file, port: 0 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); } };
  const connections: AbortController[] = [];
  t.after(async () => { connections.forEach(c => c.abort()); await close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function connect() {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(server.url + '/api/stream', { signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
    async function next(predicate: (type: string, data: DashboardSnapshot) => boolean) {
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1]; const raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (type && raw) { const data = JSON.parse(raw); if (predicate(type, data)) return data as DashboardSnapshot; }
          } else {
            const part = await reader.read(); if (part.done) throw new Error('Stream closed before expected frame');
            buffer += decoder.decode(part.value, { stream: true });
          }
        }
      } finally { clearTimeout(timeout); }
    }
    return { next, reader, close: () => controller.abort() };
  }
  return { ...server, close, root, store, connect };
}

test('stream pushes atomic workflow and reviewer transitions, remains read-only, and reconnects at latest state', async t => {
  const { store, connect } = await fixture(t); const before = fs.readFileSync(store.file);
  const stream = await connect(); let frame = await stream.next(type => type === 'snapshot');
  assert.equal(frame.workflow.ready, 1); assert.deepEqual(frame.agents, []); assert.deepEqual(fs.readFileSync(store.file), before);
  await store.update(s => {
    const task = s.tasks.topic; task.execution = 'running'; task.attempts = 1; task.worker = identity(); task.startedAt = Date.now(); task.heartbeat = Date.now();
    event(s, 'task_dispatched', { task: 'topic', attempt: 1, worker: task.worker });
    event(s, 'independent_review_started', { task: 'topic', session: 'review-live', attempt: 1 });
    event(s, 'model_request_started', { task: 'topic', sessionId: 'review-live', requestId: 'r-live', phase: 'reviewer', attempt: 1 });
  });
  frame = await stream.next((type, s) => type === 'snapshot' && s.workflow.activeReviewers === 1);
  assert.equal(frame.tasks[0].progress.phase, 'reviewing'); assert.equal(frame.agents.find(a => a.role === 'reviewer')!.parentId, 'executor:topic:1');
  stream.close();
  await store.update(s => {
    const task = s.tasks.topic; task.execution = 'completed'; task.acceptance = 'blocked';
    event(s, 'independent_review_completed', { task: 'topic', session: 'review-live', attempt: 1, verdict: 'BLOCKED' });
    event(s, 'worker_finished', { task: 'topic', attempt: 1, execution: 'completed' });
  });
  const reconnected = await connect(); frame = await reconnected.next(type => type === 'snapshot');
  assert.equal(frame.workflow.activeReviewers, 0); assert.equal(frame.workflow.executed, 1); assert.equal(frame.workflow.accepted, 0); assert.equal(frame.agents.find(a => a.role === 'reviewer')!.status, 'blocked');
});

test('stream reports unavailable records, automatically recovers, and does not create missing files', async t => {
  const { store, connect } = await fixture(t); const saved = fs.readFileSync(store.file); const stream = await connect(); await stream.next(type => type === 'snapshot');
  fs.unlinkSync(store.file);
  await stream.next(type => type === 'unavailable'); assert.equal(fs.existsSync(store.file), false);
  fs.writeFileSync(store.file, saved); const frame = await stream.next(type => type === 'snapshot'); assert.equal(frame.goal, 'Live workflow fixture');
  assert.deepEqual(fs.readFileSync(store.file), saved);
});

test('large snapshots survive backpressure and the stream keeps delivering subsequent snapshots', async t => {
  const { store, connect } = await fixture(t);
  await store.update(s => { s.goal = 'A'.repeat(200000); });
  const stream = await connect(); const first = await stream.next(type => type === 'snapshot'); assert.equal(first.goal.length, 200000);
  await store.update(s => { s.goal = 'B'.repeat(200000); });
  const next = await stream.next((type, s) => type === 'snapshot' && s.goal[0] === 'B'); assert.equal(next.goal.length, 200000);
});

test('heartbeat loss appears without new events and stream shutdown closes active clients', async t => {
  const { store, connect, close } = await fixture(t);
  await store.update(s => { s.config.heartbeatTimeoutMs = 300; const task = s.tasks.topic; task.execution = 'running'; task.attempts = 1; task.worker = identity(); task.heartbeat = Date.now(); });
  const stream = await connect(); await stream.next((type, s) => type === 'snapshot' && s.tasks[0].progress.health === 'late');
  await close();
  const timeout = setTimeout(stream.close, 2000);
  try { while (!(await stream.reader.read()).done) { /* Drain queued frames. */ } } finally { clearTimeout(timeout); }
});

test('stream preserves dashboard same-origin and read-only method boundaries', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(url + '/api/stream', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(url + '/api/stream', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/api/stream', { method: 'HEAD' })).status, 200);
});

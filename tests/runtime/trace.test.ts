import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, event } from '../../src/store.js';
import { testConfig, testState } from './fixtures.js';
import { startDashboard } from '../../src/dashboard.js';
import { tracePage, traceDetail } from '../../src/trace.js';
import { addTask } from '../../src/workflow.js';
import { request, UncertainDispatch, type Model } from '../../src/model.js';

async function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-trace-')); const store = new Store(path.join(root, 'project.json'));
  await store.init('Trace fixture', testConfig(), 'automatic');
  for (const id of ['first', 'second']) await addTask(store, { id, stage: 'topic', session: 'main', prompt: id, outputs: [id + '.md'], writes: [id + '.md'], requiresTopic: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, store };
}

test('model traces record task/attempt and exact request boundaries even after a shared session grows', async t => {
  const { store } = await project(t);
  await store.update(s => { s.tasks.first.attempts = 1; s.sessions.main.messages.push({ role: 'user', content: 'First input' }); });
  const model: Model = { async complete() { return { message: { role: 'assistant', content: 'First reply' }, usage: { prompt_tokens: 10, completion_tokens: 4 } }; } };
  await request(store, 'main', store.read().config.executor, model, [], new AbortController().signal, { task: 'first', phase: 'executor' });
  await store.update(s => { s.sessions.main.messages.push({ role: 'user', content: 'FUTURE_TASK_INPUT' }); s.tasks.second.attempts = 2; });
  await request(store, 'main', store.read().config.executor, model, [], new AbortController().signal, { task: 'second', phase: 'executor' });
  const state = store.read(); const events = tracePage(state, { task: 'first', category: 'model' }).entries;
  assert.equal(events.length, 2); assert.ok(events.every(e => e.attempt === 1));
  assert.deepEqual(events[1].tokens, { input: 10, output: 4 }); assert.equal(events[1].model, 'test-executor');
  const detail = traceDetail(state, events[1].seq, 'first');
  const input = detail.sections.find(s => s.title === '发送给模型的消息')!;
  assert.deepEqual(JSON.parse(input.text), [{ role: 'user', content: 'First input' }]);
  assert.match(detail.sections.find(s => s.title === '模型返回')!.text, /First reply/);
  assert.doesNotMatch(JSON.stringify(detail), /FUTURE_TASK_INPUT/);
  assert.equal(tracePage(state, { task: 'second', attempt: 1, category: 'model' }).total, 0);
  assert.equal(tracePage(state, { task: 'second', attempt: 2, category: 'model' }).total, 2);
});

test('legacy traces use event-time session/request ownership and never invent missing message boundaries', () => {
  const state = testState(); state.events = [];
  state.sessions.main.messages = [{ role: 'user', content: 'CURRENT_SESSION_MUST_NOT_BE_GUESSED' }];
  event(state, 'task_dispatched', { task: 'plan' });
  event(state, 'model_request_started', { requestId: 'old-a', sessionId: 'main', model: 'old-model' });
  event(state, 'task_dispatched', { task: 'writing' });
  event(state, 'model_request_started', { requestId: 'old-b', sessionId: 'main', model: 'old-model' });
  event(state, 'model_request_completed', { requestId: 'old-a', sessionId: 'main' });
  event(state, 'model_request_failed', { requestId: 'old-b', message: 'Failure', uncertain: true });
  event(state, 'independent_review_started', { task: 'plan', session: 'historical-review' });
  event(state, 'model_request_started', { requestId: 'old-review', sessionId: 'historical-review', model: 'review-model' });
  assert.equal(tracePage(state, { task: 'plan', category: 'model' }).total, 3);
  assert.equal(tracePage(state, { task: 'writing', category: 'model' }).total, 2);
  assert.equal(tracePage(state, { task: 'writing' }).entries.at(-1)?.status, 'uncertain');
  const detail = traceDetail(state, 5, 'plan'); assert.ok(detail.notes.some(n => n.includes('消息边界')));
  assert.doesNotMatch(JSON.stringify(detail), /CURRENT_SESSION_MUST_NOT_BE_GUESSED/);
});

test('trace pagination covers the complete history beyond the overview event window without duplicates', () => {
  const state = testState(); state.events = [];
  for (let i = 0; i < 351; i++) event(state, 'validation_feedback', { task: i % 2 ? 'plan' : 'writing', content: 'Event ' + i });
  const seen: number[] = []; let before: number | undefined;
  do {
    const page = tracePage(state, { before, limit: 37 }); assert.equal(page.total, 351); assert.ok(page.entries.length <= 37);
    assert.deepEqual(page.entries.map(e => e.seq), page.entries.map(e => e.seq).sort((a, b) => a - b));
    seen.push(...page.entries.map(e => e.seq)); before = page.nextBefore ?? undefined;
  } while (before !== undefined);
  assert.equal(seen.length, 351); assert.equal(new Set(seen).size, 351); assert.equal(Math.min(...seen), 1);
  assert.ok(tracePage(state, { task: 'plan', category: 'check' }).entries.every(e => e.task === 'plan'));
});

test('tool tracing pairs repeated call IDs within task attempts and distinguishes failure and review blockage', () => {
  const state = testState(); state.events = [];
  event(state, 'task_dispatched', { task: 'robustness', attempt: 1 });
  event(state, 'tool_started', { task: 'robustness', call: { id: 'same', function: { name: 'read_file', arguments: '{"path":"first.txt"}' } } });
  event(state, 'tool_completed', { task: 'robustness', id: 'same', result: 'First output' });
  event(state, 'task_dispatched', { task: 'robustness', attempt: 2 });
  event(state, 'tool_started', { task: 'robustness', call: { id: 'same', function: { name: 'read_file', arguments: '{"path":"second.txt"}' } } });
  event(state, 'tool_completed', { task: 'robustness', id: 'same', result: { error: 'Missing second file' } });
  state.events[4].time = '2026-11-03T00:00:00.000Z'; state.events[5].time = '2026-11-03T00:00:01.250Z';
  event(state, 'independent_review_completed', { task: 'robustness', verdict: 'BLOCKED', errors: ['Evidence missing'] });
  const detail = traceDetail(state, 6, 'robustness');
  assert.equal(detail.entry.attempt, 2); assert.equal(detail.entry.durationMs, 1250); assert.equal(detail.entry.status, 'failed');
  assert.match(JSON.stringify(detail), /second.txt/); assert.doesNotMatch(JSON.stringify(detail), /first.txt|First output/);
  assert.equal(tracePage(state, { category: 'review' }).entries[0].status, 'blocked');
});

test('trace payloads redact credentials, omit provider reasoning fields, and bound large content', async t => {
  const { store } = await project(t); const env = 'TRACE_TEST_CREDENTIAL'; const previous = process.env[env];
  process.env[env] = 'trace-secret-fixture-value'; t.after(() => { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; });
  await store.update(s => {
    s.config.executor.apiKeyEnv = env; s.sessions.main.messages.push({ role: 'user', content: 'Credentials: trace-secret-fixture-value' });
    event(s, 'tool_started', { task: 'first', call: { id: 'large', function: { name: 'fixture', arguments: '{"apiKey":"nested-secret"}' } } });
    event(s, 'tool_completed', { task: 'first', id: 'large', result: { token: 'structured-secret', text: 'trace-secret-fixture-value https://example.test/?token=url-secret ' + '界'.repeat(150000) } });
  });
  const model: Model = { async complete() { return { message: { role: 'assistant', content: 'public response', reasoning_content: 'REASONING_SENTINEL' } as unknown as import('../../src/types.js').Message }; } };
  await request(store, 'main', store.read().config.executor, model, [], new AbortController().signal, { task: 'first', phase: 'executor' });
  const state = store.read(); const tool = state.events.find(e => e.type === 'tool_completed')!;
  const detail = traceDetail(state, tool.seq); const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /trace-secret-fixture-value|nested-secret|structured-secret|url-secret/);
  assert.ok(detail.sections.some(s => s.truncated)); assert.ok(Buffer.byteLength(serialized) < 200000);
  const modelDetail = traceDetail(state, state.events.at(-1)!.seq);
  assert.doesNotMatch(JSON.stringify(modelDetail), /REASONING_SENTINEL|trace-secret-fixture-value/); assert.match(JSON.stringify(modelDetail), /public response/);
});

test('an uncertain model failure has trace input and failure details without a fabricated response', async t => {
  const { store } = await project(t); await store.update(s => { s.sessions.main.messages.push({ role: 'user', content: 'Input before failure' }); });
  const model: Model = { async complete() { throw new UncertainDispatch('Transport uncertain'); } };
  await assert.rejects(request(store, 'main', store.read().config.executor, model, [], new AbortController().signal, { task: 'first', phase: 'executor' }), /Transport uncertain/);
  const detail = traceDetail(store.read(), store.read().events.at(-1)!.seq);
  assert.equal(detail.entry.status, 'uncertain'); assert.match(JSON.stringify(detail), /Input before failure|Transport uncertain/);
  assert.ok(!detail.sections.some(section => section.title === '模型返回'));
  assert.equal(store.read().sessions.main.pending?.kind, 'model');
});

test('trace APIs are read-only, task-scoped, bounded and validated', async t => {
  const { store } = await project(t); const server = await startDashboard({ record: store.file, port: 0 });
  t.after(() => server.close());
  await store.update(s => { event(s, 'validation_feedback', { task: 'first', content: '<script>untrusted()</script>' }); });
  const before = fs.readFileSync(store.file); const list = await fetch(server.url + '/api/trace?task=first');
  assert.equal(list.status, 200); const data = await list.json(); const seq = data.entries.at(-1).seq;
  const detail = await fetch(server.url + `/api/trace/event?task=first&seq=${seq}`); assert.equal(detail.status, 200);
  assert.match((await detail.json()).sections[0].text, /<script>untrusted/);
  assert.equal((await fetch(server.url + `/api/trace/event?task=second&seq=${seq}`)).status, 404);
  for (const query of ['limit=1000', 'before=-2', 'attempt=-1', 'category=unknown', 'extra=x']) assert.equal((await fetch(server.url + '/api/trace?' + query)).status, 400);
  assert.equal((await fetch(server.url + '/api/trace?task=unknown')).status, 404);
  assert.equal((await fetch(server.url + '/api/trace/event')).status, 400);
  assert.equal((await fetch(server.url + '/api/trace', { method: 'POST' })).status, 405);
  assert.equal((await fetch(server.url + '/api/trace', { headers: { Origin: 'https://foreign.test' } })).status, 403);
  assert.deepEqual(fs.readFileSync(store.file), before);
});

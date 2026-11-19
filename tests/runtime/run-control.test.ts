import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, alive, identity } from '../../src/store.js';
import { configSchema } from '../../src/types.js';
import { startDashboard } from '../../src/dashboard.js';
import { defaultSkillRoot, launchScheduler, runControl, runScheduler } from '../../src/run-control.js';
import { addTask } from '../../src/workflow.js';

const key = 'START_BUTTON_FIXTURE_KEY';
const route = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'fixture', apiKeyEnv: key };
const headers = { 'Content-Type': 'application/json', 'X-Research-Control': '1' };
async function setup(t: test.TestContext, url?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-button-')); const store = new Store(path.join(root, 'project.json'));
  const previous = process.env[key]; process.env[key] = 'fixture-only';
  await store.init('Bounded fixture topic', configSchema.parse({ executor: { ...route, baseUrl: url ?? route.baseUrl }, maxRequests: 20, maxTaskSeconds: 20 }));
  t.after(async () => {
    const state = store.read();
    for (const child of [state.scheduler?.process, ...Object.values(state.tasks).map(task => task.worker)]) if (child?.pid !== process.pid && alive(child)) { try { process.kill(-child!.pid, 'SIGKILL'); } catch {} }
    await sleep(50); fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  });
  return { store, root };
}
async function until(check: () => boolean) { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture runtime timed out'); await sleep(25); } }
const start = (url: string, revision = 0, topicVersion = 0) => fetch(url + '/api/run', { method: 'POST', headers, body: JSON.stringify({ expectedRevision: revision, topicVersion }) });

test('one click initializes the graph once, survives dashboard shutdown and stops at explicit topic approval', async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const provider = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk; const body = JSON.parse(data); calls++;
    let message;
    if (!body.tools) message = { role: 'assistant', content: JSON.stringify({ verdict: 'PASS', summary: 'Fixture topic checked', challenges: [], resolvedChallengeIds: [], limitations: [], paperType: { type: 'theory', reason: 'The fixture contribution is a bounded formal statement.' } }) };
    else if (!body.messages.some((entry: { role: string }) => entry.role === 'tool')) {
      await held;
      message = { role: 'assistant', content: '', tool_calls: [{ id: 'write-topic', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'research/topic.md', content: 'Fixture formal research proposal for explicit user approval.' }) } }] };
    } else message = { role: 'assistant', content: 'Ready for independent review.' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); provider.close(); provider.closeAllConnections(); });
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const { store, root } = await setup(t, providerUrl);
  const dashboards = await Promise.all([startDashboard({ record: store.file, port: 0 }), startDashboard({ record: store.file, port: 0 })]);
  t.after(async () => { for (const dashboard of dashboards) await dashboard.close().catch(() => {}); });
  const before = fs.readFileSync(store.file); const shown = await (await fetch(dashboards[0].url + '/api/state')).json();
  assert.equal(shown.runControl.canStart, true); assert.deepEqual(fs.readFileSync(store.file), before);
  const replies = await Promise.all(dashboards.flatMap(dashboard => [start(dashboard.url), start(dashboard.url)]));
  assert.equal(replies.filter(reply => reply.status === 202).length, 1);
  assert.equal(replies.filter(reply => reply.status === 200).length, 3);
  const results = await Promise.all(replies.map(reply => reply.json())); assert.equal(new Set(results.map(result => result.runId)).size, 1);
  await until(() => calls > 0);
  assert.equal((await runScheduler(store, defaultSkillRoot)).alreadyRunning, true, 'CLI and dashboard share launch ownership');
  const live = store.read(); assert.equal(live.tasks.topic.attempts, 1); assert.equal(live.events.filter(event => event.type === 'scheduler_started').length, 1);
  assert.equal(runControl(live, root).status, 'running');
  await dashboards[0].close(); assert.ok(alive(store.read().scheduler?.process));
  release();
  await until(() => store.read().scheduler?.status === 'stopped');
  const state = store.read(); assert.equal(state.topic.status, 'AWAITING_TOPIC_APPROVAL'); assert.equal(state.tasks.topic.acceptance, 'accepted');
  assert.equal(state.tasks.literature.attempts, 0); assert.equal(calls, 3);
  assert.equal((await (await fetch(dashboards[1].url + '/api/state')).json()).runControl.status, 'waiting_approval');
  assert.equal((await start(dashboards[1].url, 0, state.topic.version)).status, 409);
  await until(() => !alive(store.read().scheduler?.process));
});

test('launch preflight rejects stale inputs, missing credentials, absent skills and uninitialized on-demand graphs without mutations', async t => {
  const { store, root } = await setup(t); const before = fs.readFileSync(store.file);
  await assert.rejects(launchScheduler(store, defaultSkillRoot, 1, 0), /已更新/);
  await assert.rejects(launchScheduler(store, path.join(root, 'missing-skills'), 0, 0), /缺少.*技能/);
  delete process.env[key]; await assert.rejects(launchScheduler(store, defaultSkillRoot, 0, 0), /凭据/);
  assert.deepEqual(fs.readFileSync(store.file), before);
  process.env[key] = 'fixture-only'; await store.update(state => { state.mode = 'on_demand'; });
  await assert.rejects(launchScheduler(store, defaultSkillRoot, 0, 0), /按需模式/);
  assert.equal(Object.keys(store.read().tasks).length, 0);
  await addTask(store, { id: 'topic', stage: 'topic', prompt: 'Scoped fixture work', outputs: ['topic.md'], writes: ['topic.md'], requiresTopic: false });
  assert.equal(runControl(store.read(), root).canStart, true, 'Existing on-demand tasks remain launchable');
  await store.update(state => { state.usage.requests = state.config.maxRequests; });
  assert.equal(runControl(store.read(), root).canStart, false);
});

test('start API requires an explicit bounded same-origin POST', async t => {
  const { store } = await setup(t); const dashboard = await startDashboard({ record: store.file, port: 0 });
  t.after(async () => { await dashboard.close(); });
  const before = fs.readFileSync(store.file);
  assert.equal((await fetch(dashboard.url + '/api/run')).status, 405);
  assert.equal((await fetch(dashboard.url + '/api/run', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(dashboard.url + '/api/run', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  for (const body of ['{}', 'not-json', JSON.stringify({ expectedRevision: 0, topicVersion: 0, command: 'anything' })]) {
    assert.equal((await fetch(dashboard.url + '/api/run', { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await fetch(dashboard.url + '/api/run', { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual(fs.readFileSync(store.file), before); assert.equal(store.read().scheduler, undefined);
});

test('stale scheduler identities allow recovery while live reservations prevent another launch', async t => {
  const { store, root } = await setup(t);
  const own = identity()!;
  await store.update(state => { state.scheduler = { id: 'stale', process: { pid: own.pid, start: 'previous-process' }, status: 'running', startedAt: new Date().toISOString() }; });
  assert.equal(runControl(store.read(), root).canStart, true);
  await store.update(state => { state.scheduler!.process = own; });
  assert.equal(runControl(store.read(), root).canStart, false);
  assert.equal((await launchScheduler(store, defaultSkillRoot, 0, 0)).alreadyRunning, true);
  await store.update(state => { state.scheduler!.status = 'stopped'; });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, alive, identity } from '../../src/store.js';
import { configSchema } from '../../src/types.js';
import { addTask, approveTopic } from '../../src/workflow.js';
import { startDashboard } from '../../src/dashboard.js';
import { controlScheduler, defaultSkillRoot, launchScheduler, runControl, runScheduler, type ControlRequest } from '../../src/run-control.js';
import { tick, retry } from '../../src/scheduler.js';
import { request } from '../../src/model.js';
import { builtins } from '../../src/tools.js';

const headers = { 'Content-Type': 'application/json', 'X-Research-Control': '1' };
async function until(check: () => boolean) { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() > deadline) throw new Error('Control fixture timed out'); await sleep(25); } }
async function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-control-')); const store = new Store(path.join(root, 'project.json'));
  const releases = new Map<string, () => void>(); const calls: string[] = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const pack = body.messages.flatMap((m: { content: string }) => { try { const data = JSON.parse(m.content); return data.task ? [data] : []; } catch { return []; } })[0];
    const id = pack.task.id as string; calls.push(id);
    let message;
    if (!body.tools) message = { role: 'assistant', content: JSON.stringify({ verdict: 'PASS', summary: 'Bounded fixture checked', challenges: [], resolvedChallengeIds: [], limitations: [] }) };
    else if (!body.messages.some((m: { role: string }) => m.role === 'tool')) {
      await new Promise<void>(resolve => releases.set(id, resolve));
      message = { role: 'assistant', content: '', tool_calls: [{ id: `write-${id}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `${id}.md`, content: `Retained fixture artifact for ${id}` }) } }] };
    } else message = { role: 'assistant', content: 'Ready for review.' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const key = 'EXECUTION_CONTROL_FIXTURE_KEY'; const previous = process.env[key]; process.env[key] = 'fixture-only';
  await store.init('Bounded execution-control fixture', configSchema.parse({ executor: { baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, model: 'fixture', family: 'fixture', apiKeyEnv: key }, maxParallel: 1, maxTaskSeconds: 60 }), 'automatic', { paperType: 'theory', seedPapers: [], targetJournal: null });
  for (const id of ['first', 'second']) await addTask(store, { id, stage: 'topic', session: id, prompt: 'Scoped fixture topic', outputs: [`${id}.md`], writes: [`${id}.md`], requiresTopic: false, dependencies: id === 'second' ? ['first'] : [] });
  t.after(async () => {
    const state = store.read();
    for (const child of [state.scheduler?.process, ...Object.values(state.tasks).flatMap(task => [task.worker, ...task.children])]) if (child?.pid !== process.pid && alive(child)) { try { process.kill(-child!.pid, 'SIGKILL'); } catch {} }
    for (const release of releases.values()) release(); provider.close(); provider.closeAllConnections();
    await sleep(60); fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  });
  return { store, root, calls, release: (id: string) => releases.get(id)?.() };
}
function input(store: Store, action: ControlRequest['action']): ControlRequest {
  const state = store.read(); return { action, runId: state.scheduler?.id ?? null, revision: state.executionControl?.revision ?? 0, expectedRevision: state.researchInputs!.revision, topicVersion: state.topic.version };
}
const post = (url: string, value: ControlRequest, extra = {}) => fetch(url + '/api/run/control', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });

test('pause drains active work, persists across dashboards, blocks CLI dispatch and resumes exactly once', async t => {
  const { store, root, calls, release } = await setup(t);
  const dashboard = await startDashboard({ record: store.file, port: 0 }); t.after(() => dashboard.close());
  await launchScheduler(store, defaultSkillRoot, 1, 0); await until(() => calls.length === 1);
  const originalRun = store.read().scheduler!.id;
  assert.equal((await post(dashboard.url, input(store, 'pause'))).status, 200);
  assert.equal(runControl(store.read(), root).status, 'pausing');
  assert.equal(store.read().tasks.first.cancel, false);
  assert.deepEqual(await tick(store, defaultSkillRoot), []);
  await assert.rejects(runScheduler(store, defaultSkillRoot), /暂停/);
  await assert.rejects(launchScheduler(store, defaultSkillRoot, 1, 0), /暂停/);
  release('first'); await until(() => store.read().scheduler?.status === 'stopped');
  assert.equal(store.read().tasks.first.acceptance, 'accepted'); assert.equal(store.read().tasks.second.attempts, 0);
  assert.equal(calls.length, 3); assert.equal(runControl(store.read(), root).status, 'paused');
  assert.equal(runControl(store.read(), root).canResume, false, 'Pause does not authorize a topic');
  const reopened = await startDashboard({ record: store.file, port: 0 }); t.after(() => reopened.close());
  assert.equal((await (await fetch(reopened.url + '/api/state')).json()).runControl.status, 'paused');
  await approveTopic(store, store.read().topic.version, 'Explicit fixture approval');
  const resume = input(store, 'resume');
  const responses = await Promise.all([post(dashboard.url, resume), post(reopened.url, resume)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await until(() => calls.length === 4);
  assert.notEqual(store.read().scheduler!.id, originalRun); assert.equal(store.read().tasks.second.attempts, 1);
  const nextRun = store.read().scheduler!.id;
  await controlScheduler(store, defaultSkillRoot, input(store, 'pause'));
  await controlScheduler(store, defaultSkillRoot, input(store, 'resume'));
  assert.equal(store.read().scheduler!.id, nextRun, 'Resume reuses a draining scheduler');
  release('second'); await until(() => store.read().scheduler?.status === 'stopped');
  assert.equal(store.read().tasks.second.acceptance, 'accepted'); assert.equal(calls.length, 6);
  assert.ok(fs.existsSync(path.join(root, 'first.md')));
});

test('terminate aborts the active model and child process, cancels queued work and preserves artifacts and trace', async t => {
  const { store, root, calls } = await setup(t);
  const dashboard = await startDashboard({ record: store.file, port: 0 }); t.after(() => dashboard.close());
  await launchScheduler(store, defaultSkillRoot, 1, 0); await until(() => calls.length === 1);
  fs.writeFileSync(path.join(root, 'retained.md'), 'Keep prior evidence');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();
  const tracked = identity(child.pid!)!; t.after(() => { if (alive(tracked)) { try { process.kill(-tracked.pid, 'SIGKILL'); } catch {} } });
  await store.update(s => { s.tasks.first.children.push(tracked); });
  const stale = input(store, 'terminate');
  assert.equal((await post(dashboard.url, stale)).status, 200);
  assert.equal(runControl(store.read(), root).status, 'terminating');
  assert.deepEqual(await tick(store, defaultSkillRoot), []);
  await until(() => store.read().scheduler?.status === 'stopped' && !alive(tracked));
  const state = store.read(); assert.equal(state.executionControl?.status, 'terminated');
  assert.equal(state.tasks.first.execution, 'cancelled'); assert.equal(state.tasks.second.execution, 'cancelled');
  assert.equal(state.tasks.second.attempts, 0); assert.equal(calls.length, 1);
  assert.equal(runControl(state, root).status, 'terminated'); assert.equal(runControl(state, root).canStart, false);
  assert.ok(state.events.some(e => e.type === 'execution_terminated')); assert.ok(state.events.some(e => e.type === 'model_request_failed'));
  assert.equal(fs.readFileSync(path.join(root, 'retained.md'), 'utf8'), 'Keep prior evidence');
  assert.equal((await post(dashboard.url, stale)).status, 409);
  await assert.rejects(launchScheduler(store, defaultSkillRoot, 1, 0), /终止/);
  await assert.rejects(runScheduler(store, defaultSkillRoot), /终止/);
  await until(() => !alive(store.read().tasks.first.worker));
  await assert.rejects(retry(store, 'first', 'Inspect cancelled transport'), /Uncertain dispatch/);
  await retry(store, 'first', 'Inspect retained artifacts before another attempt', 'Fixture provider was cancelled; no tool ran');
  assert.equal(store.read().executionControl?.status, 'running'); assert.equal(store.read().tasks.first.execution, 'pending');
  assert.equal(store.read().tasks.second.execution, 'cancelled', 'Retry reopens only the explicitly selected task');
});

test('control API validates origin, method, bounds, project and run versions without mutating rejected requests', async t => {
  const { store } = await setup(t); const dashboard = await startDashboard({ record: store.file, port: 0, workspace: true }); t.after(() => dashboard.close());
  const before = fs.readFileSync(store.file); const value = input(store, 'terminate');
  const workspaceHeaders = { ...headers, 'X-Research-Workspace': encodeURIComponent(store.file) };
  assert.equal((await fetch(dashboard.url + '/api/run/control')).status, 405);
  assert.equal((await post(dashboard.url, value)).status, 409, 'Workspace identity is required');
  assert.equal((await post(dashboard.url, value, { ...workspaceHeaders, Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await fetch(dashboard.url + '/api/run/control', { method: 'POST', headers: { 'X-Research-Workspace': encodeURIComponent(store.file) }, body: '{}' })).status, 403);
  for (const body of ['{}', 'not-json', JSON.stringify({ ...value, command: 'extra' })]) assert.equal((await fetch(dashboard.url + '/api/run/control', { method: 'POST', headers: workspaceHeaders, body })).status, 400);
  assert.equal((await fetch(dashboard.url + '/api/run/control', { method: 'POST', headers: workspaceHeaders, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await post(dashboard.url, { ...value, runId: 'old-run' }, workspaceHeaders)).status, 409);
  assert.equal((await post(dashboard.url, { ...value, revision: 5 }, workspaceHeaders)).status, 409);
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal((await post(dashboard.url, value, workspaceHeaders)).status, 200);
  assert.equal(store.read().tasks.first.execution, 'cancelled');
});

test('termination closes model and tool boundaries before heartbeat cancellation arrives', async t => {
  const { store, root } = await setup(t);
  await controlScheduler(store, defaultSkillRoot, input(store, 'terminate'));
  const signal = new AbortController().signal; let modelCalls = 0;
  const state = store.read(); const before = state.usage.requests;
  await assert.rejects(request(store, 'first', state.config.executor, { complete: async () => { modelCalls++; return { message: { role: 'assistant', content: 'Must not run' } }; } }, [], signal, { task: 'first', phase: 'executor' }), /cancelled/);
  await assert.rejects(builtins().execute('write_file', { path: 'first.md', content: 'Must not write' }, { store, taskId: 'first', signal }), /cancelled/);
  assert.equal(modelCalls, 0); assert.equal(store.read().usage.requests, before); assert.equal(fs.existsSync(path.join(root, 'first.md')), false);
  assert.deepEqual(await tick(store, defaultSkillRoot), []);
});

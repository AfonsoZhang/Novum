import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, identity } from '../../src/store.js';
import { startWeb, browserCommands } from '../../src/web.js';
import { pipeline, blockers } from '../../src/workflow.js';
import { tick } from '../../src/scheduler.js';
import { defaultSkillRoot } from '../../src/run-control.js';
import { readBackendConfig } from '../../src/web-workspace.js';
import type { FolderPicker } from '../../src/native-folder-picker.js';

const headers = { 'Content-Type': 'application/json', 'X-Research-Control': '1' };
const config = { executor: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'fixture', apiKeyEnv: 'WEB_SETUP_UNUSED_FIXTURE_KEY' }, maxParallel: 4, maxRequests: 20 };
async function setup(t: test.TestContext, pickDirectory?: FolderPicker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-workspace-')); const record = path.join(root, 'project.json');
  const configFile = path.join(root, 'runtime.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const web = await startWeb({ record, configFile, port: 0, noOpen: true, pickDirectory });
  t.after(async () => {
    await web.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (body: unknown, extra = {}) => fetch(web.url + '/api/workspace', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { root, record, configFile, ...web, post };
}
const create = (record: string) => ({ action: 'save', record, expectedConfig: null, goal: 'A bounded research question' });

test('removed demo CLI flags cannot start a server or create a project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-cli-')); const record = path.join(root, 'project.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const command of ['web', 'dashboard']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../src/cli.js', import.meta.url)), command, '--demo', '--record', record, '--port', '0'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option '--demo'/); assert.equal(fs.existsSync(record), false);
  }
});

test('web starts a real empty workspace without creating a project, model calls or demo data', async t => {
  const { url, record, browser } = await setup(t);
  const info = await (await fetch(url + '/api/workspace')).json(); assert.equal(info.status, 'new'); assert.equal(info.record, record); assert.equal(info.limits, undefined);
  const stateResponse = await fetch(url + '/api/state'); assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json(); assert.equal(state.workspace.needsSetup, true); assert.equal(state.demo, undefined);
  assert.equal(fs.existsSync(record), false); assert.deepEqual(browser, { opened: false, reason: 'disabled' });
  assert.equal((await fetch(url + '/workspace.js')).status, 200);
  const abort = new AbortController(); const stream = await fetch(url + '/api/stream', { signal: abort.signal });
  const reader = stream.body!.getReader(); let text = '';
  try { while (!text.includes('event: snapshot')) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } }
  finally { abort.abort(); }
  assert.match(text, /"needsSetup":true/); assert.doesNotMatch(text, /event: unavailable/);
});

test('local project picker navigates folders and JSON names without reading or changing files', async t => {
  const { root, record, post, url } = await setup(t);
  const folder = path.join(root, '研究项目 & records'); fs.mkdirSync(folder);
  const jsonFile = path.join(folder, 'existing.JSON'); fs.writeFileSync(jsonFile, 'not a project; listing must not parse this');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'private text');
  fs.writeFileSync(path.join(folder, '.secrets.json'), 'hidden secret');
  fs.mkdirSync(path.join(folder, 'child')); fs.symlinkSync(path.join(folder, 'child'), path.join(folder, 'linked-folder'));
  const first = await post({ action: 'browse' }); assert.equal(first.status, 200);
  const home = await first.json(); assert.equal(home.directory, root); assert.ok(home.locations.some((l: { name: string }) => l.name === '主目录'));
  const response = await post({ action: 'browse', directory: folder }); assert.equal(response.status, 200);
  const body = await response.text(); const listed = JSON.parse(body);
  assert.equal(listed.parent, root);
  assert.deepEqual(listed.entries.map((e: { name: string; kind: string }) => [e.name, e.kind]), [['child', 'directory'], ['linked-folder', 'directory'], ['existing.JSON', 'file']]);
  assert.equal(listed.entries[2].path, jsonFile); assert.doesNotMatch(body, /private text|hidden secret|not a project/);
  assert.equal((await post({ action: 'browse', directory: listed.parent })).status, 200);
  assert.equal((await post({ action: 'browse', directory: jsonFile })).status, 400);
  assert.equal((await post({ action: 'browse', directory: path.join(root, 'missing') })).status, 400);
  assert.equal((await fetch(url + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'browse' }) })).status, 403);
  assert.equal((await post({ action: 'browse' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ action: 'browse', goal: 'invalid extra' })).status, 400);
  assert.equal(fs.existsSync(record), false); assert.equal(fs.readFileSync(jsonFile, 'utf8'), 'not a project; listing must not parse this');
});

test('picker starts at an existing ancestor when the default project folder has not been created', async t => {
  const { root, configFile } = await setup(t);
  const record = path.join(root, 'new-parent', 'new-project', 'project.json');
  const web = await startWeb({ record, configFile, port: 0, noOpen: true }); t.after(() => web.close());
  const response = await fetch(web.url + '/api/workspace', { method: 'POST', headers, body: JSON.stringify({ action: 'browse' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).directory, root);
  assert.equal(fs.existsSync(path.dirname(record)), false);
});

test('native creation selects a parent without writes, then creates a named empty child without overwriting', async t => {
  let selected: string | null = null; const purposes: unknown[] = [];
  const { root, record, post, url } = await setup(t, async (_signal, purpose) => { purposes.push(purpose); return selected; });
  const request = { action: 'create-native' };
  assert.deepEqual(await (await post(request)).json(), { cancelled: true });
  assert.equal(fs.existsSync(record), false);
  selected = path.join(root, '用户选择的位置 & research'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'notes.txt'), 'preserve existing files');
  const picked = await post(request); assert.equal(picked.status, 200);
  const location = await picked.json(); assert.deepEqual(location, { directory: selected, record });
  assert.deepEqual(fs.readdirSync(selected), ['notes.txt']);
  assert.equal((await (await fetch(url + '/api/workspace')).json()).record, record);
  const create = { action: 'create-project', ...location, name: '真实研究 & 项目' };
  const created = await post(create); assert.equal(created.status, 200);
  const pickedRecord = path.join(selected, create.name, 'project.json');
  assert.equal((await created.json()).record, pickedRecord);
  const state = new Store(pickedRecord).read();
  assert.equal(state.goal, ''); assert.deepEqual(state.tasks, {}); assert.equal(state.usage.requests, 0);
  assert.equal(state.initialization, undefined); assert.deepEqual(state.researchInputs?.seedPapers, []);
  assert.equal(fs.existsSync(path.join(selected, 'project.json')), false);
  assert.equal(fs.readFileSync(path.join(selected, 'notes.txt'), 'utf8'), 'preserve existing files');
  const before = fs.readFileSync(pickedRecord);
  assert.equal((await post({ ...create, record: pickedRecord })).status, 409);
  assert.deepEqual(fs.readFileSync(pickedRecord), before);
  assert.equal((await post({ ...create, name: 'stale-tab-project' })).status, 409);
  assert.equal(fs.existsSync(path.join(selected, 'stale-tab-project')), false);
  selected = null; assert.deepEqual(await (await post(request)).json(), { cancelled: true });
  assert.equal((await (await fetch(url + '/api/workspace')).json()).record, pickedRecord);
  assert.deepEqual(purposes, ['create', 'create', 'create']);
  const opened = purposes.length;
  assert.equal((await post({ ...request, record: path.join(root, 'unselected.json') })).status, 400);
  assert.equal((await post(request, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await fetch(url + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 403);
  assert.equal(purposes.length, opened);
});

test('new project names cannot escape the parent or reuse existing directories, including concurrent creation', async t => {
  const { root, record, post } = await setup(t);
  const create = { action: 'create-project', record, directory: root, name: 'new' };
  for (const name of ['..', '../outside', 'nested/folder', 'nested\\folder', 'CON', 'nul.txt', 'project.', 'bad:name', '']) {
    assert.equal((await post({ ...create, name })).status, 400, name);
  }
  const existing = path.join(root, 'existing'); fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'README.md'), 'User research');
  assert.equal((await post({ ...create, name: 'existing' })).status, 409);
  assert.deepEqual(fs.readdirSync(existing), ['README.md']);
  const results = await Promise.all([post(create), post(create)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(new Store(path.join(root, 'new/project.json')).read().events.filter(event => event.type === 'project_initialized').length, 1);
});

test('only one native selector opens at a time, and a disconnected request cannot create a project', async t => {
  let enter!: () => void; let finish!: (directory: string | null) => void; let signal: AbortSignal | undefined;
  let entered = new Promise<void>(resolve => { enter = resolve; });
  const { root, url, record, post } = await setup(t, async value => { signal = value; enter(); return new Promise(resolve => { finish = resolve; }); });
  const pending = post({ action: 'create-native' }); await entered;
  const duplicate = await post({ action: 'create-native' }); assert.equal(duplicate.status, 409);
  finish(null); assert.deepEqual(await (await pending).json(), { cancelled: true });
  entered = new Promise<void>(resolve => { enter = resolve; });
  const abort = new AbortController();
  const abandoned = fetch(url + '/api/workspace', { method: 'POST', headers, body: JSON.stringify({ action: 'create-native' }), signal: abort.signal }).catch(() => undefined);
  await entered;
  const cancelled = new Promise<void>(resolve => { signal!.addEventListener('abort', () => resolve(), { once: true }); });
  abort.abort(); await cancelled;
  finish(root); await abandoned;
  assert.equal(fs.existsSync(record), false);
});

test('native picker failures and project switches leave the selected project and its files untouched', async t => {
  let finish!: (directory: string | null) => void; let enter!: () => void; let fails = true;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const { root, record, post, url } = await setup(t, async () => {
    if (fails) throw new Error('Unavailable desktop');
    enter(); return new Promise(resolve => { finish = resolve; });
  });
  assert.equal((await post({ action: 'create-native' })).status, 400); assert.equal(fs.existsSync(record), false);
  fails = false;
  const pending = post({ action: 'create-native' }); await entered;
  const other = path.join(root, 'other', 'project.json'); assert.equal((await post({ action: 'create', record: other })).status, 200);
  finish(root); assert.equal((await pending).status, 409);
  assert.equal(fs.existsSync(record), false); assert.equal((await (await fetch(url + '/api/workspace')).json()).record, other);
});

test('opening an ordinary folder runs durable initialization, retries partial failure and restores existing records without reinitializing', async t => {
  let selected = ''; let calls = 0; let fail = true;
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the bounded initialization prompt. */ }
    calls++; res.setHeader('Content-Type', 'application/json');
    if (fail) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"findings":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });
  const { root, post, url, configFile } = await setup(t, async (_signal, purpose) => { assert.equal(purpose, 'open'); return selected; });
  const key = config.executor.apiKeyEnv; const previous = process.env[key]; process.env[key] = 'fixture-only';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  fs.writeFileSync(configFile, JSON.stringify({ ...config, executor: { ...config.executor, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` } }));
  selected = path.join(root, 'ordinary-code'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'README.md'), '# Project\n\n## Engineering problem\nCached results remain stale after updates.\n');
  const humanRules = '# Project constraints\nPreserve frozen data.\n'; fs.writeFileSync(path.join(selected, 'AGENTS.md'), humanRules);
  const response = await post({ action: 'open-native' }); assert.equal(response.status, 200);
  const record = path.join(selected, 'project.json'); const store = new Store(record);
  assert.equal((await response.json()).record, record);
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 10000; while (!condition()) { if (Date.now() > deadline) throw new Error('Initialization worker timed out'); await sleep(25); } };
  await until(() => store.read().initialization?.status === 'failed');
  const partial = store.read(); assert.equal(partial.researchInputs?.seedPapers.length, 1); assert.equal(partial.tasks.topic, undefined);
  assert.equal(partial.scheduler, undefined); assert.ok(fs.readFileSync(path.join(selected, 'AGENTS.md'), 'utf8').startsWith(humanRules));
  const shown = await (await fetch(url + '/api/state')).json(); assert.equal(shown.initialization.canRetry, true); assert.ok(shown.initialization.elapsedSeconds >= 0);
  fail = false;
  assert.equal((await post({ action: 'retry-init', record, runId: partial.initialization!.id })).status, 202);
  assert.equal((await post({ action: 'retry-init', record, runId: partial.initialization!.id })).status, 409);
  await until(() => store.read().initialization?.status === 'completed');
  await until(() => store.read().initialization?.steps.every(step => step.status === 'completed') === true);
  const before = fs.readFileSync(record); const count = calls;
  assert.equal((await post({ action: 'open-native' })).status, 200);
  assert.deepEqual(fs.readFileSync(record), before); assert.equal(calls, count);
  assert.equal(store.read().researchInputs?.seedPapers.length, 1); assert.deepEqual(store.read().tasks, {});
});

test('web setup keeps model and resource configuration on the backend', async t => {
  const { record, url, post } = await setup(t);
  const response = await post(create(record)); assert.equal(response.status, 200);
  const body = await response.text(); const info = JSON.parse(body);
  assert.equal(info.status, 'ready'); assert.equal(info.backend.configured, true);
  for (const value of [config.executor.baseUrl, config.executor.model, config.executor.apiKeyEnv]) assert.ok(!body.includes(value));
  assert.equal(info.config, undefined); assert.equal(info.credentials, undefined); assert.equal(info.limits, undefined);
  const state = new Store(record).read(); assert.equal(state.mode, 'automatic'); assert.equal(state.researchInputs?.paperType, null);
  assert.equal(state.usage.requests, 0); assert.deepEqual(state.tasks, {}); assert.equal(state.topic.status, 'UNSELECTED');
  assert.equal(state.config.executor.apiKeyEnv, state.config.reviewer.apiKeyEnv);
  const shown = await (await fetch(url + '/api/state')).json(); assert.equal(shown.demo, undefined); assert.equal(shown.workspace.record, record); assert.equal(shown.resources, undefined); assert.equal(shown.usage, undefined);
  for (const field of ['tasks', 'agents', 'sources', 'claims', 'challenges']) assert.deepEqual(shown[field], []);
  assert.deepEqual(shown.researchInputs.seedPapers, []); assert.equal(shown.researchInputs.targetJournal, null);
  assert.deepEqual((await (await fetch(url + '/api/trace')).json()).entries.filter((entry: { category: string }) => entry.category === 'model' || entry.category === 'tool'), []);
  assert.equal(state.config.executor.baseUrl, config.executor.baseUrl);
  assert.equal(state.config.executor.apiKeyEnv, config.executor.apiKeyEnv);
  const before = fs.readFileSync(record);
  for (const injection of [{ config }, { credentials: { executor: 'PRIVATE_WEB_CREDENTIAL_FIXTURE' } }, { limits: { maxParallel: 2, maxRequests: 25, maxWallSeconds: 3600 } }, { maxParallel: 2 }]) assert.equal((await post({ ...create(record), expectedConfig: info.expectedConfig, ...injection })).status, 400);
  assert.deepEqual(fs.readFileSync(record), before);
  assert.equal((await post(create(record))).status, 409, 'An old creation form cannot overwrite the initialized runtime');
  assert.equal((await post({ ...create(record), expectedConfig: info.expectedConfig, goal: 'Updated research objective' })).status, 200);
  assert.deepEqual(new Store(record).read().config, state.config, 'Editing the goal must preserve every backend setting');
  assert.equal((await post({ ...create(record), expectedConfig: info.expectedConfig })).status, 409);
});

test('workspace switching rejects stale-tab writes and supports Unicode project paths', async t => {
  const { root, record, url, post } = await setup(t); assert.equal((await post(create(record))).status, 200);
  const before = fs.readFileSync(record); const other = path.join(root, '研究项目', 'project.json');
  assert.equal((await post({ action: 'create', record: other, goal: 'A separate research objective' })).status, 200);
  const edit = (target: string) => fetch(url + '/api/research-inputs', { method: 'PUT', headers: { ...headers, 'X-Research-Inputs': '1', 'X-Research-Workspace': encodeURIComponent(target) }, body: JSON.stringify({ expectedRevision: 0, inputs: { paperType: 'theory', seedPapers: [], targetJournal: null } }) });
  assert.equal((await edit(record)).status, 409); assert.equal((await edit(other)).status, 200);
  assert.equal((await post({ ...create(record), expectedConfig: (await (await fetch(url + '/api/workspace')).json()).expectedConfig })).status, 409);
  assert.deepEqual(fs.readFileSync(record), before); assert.equal(new Store(other).read().researchInputs?.paperType, 'theory');
  assert.equal((await (await fetch(url + '/api/state')).json()).workspace.record, other);
  assert.equal((await fetch(url + '/api/run', { method: 'POST', headers: { ...headers, 'X-Research-Workspace': encodeURIComponent(record) }, body: JSON.stringify({ expectedRevision: 1, topicVersion: 1 }) })).status, 409);
});

test('connect and create are distinct operations that preserve existing projects and never start research', async t => {
  const { root, record, url, post } = await setup(t);
  const missing = path.join(root, 'missing', 'project.json');
  assert.equal((await post({ action: 'open', record: missing })).status, 409);
  assert.equal(fs.existsSync(missing), false);
  assert.equal((await (await fetch(url + '/api/workspace')).json()).record, record);
  const response = await post({ action: 'create', record: missing, goal: 'Research goal entered by the user' });
  assert.equal(response.status, 200); assert.equal((await response.json()).record, missing);
  const state = new Store(missing).read(); assert.equal(state.goal, 'Research goal entered by the user');
  assert.equal(state.mode, 'automatic'); assert.deepEqual(state.tasks, {}); assert.equal(state.usage.requests, 0);
  const saved = fs.readFileSync(missing);
  assert.equal((await post({ action: 'create', record: missing, goal: 'Must not replace the goal' })).status, 409);
  assert.deepEqual(fs.readFileSync(missing), saved);
  assert.equal((await post({ action: 'open', record: missing })).status, 200);
  assert.deepEqual(fs.readFileSync(missing), saved);
  const unrelated = path.join(root, 'unrelated.json'); fs.writeFileSync(unrelated, '{"notes":"Keep this file"}');
  assert.equal((await post({ action: 'create', record: unrelated })).status, 409);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), '{"notes":"Keep this file"}');
  const concurrent = path.join(root, 'concurrent.json');
  const results = await Promise.all([post({ action: 'create', record: concurrent }), post({ action: 'create', record: concurrent })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(new Store(concurrent).read().goal, '');
  assert.equal(new Store(concurrent).read().events.filter(event => event.type === 'project_initialized').length, 1);
});

test('workspace settings enforce local requests, preserve damaged records and reject live changes', async t => {
  const { root, record, url, post } = await setup(t);
  assert.equal((await post(create(record), { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await fetch(url + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(create(record)) })).status, 403);
  assert.equal((await post({ ...create(record), limits: { maxParallel: 4, maxRequests: 30, maxWallSeconds: 3600 } })).status, 400);
  const response = await post(create(record)); const info = await response.json(); assert.equal(response.status, 200);
  const store = new Store(record); await store.update(state => { state.scheduler = { id: 'live-fixture', process: identity()!, status: 'running', startedAt: new Date().toISOString() }; });
  const before = fs.readFileSync(record); assert.equal((await post({ ...create(record), expectedConfig: info.expectedConfig, goal: 'Cannot edit while running' })).status, 409); assert.deepEqual(fs.readFileSync(record), before);
  const bad = path.join(root, 'damaged.json'); fs.writeFileSync(bad, 'Not a project record');
  assert.equal((await post({ action: 'open', record: bad })).status, 409);
  assert.equal(fs.readFileSync(bad, 'utf8'), 'Not a project record'); assert.equal((await (await fetch(url + '/api/workspace')).json()).record, record);
});

test('an omitted goal can be filled later, with start gates and stale-goal protection', async t => {
  const { record, url, post } = await setup(t);
  const response = await post({ action: 'save', record, expectedConfig: null }); assert.equal(response.status, 200);
  const initial = await response.json(); const store = new Store(record);
  assert.equal(store.read().goal, ''); assert.equal(initial.goalEditable, true);
  const shown = await (await fetch(url + '/api/state')).json(); assert.equal(shown.runControl.canStart, false); assert.match(shown.runControl.reason, /论文种子/);
  const before = fs.readFileSync(record);
  assert.equal((await fetch(url + '/api/run', { method: 'POST', headers: { ...headers, 'X-Research-Workspace': encodeURIComponent(record) }, body: JSON.stringify({ expectedRevision: 0, topicVersion: 0 }) })).status, 409);
  assert.deepEqual(fs.readFileSync(record), before);
  await pipeline(store); assert.ok(blockers(store.read(), 'topic').includes('RESEARCH_GOAL_REQUIRED'));
  assert.deepEqual(await tick(store, defaultSkillRoot), []); assert.equal(store.read().usage.requests, 0);
  assert.equal((await post({ ...create(record), expectedConfig: initial.expectedConfig, goal: '   ' })).status, 200);
  const update = await post({ ...create(record), expectedConfig: initial.expectedConfig, goal: 'A later research objective' }); assert.equal(update.status, 200);
  assert.equal(store.read().goal, 'A later research objective'); assert.ok(!blockers(store.read(), 'topic').includes('RESEARCH_GOAL_REQUIRED'));
  assert.equal((await post({ ...create(record), expectedConfig: initial.expectedConfig })).status, 409);
  await store.update(state => { state.tasks.topic.attempts = 1; state.tasks.topic.execution = 'failed'; });
  const current = await (await fetch(url + '/api/workspace')).json(); assert.equal(current.goalEditable, false);
  assert.equal((await post({ ...create(record), expectedConfig: current.expectedConfig })).status, 409);
  assert.equal(store.read().goal, 'A later research objective');
});

test('seed inputs enable new projects without a duplicate goal; removing the seeds restores the startup gate', async t => {
  const { record, url, post } = await setup(t);
  const key = config.executor.apiKeyEnv; const previous = process.env[key]; process.env[key] = 'fixture-only';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  assert.equal((await post({ action: 'create', record })).status, 200);
  const store = new Store(record); let revision = 0;
  const update = async (seedPapers: unknown[]) => {
    const response = await fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1', 'X-Research-Workspace': encodeURIComponent(record) }, body: JSON.stringify({ expectedRevision: revision, inputs: { paperType: null, seedPapers, targetJournal: null } }) });
    assert.equal(response.status, 200); revision = (await response.json()).inputs.revision;
  };
  await pipeline(store);
  for (const kind of ['direction', 'engineering_problem', 'paper']) {
    await update([{ id: 'seed', kind, title: 'A user supplied research lead', notes: 'Scope supplied by the user' }]);
    const shown = await (await fetch(url + '/api/state')).json();
    assert.equal(shown.runControl.canStart, true); assert.equal(store.read().goal, '');
    assert.ok(!blockers(store.read(), 'topic').includes('RESEARCH_GOAL_REQUIRED'));
    await update([]);
    assert.equal((await (await fetch(url + '/api/state')).json()).runControl.canStart, false);
    assert.ok(blockers(store.read(), 'topic').includes('RESEARCH_GOAL_REQUIRED'));
  }
  assert.equal(store.read().usage.requests, 0); assert.equal(store.read().scheduler, undefined);
});

test('backend setup failures leave records untouched and can recover without browser API inputs', async t => {
  const { record, configFile, url, post } = await setup(t);
  fs.writeFileSync(configFile, 'PRIVATE_INVALID_CONFIG_FIXTURE');
  const info = await (await fetch(url + '/api/workspace')).json(); assert.equal(info.backend.configured, false);
  assert.ok(!JSON.stringify(info).includes('PRIVATE_INVALID_CONFIG_FIXTURE'));
  assert.equal((await post({ action: 'save', record, expectedConfig: null, goal: '' })).status, 503);
  assert.equal(fs.existsSync(record), false);
  fs.writeFileSync(configFile, JSON.stringify({ ...config, executor: { ...config.executor, baseUrl: 'file:///etc/passwd' } }));
  assert.equal((await post(create(record))).status, 503); assert.equal(fs.existsSync(record), false);
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal((await post({ action: 'save', record, expectedConfig: null, goal: '' })).status, 200);
  fs.rmSync(configFile);
  const existing = await (await fetch(url + '/api/workspace')).json(); assert.equal(existing.backend.configured, true, 'Existing records retain their backend routes');
});

test('the backend configuration environment variable is resolved only on the server', async t => {
  const { configFile } = await setup(t); const previous = process.env.RESEARCH_RUNTIME_CONFIG;
  process.env.RESEARCH_RUNTIME_CONFIG = configFile;
  t.after(() => { if (previous === undefined) delete process.env.RESEARCH_RUNTIME_CONFIG; else process.env.RESEARCH_RUNTIME_CONFIG = previous; });
  assert.equal(readBackendConfig()?.executor.baseUrl, config.executor.baseUrl);
  assert.throws(() => readBackendConfig(configFile + '.missing'), /后端模型配置/);
});

test('browser launching uses the printed local URL for a real workspace', async t => {
  assert.throws(() => browserCommands('https://example.org/;evil'), /local Web/);
  assert.deepEqual(browserCommands('http://127.0.0.1:4317', 'darwin', false), [['open', 'http://127.0.0.1:4317']]);
  assert.equal(browserCommands('http://127.0.0.1:4317', 'linux', true)[0][0], 'wslview');
  const savedConnection = process.env.SSH_CONNECTION; const savedTTY = process.env.SSH_TTY; delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
  t.after(() => { if (savedConnection === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = savedConnection; if (savedTTY === undefined) delete process.env.SSH_TTY; else process.env.SSH_TTY = savedTTY; });
  const { record, configFile } = await setup(t);
  const opened: string[] = [];
  const web = await startWeb({ record, configFile, port: 0, launchBrowser: async url => { opened.push(url); return true; } }); t.after(() => web.close());
  assert.deepEqual(opened, [web.url]); assert.equal(web.browser.opened, true);
  assert.equal((await (await fetch(web.url + '/api/state')).json()).workspace.needsSetup, true);
  assert.equal((await (await fetch(web.url + '/api/workspace')).json()).status, 'new');
});

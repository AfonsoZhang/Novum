import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { dashboardSnapshot, startDashboard } from '../../src/dashboard.js';
import { testConfig, testState } from './fixtures.js';
import { Store, event, hash } from '../../src/store.js';
import { addTask } from '../../src/workflow.js';
import { venueCatalogSchema } from '../../src/venues.js';

async function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dashboard-'));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('A real project <script>unsafe()</script>', testConfig());
  await addTask(store, { id: 'topic', stage: 'topic', prompt: 'Inspect topic evidence', outputs: ['topic.md'], writes: ['topic.md'], requiresTopic: false });
  fs.writeFileSync(path.join(root, 'topic.md'), '# A saved topic\n<script>untrustedArtifact()</script>');
  const server = await startDashboard({ record: store.file, port: 0 });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, root, ...server };
}

test('paper lookup requires the local editor header and preserves project records for unrecognized links', async t => {
  const { store, url } = await project(t); const before = fs.readFileSync(store.file);
  assert.equal((await fetch(url + '/api/paper-reference?input=paper')).status, 403);
  const headers = { 'X-Research-Inputs': '1' };
  assert.equal((await fetch(url + '/api/paper-reference', { headers })).status, 400);
  const response = await fetch(url + '/api/paper-reference?input=' + encodeURIComponent('http://127.0.0.1/private'), { headers });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { exact: false, candidates: [] });
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal((await fetch(url + '/paper-reference.js')).status, 200);
});

test('venue catalog is served without project writes and conference, journal, custom and cleared selections persist', async t => {
  const { store, url } = await project(t); const before = fs.readFileSync(store.file);
  const response = await fetch(url + '/api/venues'); assert.equal(response.status, 200);
  const catalog = venueCatalogSchema.parse(await response.json());
  assert.ok(catalog.venues.some(venue => venue.id === 'neurips' && venue.kind === 'conference'));
  assert.ok(catalog.venues.some(venue => venue.id === 'jmlr' && venue.kind === 'journal'));
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal((await fetch(url + '/api/venues', { method: 'PUT' })).status, 405);
  assert.equal((await fetch(url + '/api/venues', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const targets = ['neurips', 'jmlr'].map(id => {
    const venue = catalog.venues.find(item => item.id === id)!;
    return { name: venue.name, url: venue.url, notes: 'Fixture submission preferences' };
  });
  targets.push({ name: 'Custom workshop', url: 'https://example.org/workshop', notes: 'Preserve custom venue' });
  for (const [revision, targetJournal] of [...targets, null].entries()) {
    const saved = await fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1' }, body: JSON.stringify({ expectedRevision: revision, inputs: { seedPapers: [], targetJournal } }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(new Store(store.file).read().researchInputs?.targetJournal, targetJournal);
    assert.deepEqual((await (await fetch(url + '/api/state')).json()).researchInputs.targetJournal, targetJournal);
  }
  assert.equal(store.read().usage.requests, 0);
});

test('venue catalog rejects duplicate identities and non-HTTPS official links', () => {
  const venue = { id: 'fixture', kind: 'conference', shortName: 'Fixture', name: 'Fixture Conference', url: 'https://example.org/' };
  const catalog = { version: 1, updatedAt: '2026-11-03', venues: [venue] };
  for (const venues of [[venue, venue], [venue, { ...venue, id: 'another' }], [{ ...venue, url: 'javascript:alert(1)' }]]) {
    assert.equal(venueCatalogSchema.safeParse({ ...catalog, venues }).success, false);
  }
});

test('dashboard serves real current state without mutating the canonical record or exposing sessions/config', async t => {
  const { store, url } = await project(t);
  await store.update(s => {
    s.sessions.main.messages.push({ role: 'user', content: 'PRIVATE_TRANSCRIPT_SENTINEL' });
    s.config.executor.apiKeyEnv = 'PRIVATE_CONFIGURATION_SENTINEL';
  });
  const before = fs.readFileSync(store.file);
  const response = await fetch(url + '/api/state'); const text = await response.text(); const data = JSON.parse(text);
  assert.equal(response.status, 200); assert.equal(data.demo, undefined); assert.equal(data.tasks.length, 1);
  assert.ok(!text.includes('PRIVATE_TRANSCRIPT_SENTINEL')); assert.ok(!text.includes('PRIVATE_CONFIGURATION_SENTINEL'));
  assert.deepEqual(fs.readFileSync(store.file), before);
  await store.update(s => { s.goal = 'Updated goal'; event(s, 'task_added', { task: 'topic' }); });
  assert.equal((await (await fetch(url + '/api/state')).json()).goal, 'Updated goal');
});

test('dashboard accurately distinguishes execution completion, blocked acceptance, stale artifacts and dead workers', async t => {
  const { store, root, url } = await project(t);
  await store.update(s => { const task = s.tasks.topic; task.execution = 'completed'; task.acceptance = 'blocked'; });
  let data = await (await fetch(url + '/api/state')).json(); assert.equal(data.tasks[0].lane, 'attention');
  await store.update(s => { const task = s.tasks.topic; task.acceptance = 'accepted'; task.outputHashes = { 'topic.md': hash(path.join(root, 'topic.md')) }; });
  data = await (await fetch(url + '/api/state')).json(); assert.equal(data.tasks[0].lane, 'done');
  fs.appendFileSync(path.join(root, 'topic.md'), '\nchanged');
  data = await (await fetch(url + '/api/state')).json(); assert.equal(data.tasks[0].acceptance, 'stale');
  assert.equal(store.read().tasks.topic.acceptance, 'accepted', 'dashboard must not persist its read-side stale projection');
  await store.update(s => { const task = s.tasks.topic; task.execution = 'running'; task.acceptance = 'pending'; task.worker = { pid: 9999999, start: 'gone' }; });
  data = await (await fetch(url + '/api/state')).json(); assert.equal(data.tasks[0].workerAlive, false); assert.equal(data.tasks[0].lane, 'attention');
});

test('only registered text artifacts are previewed; traversal, symlink escape and control record are denied', async t => {
  const { store, root, url } = await project(t);
  const preview = await fetch(url + '/api/artifact?path=topic.md');
  assert.equal(preview.headers.get('content-type'), 'application/json; charset=utf-8'); assert.match((await preview.json()).content, /untrustedArtifact/);
  for (const name of ['../outside', '/etc/passwd', '.env', 'project.json']) assert.equal((await fetch(url + '/api/artifact?path=' + encodeURIComponent(name))).status, 403);
  await store.update(s => { s.tasks.topic.outputs.push('escape.txt', 'project.json'); });
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape.txt'));
  assert.notEqual((await fetch(url + '/api/artifact?path=escape.txt')).status, 200);
  assert.equal((await fetch(url + '/api/artifact?path=project.json')).status, 403);
});

test('artifact previews are bounded and binary data is not rendered as executable content', async t => {
  const { store, root, url } = await project(t);
  fs.writeFileSync(path.join(root, 'topic.md'), 'a'.repeat(300000));
  const data = await (await fetch(url + '/api/artifact?path=topic.md')).json();
  assert.equal(data.content.length, 256 * 1024); assert.equal(data.truncated, true);
  fs.writeFileSync(path.join(root, 'topic.md'), Buffer.from([1, 0, 255]));
  assert.equal((await fetch(url + '/api/artifact?path=topic.md')).status, 415);
});

test('server rejects execution writes and foreign origins and serves a restrictive CSP', async t => {
  const { url } = await project(t);
  assert.equal((await fetch(url + '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(url + '/api/state', { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /id="workspace"/); assert.equal((await fetch(url + '/app.js')).status, 200); assert.equal((await fetch(url + '/styles.css')).status, 200);
  assert.equal((await fetch(url + '/unknown')).status, 404);
});

test('research input editor persists Unicode data, detects stale revisions and rejects non-input mutations', async t => {
  const { store, url } = await project(t);
  const inputs = { seedPapers: [{ id: 'seed-1', title: '论文种子 <script>unsafe()</script>', doi: 'https://doi.org/10.1234/test', notes: '关注点' }], targetJournal: { name: '目标期刊', url: 'https://example.org/authors', notes: '用户偏好' } };
  const put = (body: unknown, extraHeaders = {}) => fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1', ...extraHeaders }, body: JSON.stringify(body) });
  const usage = store.read().usage;
  const response = await put({ expectedRevision: 0, inputs }); assert.equal(response.status, 200);
  assert.equal(store.read().researchInputs?.seedPapers[0].doi, '10.1234/test');
  assert.equal(store.read().topic.status, 'UNSELECTED'); assert.deepEqual(store.read().usage, usage);
  const snapshot = await (await fetch(url + '/api/state')).json(); assert.equal(snapshot.researchInputs.targetJournal.name, '目标期刊');
  const saved = fs.readFileSync(store.file);
  assert.equal((await put({ expectedRevision: 0, inputs })).status, 409);
  assert.equal((await put({ expectedRevision: 1, inputs }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await fetch(url + '/api/research-inputs', { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, inputs }) })).status, 403);
  assert.equal((await put({ expectedRevision: 1, inputs: { ...inputs, mode: 'autopilot' } })).status, 400);
  assert.equal((await put({ expectedRevision: 1, inputs: { ...inputs, targetJournal: { name: 'bad', url: 'javascript:alert(1)' } } })).status, 400);
  assert.deepEqual(fs.readFileSync(store.file), saved);
  assert.equal((await put({ expectedRevision: 1, inputs: { seedPapers: [], targetJournal: null } })).status, 200);
  assert.deepEqual(store.read().researchInputs?.seedPapers, []); assert.equal(store.read().researchInputs?.targetJournal, null);
});

test('oversized research input edits leave the project unchanged', async t => {
  const { store, url } = await project(t); const before = fs.readFileSync(store.file);
  const response = await fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1' }, body: 'a'.repeat(270000) });
  assert.equal(response.status, 413); assert.deepEqual(fs.readFileSync(store.file), before);
});

test('dashboard stores directions and engineering problems alongside legacy reference papers', async t => {
  const { store, url } = await project(t);
  const inputs = { seedPapers: [
    { id: 'legacy', title: 'Existing reference paper' },
    { id: 'direction', kind: 'direction', title: '低成本证据定位', notes: '探索研究边界与评估方法' },
    { id: 'problem', kind: 'engineering_problem', title: '更新后仍引用旧资料', notes: '场景与现象由用户提供，原因尚未验证' },
  ], targetJournal: null };
  const response = await fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1' }, body: JSON.stringify({ expectedRevision: 0, inputs }) });
  assert.equal(response.status, 200); assert.deepEqual(store.read().researchInputs?.seedPapers, inputs.seedPapers);
  const data = await (await fetch(url + '/api/state')).json(); assert.deepEqual(data.researchInputs.seedPapers, inputs.seedPapers);
  assert.equal(store.read().sources && Object.keys(store.read().sources).length, 0, 'saving a reported problem does not certify it as evidence');
});

test('missing or damaged records report an unavailable state and recover on the next read', async t => {
  const { store, url } = await project(t); const original = fs.readFileSync(store.file);
  fs.writeFileSync(store.file, 'invalid'); assert.equal((await fetch(url + '/api/state')).status, 503);
  fs.writeFileSync(store.file, original); assert.equal((await fetch(url + '/api/state')).status, 200);
});

test('missing projects never return fabricated tasks, evidence, artifacts or traces', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-no-project-')); const record = path.join(root, 'project.json');
  const server = await startDashboard({ record, port: 0 });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const route of ['/api/state', '/api/trace', '/api/artifact?path=research/topic.md']) {
    const response = await fetch(server.url + route); assert.equal(response.status, 503);
    const body = await response.json(); assert.ok(body.error); assert.equal(body.tasks, undefined); assert.equal(body.content, undefined);
  }
  assert.equal(fs.existsSync(record), false);
});

test('event projections are bounded and exclude arbitrary tool payloads', () => {
  const state = testState();
  state.events = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, time: new Date().toISOString(), type: 'tool_completed', data: { task: 'experiment', result: 'PRIVATE_TOOL_PAYLOAD' } }));
  const data = dashboardSnapshot(state, 'test'); assert.equal(data.events.length, 250); assert.equal(data.events[0].seq, 300); assert.equal(data.totalEvents, 300);
  assert.ok(!JSON.stringify(data).includes('PRIVATE_TOOL_PAYLOAD'));
});

test('dashboard persists seed priority order, rejects duplicate entries and detects competing reorders', async t => {
  const { store, url } = await project(t);
  const inputs = { seedPapers: [{ id: 'direction', kind: 'direction', title: 'An evaluation research direction' }, { id: 'problem', kind: 'engineering_problem', title: 'A recurring engineering problem' }, { id: 'paper', title: 'A reference paper' }], targetJournal: null };
  const put = (value: unknown, revision: number) => fetch(url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1' }, body: JSON.stringify({ expectedRevision: revision, inputs: value }) });
  assert.equal((await put(inputs, 0)).status, 200);
  await store.update(s => { s.topic = { version: 1, status: 'APPROVED', approval: 'Old topic' }; });
  const reordered = { ...inputs, seedPapers: [...inputs.seedPapers].reverse() };
  assert.equal((await put(reordered, 1)).status, 200);
  const data = await (await fetch(url + '/api/state')).json(); assert.deepEqual(data.researchInputs.seedPapers, reordered.seedPapers); assert.equal(data.topic.status, 'UNSELECTED'); assert.equal(data.mode, 'automatic');
  assert.equal((await put({ ...inputs, seedPapers: [inputs.seedPapers[0], inputs.seedPapers[0]] }, 2)).status, 400);
  assert.equal((await put(inputs, 1)).status, 409);
  assert.deepEqual(store.read().researchInputs?.seedPapers, reordered.seedPapers); assert.equal(store.read().usage.requests, 0);
});

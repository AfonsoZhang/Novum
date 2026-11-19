import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, identity } from '../../src/store.js';
import { testConfig } from './fixtures.js';
import { initializeProject, initializationView, prepareInitialization } from '../../src/project-initialization.js';
import { researchInputs, updateResearchInputs } from '../../src/research-inputs.js';
import { scanProject, readDocument, supplementAgents } from '../../src/project-scan.js';
import { runControl } from '../../src/run-control.js';
import type { Model } from '../../src/model.js';
const emptyModel: Model = { async complete() { return { message: { role: 'assistant', content: '{"findings":[]}' } }; } };
async function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-init-')); const store = new Store(path.join(root, 'project.json'));
  await store.init('', testConfig(), 'automatic', undefined, prepareInitialization);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, store };
}
const readme = '# Project\n\n## Research question\nHow can stale results be detected?\n\nPaper type: benchmark\nTarget venue: ACL\n';

test('initialization progressively syncs grounded fields, preserves human edits and never dispatches research', async t => {
  const { root, store } = await setup(t); fs.writeFileSync(path.join(root, 'README.md'), readme);
  const original = '# Human rules\nDo not change frozen data.\n'; fs.writeFileSync(path.join(root, 'AGENTS.md'), original);
  let enter!: () => void; let release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const model: Model = { async complete() { enter(); await held; return { message: { role: 'assistant', content: JSON.stringify({ findings: [
    { field: 'seedPapers', value: { kind: 'direction', title: 'How can stale results be detected?' }, evidence: { file: 'README.md', quote: 'How can stale results be detected?' } },
    { field: 'seedPapers', value: { kind: 'direction', title: 'Invented direction' }, evidence: { file: 'README.md', quote: 'Not present' } },
  ] }) } }; } };
  const running = initializeProject(store, { model }); await entered;
  const mid = store.read(); assert.equal(mid.initialization?.stage, 'extract'); assert.equal(mid.researchInputs?.paperType, 'benchmark');
  assert.equal(mid.researchInputs?.targetJournal?.name, 'ACL'); assert.equal(mid.researchInputs?.seedPapers.length, 1); assert.equal(runControl(mid, root).canStart, false);
  const base = { paperType: null, seedPapers: [], targetJournal: null };
  await updateResearchInputs(store, { paperType: null, seedPapers: [{ id: 'human', kind: 'engineering_problem', title: 'Human supplied problem' }], targetJournal: null }, 0, { fields: ['seedPapers', 'paperType'], base });
  fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nConcurrent human edit.\n'); release(); await running;
  const final = store.read(); assert.equal(final.initialization?.status, 'completed'); assert.ok(final.initialization.steps.every(step => step.status === 'completed'));
  assert.equal(final.researchInputs?.paperType, null); assert.equal(final.researchInputs?.seedPapers[0].id, 'human'); assert.equal(final.researchInputs?.targetJournal?.name, 'ACL');
  assert.equal(final.researchInputs?.seedPapers.length, 1); assert.deepEqual(final.tasks, {}); assert.equal(final.scheduler, undefined); assert.equal(final.goal, '');
  assert.ok(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').startsWith(original + '\nConcurrent human edit.\n'));
  assert.equal(final.initialization.agents, 'supplemented'); assert.ok(final.initialization.findings.some(finding => finding.reason === '保留人工编辑'));
});

test('failed extraction retains partial fields and AGENTS; retry resumes and never replaces human-edited instructions', async t => {
  const { root, store } = await setup(t); fs.writeFileSync(path.join(root, 'README.md'), readme);
  await initializeProject(store, { model: { async complete() { throw new Error('provider unavailable'); } } });
  let state = store.read(); assert.equal(state.initialization?.status, 'failed'); assert.equal(state.researchInputs?.seedPapers.length, 1); assert.ok(initializationView(state)?.canRetry);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8') + '\nExtra human rule.\n'; fs.writeFileSync(path.join(root, 'AGENTS.md'), agents);
  await initializeProject(store, { model: emptyModel }); state = store.read();
  assert.equal(state.initialization?.status, 'completed'); assert.equal(state.researchInputs?.seedPapers.length, 1); assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(state.initialization.agents, 'preserved'); assert.equal(state.topic.status, 'UNSELECTED'); assert.deepEqual(state.tasks, {});
});

test('contradictory commitments and unsupported model guesses remain blank with source evidence', async t => {
  const { root, store } = await setup(t); fs.writeFileSync(path.join(root, 'README.md'), readme); fs.writeFileSync(path.join(root, 'notes.md'), 'Paper type: survey\nTarget venue: NeurIPS\n');
  await initializeProject(store, { model: emptyModel }); const state = store.read();
  assert.equal(state.researchInputs?.paperType, null); assert.equal(state.researchInputs?.targetJournal, null);
  assert.deepEqual(state.initialization?.conflictedFields?.sort(), ['paperType', 'targetJournal']);
  assert.ok(state.initialization?.findings.some(finding => finding.reason?.includes('冲突')));
});

test('manual clears and stale competing user saves cannot be overwritten by initialization', async t => {
  const { store } = await setup(t); const base = { paperType: null, seedPapers: [], targetJournal: null };
  await updateResearchInputs(store, base, 0, { fields: ['targetJournal'], base }); assert.ok(store.read().initialization?.protectedFields.includes('targetJournal'));
  const first = { ...base, targetJournal: { name: 'Human venue' } }; await updateResearchInputs(store, first, 0, { fields: ['targetJournal'], base });
  await assert.rejects(updateResearchInputs(store, { ...base, targetJournal: { name: 'Competing venue' } }, 0, { fields: ['targetJournal'], base }), /其他窗口/);
  assert.equal(researchInputs(store.read()).targetJournal?.name, 'Human venue');
});

test('interrupted leases are recoverable without replaying research or erasing partial state', async t => {
  const { store } = await setup(t); await store.update(state => { state.initialization!.process = { pid: process.pid, start: 'stale identity' }; });
  assert.equal(initializationView(store.read())?.status, 'interrupted'); assert.equal(initializationView(store.read())?.canRetry, true);
  await initializeProject(store, { model: emptyModel }); assert.equal(store.read().initialization?.status, 'completed');
  assert.equal(store.read().usage.requests, 0); assert.deepEqual(store.read().tasks, {});
});

test('source changes on retry invalidate only automatic fields, while secret and symlink files are excluded', async t => {
  const { root, store } = await setup(t); fs.writeFileSync(path.join(root, 'README.md'), readme);
  fs.writeFileSync(path.join(root, '.env'), 'SECRET_VALUE'); fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'README.md'), 'hidden');
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'linked.md'));
  const scan = await scanProject(root, new AbortController().signal, async () => {}); assert.deepEqual(scan.files, ['README.md']); assert.equal(await readDocument(root, 'linked.md', []), null);
  await initializeProject(store, { model: { async complete() { throw new Error('interrupted'); } } });
  fs.writeFileSync(path.join(root, 'README.md'), '# Project\n\n## Research question\nHow can current results be verified?\n');
  await initializeProject(store, { model: emptyModel }); const inputs = researchInputs(store.read());
  assert.equal(inputs.seedPapers.length, 1); assert.equal(inputs.seedPapers[0].title, 'How can current results be verified?'); assert.equal(inputs.targetJournal, null); assert.equal(inputs.paperType, null);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md')); assert.equal(await supplementAgents(root, scan.files), 'preserved'); assert.deepEqual(fs.readFileSync(path.join(root, 'AGENTS.md')), agents);
});

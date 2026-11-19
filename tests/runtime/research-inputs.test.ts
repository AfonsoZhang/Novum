import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.js';
import { runAgent } from '../../src/agent.js';
import { testConfig } from './fixtures.js';
import { researchInputsSchema, type ResearchInputValues } from '../../src/types.js';
import { researchGoal, researchInputs, seedLookupPlan, updateResearchInputs } from '../../src/research-inputs.js';
import { evidenceGate } from '../../src/gates.js';
import { addTask, approveTopic } from '../../src/workflow.js';
import type { Model } from '../../src/model.js';
import { snapshot, type ToolContext } from '../../src/tools.js';

const values: ResearchInputValues = { seedPapers: [{ id: 'seed-1', title: 'A starting paper', doi: '10.1234/fixture' }], targetJournal: { name: 'Fixture journal' } };
const mixed: ResearchInputValues = { seedPapers: [
  values.seedPapers[0],
  { id: 'direction-1', kind: 'direction', title: 'Low-cost citation reliability', notes: 'Explore evaluation with sparse annotation.' },
  { id: 'problem-1', kind: 'engineering_problem', title: 'Stale citations after document updates', notes: 'Reported symptom: old versions remain in answers. Expected: current citations; limited retrieval budget.' },
], targetJournal: null };
const pass = { verdict: 'PASS', summary: 'Fixture review', challenges: [], resolvedChallengeIds: [], limitations: [], paperType: { type: 'method', reason: 'The fixture proposal evaluates a method for traceable answers.' } };
async function project(t: test.TestContext, inputs?: ResearchInputValues) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-inputs-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json')); await store.init('Evaluate traceable answers', testConfig(), 'automatic', inputs);
  await addTask(store, { id: 'topic', stage: 'topic', prompt: 'Propose a topic', outputs: ['topic.md'], writes: ['topic.md'], requiresTopic: false });
  fs.writeFileSync(path.join(root, 'topic.md'), 'A bounded topic proposal.');
  return { root, store };
}

test('input revisions preserve unrelated state, reject competing edits and keep old records compatible', async t => {
  const { store } = await project(t); assert.equal(researchInputs(store.read()).revision, 0);
  await store.transaction(record => { record.existingTracker = { keep: true }; });
  await store.update(s => { s.tasks.topic.acceptance = 'accepted'; s.topic = { version: 1, status: 'AWAITING_TOPIC_APPROVAL', proposal: 'topic.md' }; });
  const results = await Promise.allSettled([updateResearchInputs(store, values, 0), updateResearchInputs(store, { seedPapers: [], targetJournal: { name: 'Another journal' } }, 0)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = store.read(); assert.equal(state.researchInputs?.revision, 1); assert.equal(state.tasks.topic.acceptance, 'stale');
  assert.equal(state.events.filter(e => e.type === 'research_inputs_updated').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')).existingTracker, { keep: true });
  await assert.rejects(approveTopic(store, 1, 'approve'), /stale|No matching/);
  const { revision, updatedAt, ...same } = state.researchInputs!;
  await updateResearchInputs(store, same, revision); assert.equal(store.read().researchInputs?.revision, revision);
});

test('research input schemas reject blank names, duplicate papers, unsafe URLs and control fields', () => {
  for (const input of [
    { ...values, seedPapers: [{ id: 'blank', title: '   ' }] },
    { ...values, seedPapers: [values.seedPapers[0], values.seedPapers[0]] },
    { ...values, targetJournal: { name: 'Journal', url: 'file:///etc/passwd' } },
    { ...values, targetJournal: { name: '  ' } },
    { ...values, topic: { status: 'APPROVED' } },
    { ...values, seedPapers: [{ id: 'p', kind: 'unknown', title: 'Invalid kind' }] },
    { ...values, seedPapers: [{ ...values.seedPapers[0], kind: 'direction' }] },
    { ...values, seedPapers: [{ ...values.seedPapers[0], kind: 'engineering_problem' }] },
  ]) assert.equal(researchInputsSchema.safeParse(input).success, false);
  assert.equal(researchInputsSchema.parse({ ...values, seedPapers: [{ id: 'p', title: 'Paper', doi: 'doi:10.1234/Test' }] }).seedPapers[0].doi, '10.1234/Test');
  assert.deepEqual(researchInputsSchema.parse(mixed), mixed, 'non-paper seeds do not need bibliography or URLs');
});

test('directions and engineering problems accept repeated titles and optional empty or omitted titles', () => {
  for (const kind of ['direction', 'engineering_problem'] as const) {
    const inputs = researchInputsSchema.parse({ seedPapers: [
      { id: 'one', kind, title: 'Same question', notes: 'First context' },
      { id: 'two', kind, title: 'Same question', notes: 'Second context' },
      { id: 'empty', kind, title: '  ' },
      { id: 'omitted', kind, notes: 'Only the description is available' },
    ], targetJournal: null });
    assert.equal(inputs.seedPapers.length, 4);
    assert.equal(inputs.seedPapers[2].title, ''); assert.equal(inputs.seedPapers[3].title, '');
    assert.equal(researchInputsSchema.safeParse({ ...inputs, seedPapers: [inputs.seedPapers[0], inputs.seedPapers[0]] }).success, false, 'Stable record IDs must remain unique');
  }
  assert.equal(researchInputsSchema.safeParse({ seedPapers: [{ id: 'one', title: 'Same paper' }, { id: 'two', title: 'Same paper' }], targetJournal: null }).success, false);
});

test('optional blank seeds persist without generic searches; descriptions remain usable as research inputs', async t => {
  const { store } = await project(t);
  const inputs = { seedPapers: [
    { id: 'blank', kind: 'direction' as const, title: '' },
    { id: 'described', kind: 'engineering_problem' as const, title: '', notes: 'Failures during incremental indexing' },
  ], targetJournal: null };
  await updateResearchInputs(store, inputs, store.read().researchInputs!.revision);
  const state = store.read(); state.goal = '';
  assert.deepEqual(state.researchInputs!.seedPapers, inputs.seedPapers);
  assert.deepEqual(seedLookupPlan(inputs.seedPapers[0]), []);
  assert.equal(researchGoal(state), '1. Failures during incremental indexing');
  assert.ok(seedLookupPlan(inputs.seedPapers[1]).every(lookup => lookup.query.startsWith(inputs.seedPapers[1].notes!)));
  assert.equal(researchGoal(state, { seedPapers: [inputs.seedPapers[0]], targetJournal: null }), '');
});

test('legacy paper kind is implicit; an explicit paper kind is a no-op, while a real type change invalidates acceptance', async t => {
  const legacy = { seedPapers: [{ id: 'seed', title: 'A starting point' }], targetJournal: null };
  const { root, store } = await project(t, legacy);
  await store.update(s => {
    s.tasks.topic.acceptance = 'accepted'; s.tasks.topic.researchInputs = structuredClone(s.researchInputs!);
    s.tasks.topic.inputLookups = { revision: 1, completedAt: new Date().toISOString(), results: [{ key: 'seed:seed', sourceIds: [] }] };
  });
  await updateResearchInputs(store, { ...legacy, seedPapers: [{ ...legacy.seedPapers[0], kind: 'paper' }] }, 1);
  assert.equal(store.read().researchInputs?.revision, 1); assert.equal(store.read().tasks.topic.acceptance, 'accepted');
  assert.equal(store.read().events.filter(e => e.type === 'research_inputs_updated').length, 0);
  await updateResearchInputs(store, { ...legacy, seedPapers: [{ ...legacy.seedPapers[0], kind: 'direction' }] }, 1);
  assert.equal(store.read().researchInputs?.revision, 2); assert.equal(store.read().tasks.topic.acceptance, 'stale');
  const state = store.read(); state.tasks.topic.researchInputs = structuredClone(state.researchInputs!);
  state.tasks.topic.inputLookups!.revision = 2;
  assert.ok(evidenceGate(root, state, state.tasks.topic).includes('Required research input lookup has not run: seed:seed:adversarial'));
});

test('all seed types trigger their required lookups before inference and preserve original problem context in review', async t => {
  const { root, store } = await project(t, mixed);
  const calls: { query: string; intent: string }[] = [];
  const retrieve = async (ctx: ToolContext, query: string, intent: 'support' | 'adversarial') => {
    calls.push({ query, intent });
    const sourceId = await snapshot(ctx, { identity: `fixture:seed-lookup-${calls.length}`, version: '1', title: query, content: 'Fixture context for ' + query });
    await store.update(s => { s.tasks.topic.retrievals.push({ query, intent, sourceIds: [sourceId] }); });
    return [{ sourceId }];
  };
  const model: Model = { async complete(route, messages) {
    assert.equal(calls.length, 5, 'each direction and engineering problem needs related-work and adversarial retrieval');
    if (route.family === 'reviewer') {
      const pack = JSON.parse(messages[1].content!);
      assert.deepEqual(pack.researchInputs.seedPapers, mixed.seedPapers);
      assert.equal(pack.inputLookups.results.length, 5); assert.equal(Object.keys(pack.originalArtifacts).length, 6);
      assert.match(pack.researchInputs.seedPapers[2].notes, /Reported symptom/);
      return { message: { role: 'assistant', content: JSON.stringify(pass) } };
    }
    assert.ok(messages.some(message => message.content?.includes('engineering_problem')));
    return { message: { role: 'assistant', content: 'Done' } };
  } };
  await runAgent(store, 'topic', root, new AbortController().signal, { model, retrieve });
  assert.deepEqual(calls.map(c => c.intent), ['support', 'support', 'adversarial', 'support', 'adversarial']);
  assert.equal(calls[0].query, '10.1234/fixture');
  assert.match(calls[1].query, /Low-cost citation reliability.*research gaps/);
  assert.match(calls[3].query, /Stale citations after document updates.*failure modes/);
  const state = store.read(); assert.equal(state.tasks.topic.acceptance, 'accepted'); assert.equal(state.topic.status, 'AWAITING_TOPIC_APPROVAL');
  state.tasks.topic.inputLookups!.results = state.tasks.topic.inputLookups!.results.filter(r => !r.key.endsWith(':adversarial'));
  const errors = evidenceGate(root, state, state.tasks.topic);
  for (const id of ['direction-1', 'problem-1']) assert.ok(errors.includes(`Required research input lookup has not run: seed:${id}:adversarial`));
});

test('failed counterevidence lookup for a non-paper seed cannot be skipped even at the topic stage', async t => {
  const { root, store } = await project(t, { seedPapers: [mixed.seedPapers[2]], targetJournal: null });
  const intents: string[] = []; let modelCalls = 0;
  const model: Model = { async complete() { modelCalls++; throw new Error('Must not run'); } };
  await assert.rejects(runAgent(store, 'topic', root, new AbortController().signal, { model, retrieve: async (_ctx, _query, intent) => {
    intents.push(intent); if (intent === 'adversarial') throw new Error('Counterevidence search unavailable'); return [];
  } }), /Counterevidence search unavailable/);
  assert.deepEqual(intents, ['support', 'adversarial']); assert.equal(modelCalls, 0);
  assert.equal(store.read().tasks.topic.inputLookups, undefined); assert.equal(store.read().topic.status, 'UNSELECTED');
});

test('seed searches and journal source retrieval run before the first model call and reach the fresh reviewer', async t => {
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url!);
    if (req.url === '/authors') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Fixture author instructions</h1>'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results: [{ id: 'fixture:seed', doi: '10.1234/fixture', title: 'A starting paper', updated_date: '2026-11-02' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { root, store } = await project(t, { ...values, targetJournal: { name: 'Fixture journal', url: url + '/authors' } });
  await store.update(s => { s.config.searchUrl = url + '/search'; });
  const model: Model = { async complete(route, messages) {
    assert.equal(requested.length, 2, 'both hard hooks must have run before any inference');
    if (route.family === 'reviewer') {
      const pack = JSON.parse(messages[1].content!); assert.equal(pack.researchInputs.revision, 1); assert.equal(pack.inputLookups.results.length, 2);
      assert.ok(Object.values(pack.originalArtifacts).some(text => String(text).includes('Fixture author instructions')));
      return { message: { role: 'assistant', content: JSON.stringify(pass) } };
    }
    assert.ok(messages.some(m => m.content?.includes('A starting paper')));
    return { message: { role: 'assistant', content: 'Done' } };
  } };
  await runAgent(store, 'topic', root, new AbortController().signal, { model });
  assert.equal(store.read().tasks.topic.acceptance, 'accepted'); assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL');
  assert.match(requested[0], /10.1234/); assert.equal(requested[1], '/authors');
  await store.update(s => { delete s.tasks.topic.inputLookups; });
  assert.ok(evidenceGate(root, store.read(), store.read().tasks.topic).some(e => e.includes('Required research input lookup')));
});

test('lookup failures block inference instead of silently dropping the supplied inputs', async t => {
  const { root, store } = await project(t, values); let calls = 0;
  const model: Model = { async complete() { calls++; throw new Error('Should not run'); } };
  await assert.rejects(runAgent(store, 'topic', root, new AbortController().signal, { model, retrieve: async () => { throw new Error('Search unavailable'); } }), /Search unavailable/);
  assert.equal(calls, 0); assert.equal(store.read().tasks.topic.inputLookups, undefined); assert.notEqual(store.read().tasks.topic.acceptance, 'accepted');
});

test('a research input change during review cannot accept an obsolete result or request topic approval', async t => {
  const { root, store } = await project(t);
  const model: Model = { async complete(route) {
    if (route.family === 'reviewer') { await updateResearchInputs(store, values, 0); return { message: { role: 'assistant', content: JSON.stringify(pass) } }; }
    return { message: { role: 'assistant', content: 'Done' } };
  } };
  await assert.rejects(runAgent(store, 'topic', root, new AbortController().signal, { model }), /Research inputs changed/);
  assert.notEqual(store.read().tasks.topic.acceptance, 'accepted'); assert.equal(store.read().topic.status, 'UNSELECTED');
  assert.ok(!store.read().events.some(e => e.type === 'task_accepted'));
});

test('CLI supports input initialization, inspection and versioned updates', async t => {
  const { root } = await project(t);
  const record = path.join(root, 'cli-project.json'); const inputFile = path.join(root, 'inputs.json'); const configFile = path.join(root, 'runtime.json');
  fs.writeFileSync(inputFile, JSON.stringify(mixed)); fs.writeFileSync(configFile, JSON.stringify(testConfig()));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../src/cli.js', import.meta.url)), ...args, '--record', record], { encoding: 'utf8' }));
  cli('init', '--goal', 'CLI fixture', '--config', configFile, '--inputs', inputFile);
  assert.equal(cli('inputs').revision, 1);
  assert.deepEqual(cli('inputs').seedPapers, mixed.seedPapers);
  fs.writeFileSync(inputFile, JSON.stringify({ seedPapers: [], targetJournal: null }));
  assert.equal(cli('inputs', '--file', inputFile, '--version', '1').revision, 2);
  assert.equal(cli('inputs').targetJournal, null);
});

test('seed order is versioned, invalidates old approval and preserves stable IDs and content', async t => {
  const { store } = await project(t, mixed);
  await store.update(s => { s.topic = { version: 3, status: 'APPROVED', approval: 'Approval for the old priority' }; s.tasks.topic.acceptance = 'accepted'; });
  const reordered = { ...mixed, seedPapers: [mixed.seedPapers[2], mixed.seedPapers[0], mixed.seedPapers[1]] };
  await updateResearchInputs(store, reordered, 1);
  let state = store.read(); assert.deepEqual(state.researchInputs?.seedPapers, reordered.seedPapers); assert.equal(state.researchInputs?.revision, 2);
  assert.equal(state.topic.status, 'UNSELECTED'); assert.equal(state.topic.version, 4); assert.equal(state.topic.approval, undefined); assert.equal(state.tasks.topic.acceptance, 'stale');
  assert.ok(state.events.some(e => e.type === 'seed_priority_changed' && (e.data.previousTopic as { approval?: string }).approval === 'Approval for the old priority'));
  await assert.rejects(approveTopic(store, 3, 'Old topic approved'), /No matching/);
  const before = store.read(); await updateResearchInputs(store, reordered, 2);
  assert.deepEqual(store.read(), before, 'saving unchanged order is a no-op');
  await assert.rejects(updateResearchInputs(store, mixed, 1), /其他窗口/);
  await updateResearchInputs(store, mixed, 2);
  state = store.read(); assert.equal(state.topic.version, 5); assert.deepEqual(state.researchInputs?.seedPapers, mixed.seedPapers);
});

test('all seed priorities reach executor and fresh review, and retrieval obeys order over retired selection', async t => {
  // An old selectedDirectionId must not override the current list order.
  const inputs = { ...mixed, selectedDirectionId: 'direction-1', seedPapers: [mixed.seedPapers[2], mixed.seedPapers[0], mixed.seedPapers[1]] };
  const { store, root } = await project(t, inputs); const queries: string[] = [];
  await store.update(state => { state.goal = ''; });
  const seedGoal = inputs.seedPapers.map((seed, index) => `${index + 1}. ${seed.title}`).join('\n');
  const priorities = inputs.seedPapers.map((seed, index) => ({ rank: index + 1, seedId: seed.id }));
  let executorChecked = false; let reviewerChecked = false;
  const model: Model = { async complete(route, messages) {
    assert.equal(queries.length, 5); assert.match(queries[0], /Stale citations after document updates.*failure modes/); assert.match(queries[1], /failed solutions tradeoffs/);
    assert.equal(queries[2], mixed.seedPapers[0].doi); assert.match(queries[3], /Low-cost citation reliability.*research gaps/); assert.match(queries[4], /limitations conflicting evidence/);
    if (route.family === 'reviewer') {
      const pack = JSON.parse(messages[1].content!); assert.deepEqual(pack.seedPriority, priorities); assert.equal(pack.selectedDirection, undefined); reviewerChecked = true;
      assert.equal(pack.goal, seedGoal, 'review uses the same ordered seeds when no legacy goal exists');
      assert.deepEqual(pack.researchInputs.seedPapers, inputs.seedPapers); assert.deepEqual(pack.inputLookups.results.map((r: { key: string }) => r.key), ['seed:problem-1', 'seed:problem-1:adversarial', 'seed:seed-1', 'seed:direction-1', 'seed:direction-1:adversarial']);
      return { message: { role: 'assistant', content: JSON.stringify(pass) } };
    }
    const taskContext = messages.find(m => m.role === 'user' && m.content?.startsWith('{"goal"'))!;
    assert.equal(JSON.parse(taskContext.content!).goal, seedGoal, 'executor receives the research scope from the seeds');
    assert.deepEqual(JSON.parse(taskContext.content!).seedPriority, priorities); executorChecked = true;
    return { message: { role: 'assistant', content: 'Done' } };
  } };
  await runAgent(store, 'topic', root, new AbortController().signal, { model, retrieve: async (_ctx, query) => { queries.push(query); return []; } });
  assert.ok(executorChecked && reviewerChecked); assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL'); assert.equal(store.read().topic.approval, undefined);
  assert.equal(store.read().goal, '', 'seed scope is not copied into a second persisted field');
});

test('default initialization enables the full pipeline while explicit on-demand and existing projects retain their mode', async t => {
  const { root } = await project(t); const config = path.join(root, 'default-runtime.json'); fs.writeFileSync(config, JSON.stringify(testConfig()));
  const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url)); const record = path.join(root, 'default-project.json');
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args, '--record', record], { encoding: 'utf8' }));
  assert.equal(cli('init', '--config', config, '--goal', 'Default automatic mode fixture').mode, 'automatic');
  const store = new Store(record); assert.equal(store.read().mode, 'automatic'); assert.equal(cli('pipeline').tasks.length, 8);
  assert.ok(Object.values(store.read().tasks).every(task => task.execution === 'pending')); assert.equal(store.read().usage.requests, 0); assert.equal(store.read().topic.status, 'UNSELECTED');
  const automatic = new Store(path.join(root, 'store-default.json')); await automatic.init('Store default', testConfig()); assert.equal(automatic.read().mode, 'automatic');
  const scopedRecord = path.join(root, 'scoped.json');
  execFileSync(process.execPath, [cliPath, 'init', '--record', scopedRecord, '--config', config, '--goal', 'Scoped fixture', '--mode', 'on_demand']);
  const scoped = new Store(scopedRecord); assert.equal(scoped.read().mode, 'on_demand');
  assert.throws(() => execFileSync(process.execPath, [cliPath, 'pipeline', '--record', scopedRecord], { stdio: 'pipe' }), /Command failed/);
  execFileSync(process.execPath, [cliPath, 'inputs', '--record', scopedRecord]); assert.equal(scoped.read().mode, 'on_demand');
});

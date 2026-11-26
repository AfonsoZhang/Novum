import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store.js';
import { configSchema, paperTypes, type PaperType } from '../../src/types.js';
import { paperProfile, paperType, paperTypePreference } from '../../src/paper-types.js';
import { testConfig } from './fixtures.js';
import { dashboardSnapshot, startDashboard } from '../../src/dashboard.js';
import { addTask, approveTopic, blockers, pipeline } from '../../src/workflow.js';
import { updateResearchInputs, researchInputs } from '../../src/research-inputs.js';
import { retry } from '../../src/scheduler.js';
import { runChecks } from '../../src/checks.js';
import { executionGate, invalidate } from '../../src/gates.js';
import { snapshot } from '../../src/tools.js';
import { runAgent } from '../../src/agent.js';
import type { Model } from '../../src/model.js';

const skillRoot = path.resolve('.claude/skills');
async function setup(t: test.TestContext, type?: PaperType) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-type-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('Paper contribution routing fixture', testConfig(), 'automatic', type ? { paperType: type, seedPapers: [], targetJournal: null } : undefined);
  return { store, root };
}

test('all paper types build coherent pipelines with required artifacts and appropriate skills', async t => {
  for (const type of paperTypes) {
    const { store, root } = await setup(t, type); await pipeline(store); const state = store.read(); const profile = paperProfile(type);
    assert.equal(Object.keys(state.tasks).length, type === 'survey' ? 11 : 10); assert.equal(state.mode, 'automatic');
    for (const task of Object.values(state.tasks)) {
      assert.equal(task.paperType, type); assert.equal(task.pipeline, true); assert.match(task.prompt, new RegExp(`Paper contribution type: ${type}`));
      for (const skill of task.skills) assert.ok(fs.existsSync(path.join(skillRoot, skill, 'SKILL.md')), `Unknown ${type} skill ${skill}`);
    }
    assert.equal(state.tasks.plan.outputs.includes('research/planned-runs.json'), profile.empirical);
    assert.equal(state.tasks.experiment.outputs.includes('research/observed-runs.json'), profile.empirical);
    for (const stage of ['plan', 'experiment', 'analysis'] as const) {
      for (const file of profile.artifacts[stage]) {
        assert.ok(state.tasks[stage].outputs.includes(file)); assert.ok(state.tasks[stage].writes.includes(file));
        assert.ok(state.tasks.writing.inputs.includes(file)); assert.ok(state.tasks.review.inputs.includes(file));
        for (const output of state.tasks[stage].outputs.filter(output => output !== file)) { fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true }); fs.writeFileSync(path.join(root, output), 'Fixture artifact'); }
        assert.ok(executionGate(root, state.tasks[stage]).includes('Missing artifact: ' + file), 'Required type-specific artifacts cannot be omitted');
      }
    }
    if (!profile.empirical) for (const task of Object.values(state.tasks)) assert.ok(!task.skills.includes('experiment-bridge') && !task.skills.includes('experiment-plan'));
    if (type === 'benchmark') assert.ok(state.tasks.writing.skills.includes('paper-outline'));
    if (type === 'method' || type === 'system') assert.ok(state.tasks.writing.skills.includes('paper-outline'));
    assert.ok(blockers(state, 'literature').includes('AWAITING_TOPIC_APPROVAL'));
  }
});

test('paper type changes reroute queued standard tasks, preserve live attempts and custom tasks, and revoke old approval', async t => {
  const { store } = await setup(t, 'method'); await pipeline(store);
  await addTask(store, { id: 'custom', stage: 'literature', session: 'custom', prompt: 'Custom work must remain intact', outputs: ['custom.md'], writes: ['custom.md'] });
  await store.update(s => {
    s.topic = { version: 2, status: 'APPROVED', approval: 'Old method scope' };
    s.tasks.topic.execution = 'completed'; s.tasks.topic.acceptance = 'accepted'; s.tasks.topic.attempts = 1;
    s.tasks.plan.execution = 'running'; s.tasks.plan.attempts = 1; s.tasks.plan.researchInputs = structuredClone(s.researchInputs!);
  });
  const old = store.read();
  await updateResearchInputs(store, { paperType: 'survey', seedPapers: [], targetJournal: null }, 1);
  const changed = store.read(); assert.equal(changed.researchInputs?.revision, 2); assert.equal(changed.topic.status, 'UNSELECTED'); assert.equal(changed.topic.approval, undefined);
  assert.equal(changed.tasks.topic.acceptance, 'stale'); assert.deepEqual(changed.tasks.plan, old.tasks.plan); assert.deepEqual(changed.tasks.custom, old.tasks.custom);
  assert.equal(changed.tasks.experiment.paperType, 'survey'); assert.deepEqual(changed.tasks.experiment.skills, ['research-lit']);
  assert.ok(changed.tasks.experiment.outputs.includes('research/source-selection.json')); assert.ok(!changed.tasks.experiment.outputs.includes('research/observed-runs.json'));
  assert.ok(changed.tasks.writing.inputs.includes('research/search-protocol.md')); assert.ok(blockers(changed, 'custom').includes('AWAITING_TOPIC_APPROVAL'));
  assert.ok(changed.events.some(e => e.type === 'paper_type_changed')); assert.ok(changed.events.some(e => e.type === 'paper_type_task_routed'));
  await store.update(s => { s.tasks.plan.execution = 'failed'; });
  await retry(store, 'plan', 'Replan under the selected survey contribution');
  assert.equal(store.read().tasks.plan.paperType, 'survey'); assert.ok(store.read().tasks.plan.outputs.includes('research/search-protocol.md')); assert.ok(!store.read().tasks.plan.outputs.includes('research/planned-runs.json'));
});

test('legacy research kinds map to paper types without rewriting records or inventing a type change', async t => {
  const { store } = await setup(t);
  await store.update(s => { delete s.researchInputs!.paperType; });
  for (const [kind, expected] of [['empirical', 'method'], ['theory', 'theory'], ['survey', 'survey']] as const) {
    await store.update(s => { s.config.researchKind = kind; }); const before = fs.readFileSync(store.file);
    assert.equal(paperType(store.read()), expected); assert.equal(dashboardSnapshot(store.read(), 'fixture').paperType, expected); assert.deepEqual(fs.readFileSync(store.file), before);
    await updateResearchInputs(store, { paperType: expected, seedPapers: [], targetJournal: null }, 0);
    assert.equal(researchInputs(store.read()).revision, 0, 'making the inherited type explicit is a no-op');
  }
});

test('empirical checks follow pinned task type, never the newly selected project type', async t => {
  const { store } = await setup(t, 'method'); await pipeline(store);
  await store.update(s => { s.tasks.experiment.execution = 'running'; });
  await updateResearchInputs(store, { paperType: 'theory', seedPapers: [], targetJournal: null }, 1);
  assert.ok((await runChecks(store, 'experiment', skillRoot, new AbortController().signal)).some(error => error.includes('run-records')));
  await store.update(s => { s.tasks.experiment.execution = 'failed'; }); await retry(store, 'experiment', 'Use the newly selected proof route');
  assert.deepEqual(await runChecks(store, 'experiment', skillRoot, new AbortController().signal), []);
  assert.equal(store.read().tasks.experiment.paperType, 'theory'); assert.ok(store.read().tasks.experiment.outputs.includes('research/proofs.md'));
});

test('survey source selection checks membership, decisions and snapshot integrity before fresh review', async t => {
  const { store, root } = await setup(t, 'survey'); const signal = new AbortController().signal;
  await addTask(store, { id: 'survey', stage: 'experiment', prompt: 'Synthesize the selected sources', inputs: ['research/search-protocol.md'], outputs: ['research/execution.md', 'research/source-selection.json'], writes: ['research'] });
  await store.update(s => { s.topic = { version: 1, status: 'APPROVED', approval: 'Fixture topic' }; });
  fs.mkdirSync(path.join(root, 'research')); fs.writeFileSync(path.join(root, 'research/search-protocol.md'), 'Fixture scope and search protocol'); fs.writeFileSync(path.join(root, 'research/execution.md'), 'Fixture synthesis');
  const ctx = { store, taskId: 'survey', signal };
  const sourceId = await snapshot(ctx, { identity: 'fixture:survey-source', title: 'Survey fixture source', version: '1', content: 'SOURCE_SELECTION_ORIGINAL_EVIDENCE' });
  const catalog = path.join(root, 'research/source-selection.json');
  for (const value of [[{ sourceId: 'missing', decision: 'include', reason: 'Relevant' }], [{ sourceId, decision: 'exclude', reason: 'Excluded' }], [{ sourceId, decision: 'include', reason: '' }], [{ sourceId, decision: 'include', reason: 'Relevant' }, { sourceId, decision: 'exclude', reason: 'Duplicate' }]]) {
    fs.writeFileSync(catalog, JSON.stringify(value)); assert.ok((await runChecks(store, 'survey', skillRoot, signal)).some(error => error.includes('source-selection')));
  }
  fs.writeFileSync(catalog, JSON.stringify([{ sourceId, decision: 'include', reason: 'Matches the scope' }]));
  assert.deepEqual(await runChecks(store, 'survey', skillRoot, signal), []);
  await store.update(s => { s.claims.C1 = { id: 'C1', taskId: 'survey', text: 'Fixture synthesis claim', evidence: [{ sourceId, location: 'Fixture source' }], revision: 1 }; s.tasks.survey.claimIds = ['C1']; });
  let reviewed = false;
  const model: Model = { async complete(route, messages) {
    if (route.family === 'reviewer') {
      const pack = JSON.parse(messages[1].content!); assert.equal(pack.paperProfile.type, 'survey');
      assert.ok(Object.values(pack.originalArtifacts).includes('SOURCE_SELECTION_ORIGINAL_EVIDENCE')); reviewed = true;
      return { message: { role: 'assistant', content: JSON.stringify({ verdict: 'PASS', summary: 'Fixture review', challenges: [], resolvedChallengeIds: [], limitations: [] }) } };
    }
    assert.ok(messages.some(message => message.content?.includes('"paperProfile":{"type":"survey"'))); return { message: { role: 'assistant', content: 'Done' } };
  } };
  await runAgent(store, 'survey', root, signal, { model, retrieve: async () => { await store.update(s => { s.tasks.survey.retrievals.push({ intent: 'adversarial', query: 'Fixture counterevidence', sourceIds: [] }); }); return []; } });
  assert.ok(reviewed); assert.equal(store.read().tasks.survey.acceptance, 'accepted');
  fs.appendFileSync(path.join(root, store.read().sources[sourceId].path), ' tampered');
  assert.ok((await runChecks(store, 'survey', skillRoot, signal)).some(error => error.includes('source-selection')));
});

test('paper type API round-trips independently of seed subjects and rejects unknown types', async t => {
  const { store } = await setup(t); const server = await startDashboard({ record: store.file, port: 0 }); t.after(() => server.close());
  const put = (type: string | null, revision: number) => fetch(server.url + '/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1' }, body: JSON.stringify({ expectedRevision: revision, inputs: { paperType: type, seedPapers: [], targetJournal: null } }) });
  assert.equal((await put('survey', 0)).status, 200);
  const state = await (await fetch(server.url + '/api/state')).json(); assert.equal(state.paperType, 'survey'); assert.equal(state.researchInputs.paperType, 'survey'); assert.equal(state.paperTypes.length, 8); assert.equal(state.stageLabels.experiment, '文献筛选');
  assert.equal((await put('unknown', 1)).status, 400); assert.equal((await put('benchmark', 0)).status, 409); assert.equal(store.read().usage.requests, 0);
  assert.equal((await put(null, 1)).status, 200);
  const blank = await (await fetch(server.url + '/api/state')).json();
  assert.equal(blank.paperType, null); assert.equal(blank.paperTypePreference, null); assert.equal(blank.researchInputs.paperType, null); assert.equal(blank.stageLabels.experiment, '研究执行');
});

const topicReview = { verdict: 'PASS', summary: 'Fixture proposal checked.', challenges: [], resolvedChallengeIds: [], limitations: [] };
async function reviewTopic(store: Store, root: string, response: unknown) {
  const file = path.join(root, 'research/topic.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'A bounded research proposal with a source synthesis contribution.');
  const model: Model = { async complete(_route, messages, tools) {
    if (!tools.length) {
      const pack = JSON.parse(messages[1].content!);
      assert.equal(pack.paperProfile.type, null); assert.equal(pack.paperTypeOptions.length, 8);
      return { message: { role: 'assistant', content: JSON.stringify(response) } };
    }
    return { message: { role: 'assistant', content: 'Done' } };
  } };
  await runAgent(store, 'topic', skillRoot, new AbortController().signal, { model });
}

test('new projects leave paper type unselected and prevent unresolved downstream dispatch', async t => {
  const { store, root } = await setup(t); await pipeline(store);
  const state = store.read(); assert.equal(state.researchInputs?.paperType, null); assert.equal(paperType(state), null);
  assert.equal(state.mode, 'automatic'); assert.deepEqual(blockers(state, 'topic'), []);
  for (const task of Object.values(state.tasks)) {
    assert.equal(task.paperType, null); assert.match(task.prompt, /Paper contribution type: undecided/);
    assert.ok(!task.skills.includes('experiment-bridge')); assert.ok(!task.outputs.includes('research/planned-runs.json'));
  }
  assert.ok(blockers(state, 'literature').includes('PAPER_TYPE_UNRESOLVED'));
  await assert.rejects(runAgent(store, 'literature', root, new AbortController().signal), /Paper type is unresolved/);
  assert.equal(store.read().usage.requests, 0);
  await updateResearchInputs(store, { seedPapers: [], targetJournal: null }, 0);
  assert.equal(researchInputs(store.read()).revision, 0); assert.equal(paperTypePreference(store.read()), null);
});

test('accepted topic review resolves an optional type, reroutes stages and still requires human approval', async t => {
  const { store, root } = await setup(t); await pipeline(store);
  await store.update(s => { s.config = configSchema.parse({ ...s.config, reportLanguage: 'Português' }); });
  const recommendation = { type: 'survey', reason: 'The proposed contribution synthesizes existing sources and their coverage gaps.' };
  await reviewTopic(store, root, { ...topicReview, paperType: recommendation });
  let state = store.read(); const resolution = state.paperTypeResolution;
  assert.match(state.sessions.main.messages[0].content!, /default to Chinese/);
  assert.ok(state.sessions.main.messages.some(message => message.role === 'user' && message.content?.includes('"reportLanguage":"Português"')));
  assert.equal(paperTypePreference(state), null); assert.equal(state.researchInputs?.paperType, null); assert.equal(state.researchInputs?.revision, 0);
  assert.equal(paperType(state), 'survey'); assert.equal(resolution?.session, state.tasks.topic.review?.session);
  assert.equal(resolution?.reason, recommendation.reason); assert.equal(state.topic.status, 'AWAITING_TOPIC_APPROVAL');
  assert.deepEqual(blockers(state, 'literature'), ['AWAITING_TOPIC_APPROVAL']);
  assert.ok(state.tasks.plan.outputs.includes('research/search-protocol.md')); assert.ok(state.tasks.experiment.outputs.includes('research/source-selection.json'));
  assert.ok(!state.tasks.experiment.outputs.includes('research/observed-runs.json')); assert.deepEqual(state.tasks.experiment.skills, ['research-lit']);
  const shown = dashboardSnapshot(state, store.file); assert.equal(shown.paperTypePreference, null); assert.equal(shown.paperType, 'survey'); assert.equal(shown.paperTypeReason, recommendation.reason);
  assert.ok(state.events.some(event => event.type === 'paper_type_resolved'));
  await updateResearchInputs(store, { paperType: null, seedPapers: [], targetJournal: null }, 0);
  assert.deepEqual(store.read().paperTypeResolution, resolution, 'Saving an unchanged blank choice must retain the reviewed decision');
  await approveTopic(store, state.topic.version, 'Approve this survey topic');
  state = store.read(); assert.deepEqual(blockers(state, 'literature'), []);
  await updateResearchInputs(store, { paperType: 'theory', seedPapers: [], targetJournal: null }, 0);
  state = store.read(); assert.equal(state.paperTypeResolution, undefined); assert.equal(state.topic.status, 'UNSELECTED'); assert.equal(state.tasks.topic.acceptance, 'stale');
  assert.equal(paperType(state), 'theory'); assert.ok(state.tasks.experiment.outputs.includes('research/proofs.md'));
});

test('missing, invalid or blocked paper type recommendations cannot resolve an automatic topic', async t => {
  for (const response of [topicReview, { ...topicReview, paperType: { type: 'unknown', reason: 'Invalid' } }, { ...topicReview, paperType: { type: 'survey', reason: ' ' } }, { ...topicReview, verdict: 'BLOCKED', paperType: { type: 'survey', reason: 'Plausible but insufficient evidence' } }]) {
    const { store, root } = await setup(t); await pipeline(store); await store.update(s => { s.config.maxNoProgress = 1; });
    await assert.rejects(reviewTopic(store, root, response));
    const state = store.read(); assert.equal(state.paperTypeResolution, undefined); assert.equal(paperType(state), null);
    assert.notEqual(state.tasks.topic.acceptance, 'accepted'); assert.equal(state.topic.status, 'UNSELECTED');
    assert.ok(blockers(state, 'literature').includes('PAPER_TYPE_UNRESOLVED'));
  }
});

test('automatic paper type decisions expire with changed inputs or invalidated topic evidence', async t => {
  for (const change of ['inputs', 'evidence'] as const) {
    const { store, root } = await setup(t); await pipeline(store);
    await reviewTopic(store, root, { ...topicReview, paperType: { type: 'survey', reason: 'This proposal synthesizes existing sources.' } });
    if (change === 'inputs') {
      await updateResearchInputs(store, { paperType: null, seedPapers: [{ id: 'new', kind: 'direction', title: 'A different research question' }], targetJournal: null }, 0);
      assert.equal(store.read().paperTypeResolution, undefined); assert.equal(store.read().tasks.plan.paperType, null);
    } else {
      fs.appendFileSync(path.join(root, 'research/topic.md'), '\nChanged contribution.');
      await store.update(s => invalidate(root, s));
      await assert.rejects(approveTopic(store, store.read().topic.version, 'Approve'), /stale/);
    }
    assert.equal(paperType(store.read()), null); assert.ok(blockers(store.read(), 'literature').includes('PAPER_TYPE_UNRESOLVED'));
  }
});

test('legacy pipeline recognition preserves custom additions and restores only exact standard tasks', async t => {
  const original = 'Select and justify a research topic within the stated goal. Save a Chinese topic-approval report. No downstream research before human approval.';
  for (const custom of [false, true]) {
    const { store } = await setup(t);
    await addTask(store, { id: 'topic', stage: 'topic', session: 'main', prompt: original + (custom ? ' Save research/custom.md and preserve this custom instruction.' : ''), skills: ['research-companion', 'idea-evaluator'], dependencies: [], inputs: [], outputs: ['research/topic.md'], writes: ['research/topic.md', 'research/topic-assets'], requiresTopic: false });
    const before = store.read().tasks.topic;
    await updateResearchInputs(store, { paperType: 'theory', seedPapers: [], targetJournal: null }, 0);
    const after = store.read().tasks.topic;
    if (custom) assert.deepEqual(after, before);
    else { assert.equal(after.pipeline, true); assert.equal(after.paperType, 'theory'); assert.match(after.prompt, /Paper contribution type: theory/); assert.match(after.prompt, /what evidence would overturn/); }
  }
});

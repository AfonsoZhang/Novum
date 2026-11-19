import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../../src/agent.js';
import { dashboardSnapshot } from '../../src/dashboard.js';
import type { Model } from '../../src/model.js';
import { Store } from '../../src/store.js';
import { snapshot, type ToolContext } from '../../src/tools.js';
import { configSchema, type Message, type Route } from '../../src/types.js';
import { addTask } from '../../src/workflow.js';

const route = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'fixture-family', apiKeyEnv: 'TEST_RESEARCH_KEY' };
const pass = { verdict: 'PASS', summary: 'Original evidence supports the claim.', challenges: [], resolvedChallengeIds: [], limitations: ['Evidence applies to the fixture setting.'] };
const text = (content: string): Message => ({ role: 'assistant', content });
const call = (name: string, args: unknown): Message => ({ role: 'assistant', content: 'PRIVATE_EXECUTOR_CONTEXT', tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function setup(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-model-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('Verify a grounded result', configSchema.parse({ executor: route, maxRequests: 30, maxNoProgress: 1, ...overrides }), 'automatic', { paperType: 'method', seedPapers: [], targetJournal: null });
  await addTask(store, { id: 'work', stage: 'literature', prompt: 'Produce a grounded artifact.', session: 'work', outputs: ['work.md'], writes: ['work.md'] });
  await store.update(s => { s.topic = { version: 1, status: 'APPROVED', approval: 'Fixture user approval' }; });
  return { root, store };
}

async function retrieve(ctx: ToolContext) {
  const sourceId = await snapshot(ctx, { identity: 'fixture:primary', version: '1', title: 'Fixture evidence', content: 'The measured result is zero.' });
  await ctx.store.update(s => { s.tasks.work.retrievals.push({ query: 'counterevidence', intent: 'adversarial', sourceIds: [sourceId] }); });
  return [{ sourceId }];
}

function fixture(store: Store, reply: () => Message = () => text(JSON.stringify(pass))) {
  const reviews: { route: Route; messages: Message[] }[] = [];
  let executorCalls = 0;
  const model: Model = { complete: async (currentRoute, messages, tools) => {
    // Reviewer identity must not depend on a different endpoint, model or family.
    if (!tools.length) {
      reviews.push({ route: structuredClone(currentRoute), messages: structuredClone(messages) });
      return { message: reply() };
    }
    const sourceId = Object.keys(store.read().sources)[0];
    const steps = [
      call('write_file', { path: 'work.md', content: 'The result is zero.' }),
      call('record_claim', { id: 'C1', text: 'The result is zero.', evidence: [{ sourceId, passage: 'The measured result is zero.' }] }),
    ];
    return { message: steps[executorCalls++] ?? text('Done') };
  } };
  return { model, reviews };
}

for (const scenario of [
  { name: 'omitted reviewer reuses executor route', config: {}, independence: 'same_family' },
  { name: 'explicit identical reviewer route is accepted', config: { reviewer: route }, independence: 'same_family' },
  { name: 'different configured reviewer family remains supported', config: { reviewer: { ...route, family: 'other-family' } }, independence: 'cross_family' },
] as const) {
  test(scenario.name, async t => {
    const { root, store } = await setup(t, scenario.config);
    const { model, reviews } = fixture(store);
    await runAgent(store, 'work', root, new AbortController().signal, { model, retrieve });
    const state = store.read(); const task = state.tasks.work;
    assert.equal(task.acceptance, 'accepted');
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0].route, state.config.reviewer);
    if (scenario.independence === 'same_family') assert.deepEqual(state.config.reviewer, state.config.executor);
    assert.equal(reviews[0].messages.length, 2);
    assert.doesNotMatch(JSON.stringify(reviews[0].messages), /PRIVATE_EXECUTOR_CONTEXT/);
    const pack = JSON.parse(reviews[0].messages[1].content!);
    assert.equal(pack.originalArtifacts['work.md'], 'The result is zero.');
    assert.equal(pack.claims[0].id, 'C1');
    assert.equal(pack.sourceMetadata.length, 1);
    assert.equal(pack.reviewIndependence, scenario.independence);
    assert.notEqual(task.reviewSession, task.session);
    assert.equal(task.review?.independence, scenario.independence);
    assert.ok(task.review?.limitations.includes(pass.limitations[0]));
    const shown = dashboardSnapshot(state, store.file).tasks[0].review!;
    assert.equal(shown.limitations.some(item => item.includes('does not provide cross-family independence')), scenario.independence === 'same_family');
    for (const type of ['independent_review_started', 'independent_review_completed']) {
      assert.equal(state.events.find(e => e.type === type)?.data.independence, scenario.independence);
    }
    const events = state.events.map(e => e.type);
    assert.ok(events.indexOf('execution_artifacts_checked') < events.indexOf('independent_review_started'));
    assert.ok(events.indexOf('independent_review_completed') < events.indexOf('task_accepted'));
  });
}

test('same-model PASS cannot bypass a major challenge or poll for a favorable review', async t => {
  const { root, store } = await setup(t);
  const { model, reviews } = fixture(store, () => text(JSON.stringify({ ...pass, challenges: [{ id: 'Q1', claimId: 'C1', severity: 'major', reason: 'Missing decisive evidence' }] })));
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve }), /no progress/);
  const state = store.read();
  assert.equal(state.tasks.work.acceptance, 'blocked');
  assert.equal(state.challenges.Q1.status, 'open');
  assert.equal(reviews.length, 1);
  assert.equal(state.events.find(e => e.type === 'independent_review_reused')?.data.independence, 'same_family');
  assert.ok(!state.events.some(e => e.type === 'task_accepted'));
});

test('same-model reviewer errors retain provenance and cannot accept work', async t => {
  const { root, store } = await setup(t);
  const { model, reviews } = fixture(store, () => text('invalid JSON'));
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve }));
  const state = store.read(); const review = state.tasks.work.review!;
  assert.equal(review.verdict, 'ERROR');
  assert.equal(review.independence, 'same_family');
  assert.match(review.limitations.join(' '), /does not provide cross-family independence/);
  assert.equal(state.events.find(e => e.type === 'independent_review_failed')?.data.independence, 'same_family');
  assert.notEqual(state.tasks.work.acceptance, 'accepted');
  assert.equal(reviews.length, 1);
});

test('same-model configuration keeps the artifact gate before review', async t => {
  const { root, store } = await setup(t);
  let reviewerCalls = 0;
  const model: Model = { complete: async (_route, _messages, tools) => {
    if (!tools.length) reviewerCalls++;
    return { message: tools.length ? text('Done') : text(JSON.stringify(pass)) };
  } };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve }), /no progress/);
  assert.equal(store.read().tasks.work.acceptance, 'blocked');
  assert.equal(reviewerCalls, 0);
});

test('changing reviewer route cannot reuse the previous family review', async t => {
  const { root, store } = await setup(t);
  let replies = 0;
  const { model, reviews } = fixture(store, () => text(JSON.stringify(++replies === 1 ? { ...pass, verdict: 'BLOCKED' } : pass)));
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve }), /no progress/);
  const previousSession = store.read().tasks.work.reviewSession;
  await store.update(s => { s.config.reviewer = { ...s.config.reviewer, model: 'another-model', family: 'another-family' }; });
  await runAgent(store, 'work', root, new AbortController().signal, { model, retrieve });
  const state = store.read();
  assert.equal(reviews.length, 2);
  assert.notEqual(state.tasks.work.reviewSession, previousSession);
  assert.equal(state.tasks.work.review?.independence, 'cross_family');
  assert.equal(state.tasks.work.review?.model, 'another-model');
  assert.deepEqual(state.tasks.work.review?.limitations, pass.limitations);
  assert.equal(state.tasks.work.acceptance, 'accepted');
});

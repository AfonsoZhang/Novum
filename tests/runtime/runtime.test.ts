import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, event, hash, identity } from '../../src/store.js';
import { configSchema, type Message, type Route } from '../../src/types.js';
import { addTask, approveTopic, blockers, pipeline } from '../../src/workflow.js';
import { auditFreshness, evidenceGate, invalidate } from '../../src/gates.js';
import { builtins, snapshot, runCommand, type ToolContext } from '../../src/tools.js';
import { runAgent } from '../../src/agent.js';
import { HttpModel, request, UncertainDispatch, type Model } from '../../src/model.js';
import { cancel, reconcile, retry, tick } from '../../src/scheduler.js';
import { pack, replay } from '../../src/delivery.js';
import { runChecks } from '../../src/checks.js';
import { importKnowledge, queryKnowledge } from '../../src/knowledge.js';
import { taskTimeLimit } from '../../src/resource-budgets.js';

const route = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'executor', apiKeyEnv: 'TEST_RESEARCH_KEY' };
const pass = { verdict: 'PASS', summary: 'Original artifacts checked.', challenges: [], resolvedChallengeIds: [], limitations: [] };
const text = (content: string): Message => ({ role: 'assistant', content });
const call = (name: string, args: unknown, id = name): Message => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function setup(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('Test a concrete research objective', configSchema.parse({ executor: route, reviewer: { ...route, family: 'reviewer' }, maxRequests: 30, ...overrides }), 'automatic', { paperType: 'method', seedPapers: [], targetJournal: null });
  return { root, store };
}
async function task(store: Store, id = 'work', stage: 'topic' | 'literature' = 'literature', extra = {}) {
  await addTask(store, { id, stage, prompt: 'Produce a grounded artifact.', session: id, outputs: [`${id}.md`], writes: [`${id}.md`], requiresTopic: stage !== 'topic', ...extra });
  if (stage !== 'topic') await store.update(s => { s.topic = { version: 1, status: 'APPROVED', approval: 'test user approved' }; });
}
async function fixtureRetrieval(ctx: ToolContext) {
  const sourceId = await snapshot(ctx, { identity: 'fixture:primary', version: '1', title: 'Fixture evidence', content: 'The measured result is zero. Counterevidence was investigated.' });
  await ctx.store.update(s => { s.tasks[ctx.taskId].retrievals.push({ query: 'counterevidence', intent: 'adversarial', sourceIds: [sourceId] }); });
  return [{ sourceId }];
}
class FixtureModel implements Model {
  executorCalls = 0; reviews: Message[][] = [];
  constructor(private store: Store, private behavior?: (index: number) => Message) {}
  async complete(route: Route, messages: Message[]): Promise<{ message: Message }> {
    if (route.family === 'reviewer') { this.reviews.push(structuredClone(messages)); return { message: text(JSON.stringify(pass)) }; }
    const index = this.executorCalls++;
    if (this.behavior) return { message: this.behavior(index) };
    const id = Object.keys(this.store.read().sources)[0];
    const sequence = [call('write_file', { path: 'work.md', content: 'The result is zero.' }), call('record_claim', { id: 'C1', text: 'The result is zero.', evidence: [{ sourceId: id, passage: 'The measured result is zero.' }] }), text('Done')];
    return { message: sequence[index] ?? text('Done') };
  }
}

test('one canonical record preserves unrelated fields under concurrent transactions', async t => {
  const { store } = await setup(t);
  await store.transaction(r => { r.existingResearchTracker = { keep: true }; });
  await Promise.all(Array.from({ length: 15 }, (_, i) => store.update(s => event(s, 'concurrent', { i }))));
  const record = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(record.existingResearchTracker.keep, true); assert.equal(store.read().events.filter(e => e.type === 'concurrent').length, 15);
  assert.deepEqual(store.read().events.map(e => e.seq), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('hard loop invokes retrieval, artifact gate and fresh cross-family review before acceptance', async t => {
  const { store, root } = await setup(t); await task(store); const model = new FixtureModel(store);
  await runAgent(store, 'work', root, new AbortController().signal, { model, retrieve: fixtureRetrieval });
  const state = store.read(); assert.equal(state.tasks.work.acceptance, 'accepted'); assert.equal(state.tasks.work.execution, 'completed');
  assert.ok(state.tasks.work.executionCompletedAt); assert.equal(model.reviews.length, 1);
  assert.equal(model.reviews[0].length, 2); assert.match(model.reviews[0][1].content!, /originalArtifacts/);
  assert.doesNotMatch(model.reviews[0][1].content!, /tool_calls/);
  const events = state.events.map(e => e.type);
  assert.ok(events.indexOf('adversarial_retrieval_started') < events.indexOf('model_request_started'));
  assert.ok(events.indexOf('execution_artifacts_checked') < events.indexOf('independent_review_started'));
  assert.ok(events.indexOf('independent_review_completed') < events.indexOf('task_accepted'));
});

test('model saying done cannot bypass missing artifacts or trigger ungrounded reviewer acceptance', async t => {
  const { store, root } = await setup(t, { maxNoProgress: 1 }); await task(store, 'work', 'topic');
  const model = new FixtureModel(store, () => text('Everything is done and approved.'));
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model }), /no progress/);
  assert.equal(store.read().tasks.work.acceptance, 'blocked'); assert.equal(model.reviews.length, 0);
});

test('topic approval is versioned, explicit and unavailable as a model tool', async t => {
  const { store, root } = await setup(t); await task(store, 'topic', 'topic');
  await addTask(store, { id: 'next', stage: 'literature', prompt: 'next', dependencies: ['topic'], outputs: ['next.md'], writes: ['next.md'] });
  const model = new FixtureModel(store, i => i ? text('Topic proposed') : call('write_file', { path: 'topic.md', content: '选题报告' }));
  await runAgent(store, 'topic', root, new AbortController().signal, { model });
  assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL'); assert.ok(blockers(store.read(), 'next').includes('AWAITING_TOPIC_APPROVAL'));
  assert.ok(!builtins().declarations().some(d => d.function.name.includes('approve')));
  await assert.rejects(approveTopic(store, 2, 'yes'), /matching/); await assert.rejects(approveTopic(store, 1, ''), /Explicit/);
  await approveTopic(store, 1, 'User explicitly approves this proposal'); assert.deepEqual(blockers(store.read(), 'next'), []);
});

test('pipeline creates explicit dependencies and cannot activate itself on demand', async t => {
  const { store } = await setup(t); await pipeline(store);
  const s = store.read(); assert.equal(Object.keys(s.tasks).length, 10); assert.deepEqual(s.tasks.delivery.dependencies, ['review']);
  assert.equal(s.tasks.topic.requiresTopic, false); assert.equal(s.tasks.writing.session, s.tasks.analysis.session);
  await assert.rejects(pipeline(store), /already/);
  await store.update(s => { s.tasks = {}; s.mode = 'on_demand'; }); await assert.rejects(pipeline(store), /explicit/);
});

test('claim membership and passages checked; unresolved major challenges block; minor limitations do not', async t => {
  const { store, root } = await setup(t); await task(store); fs.writeFileSync(path.join(root, 'work.md'), 'result');
  await store.update(s => { s.tasks.work.researchInputs = structuredClone(s.researchInputs!); });
  const ctx = { store, taskId: 'work', signal: new AbortController().signal }; await fixtureRetrieval(ctx);
  const tools = builtins(); const id = Object.keys(store.read().sources)[0];
  await assert.rejects(tools.execute('record_claim', { id: 'C1', text: 'claim', evidence: [{ sourceId: 'missing', page: '1' }] }, ctx), /not retrieved/);
  await assert.rejects(tools.execute('record_claim', { id: 'C1', text: 'claim', evidence: [{ sourceId: id, passage: 'invented quote' }] }, ctx), /absent/);
  await tools.execute('record_claim', { id: 'C1', text: 'claim', evidence: [{ sourceId: id, passage: 'The measured result is zero.' }] }, ctx);
  await store.update(s => { s.challenges.Q1 = { id: 'Q1', taskId: 'work', claimId: 'C1', severity: 'major', reason: 'Pivotal gap', status: 'open' }; });
  assert.match(evidenceGate(root, store.read(), store.read().tasks.work).join(' '), /consequential/);
  await tools.execute('respond_challenge', { id: 'Q1', reason: 'Evidence answers it', evidence: [{ sourceId: id, location: 'line 1' }] }, ctx);
  assert.equal(store.read().challenges.Q1.status, 'responded');
  await store.update(s => { s.challenges.Q1.severity = 'minor'; s.challenges.Q1.status = 'limitation'; });
  assert.deepEqual(evidenceGate(root, store.read(), store.read().tasks.work), []);
});

test('source mutation invalidates accepted tasks and propagates to dependents', async t => {
  const { store, root } = await setup(t); await task(store); const model = new FixtureModel(store);
  await runAgent(store, 'work', root, new AbortController().signal, { model, retrieve: fixtureRetrieval });
  await addTask(store, { id: 'next', prompt: 'dependent', stage: 'analysis', dependencies: ['work'], outputs: ['next.md'], writes: ['next.md'] });
  await store.update(s => { s.tasks.next.acceptance = 'accepted'; });
  const source = Object.values(store.read().sources)[0]; fs.appendFileSync(path.join(root, source.path), 'changed');
  await store.update(s => invalidate(root, s)); assert.equal(store.read().tasks.work.acceptance, 'stale'); assert.equal(store.read().tasks.next.acceptance, 'stale');
});

test('audit states remain distinct and stale hashes block delivery', async t => {
  const { root } = await setup(t); const source = path.join(root, 'main.tex'); fs.writeFileSync(source, 'paper');
  const audit = path.join(root, 'PAPER_CLAIM_AUDIT.json');
  for (const verdict of ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR']) {
    fs.writeFileSync(audit, JSON.stringify({ verdict, audited_input_hashes: { 'main.tex': hash(source) } }));
    assert.deepEqual(auditFreshness(audit), { verdict, stale: false, errors: [] });
  }
  fs.appendFileSync(source, 'changed'); assert.equal(auditFreshness(audit).stale, true);
});

test('uncertain model dispatch is persisted and never automatically retried', async t => {
  const { store } = await setup(t); await task(store);
  let calls = 0; const model: Model = { complete: async () => { calls++; throw new UncertainDispatch('timeout'); } };
  await assert.rejects(request(store, 'work', store.read().config.executor, model, [], new AbortController().signal), /timeout/);
  await assert.rejects(request(store, 'work', store.read().config.executor, model, [], new AbortController().signal), /Unreconciled/);
  assert.equal(calls, 1); assert.equal(store.read().usage.unknownRequests, 1);
  await assert.rejects(retry(store, 'work', 'Inspect outputs'), /reconciliation/);
  await retry(store, 'work', 'Inspect before repeating', 'Observed no completed response; authorized new request'); assert.equal(store.read().sessions.work.pending, undefined);
});

test('recovery reconciles dead process identity without redispatch and keeps a live worker', async t => {
  const { store } = await setup(t); await task(store);
  await store.update(s => { const t = s.tasks.work; t.execution = 'running'; t.worker = { pid: process.pid, start: 'different-process' }; });
  await reconcile(store); assert.equal(store.read().tasks.work.execution, 'interrupted');
  await store.update(s => { s.tasks.work.execution = 'running'; s.tasks.work.worker = identity(); });
  await reconcile(store); assert.equal(store.read().tasks.work.execution, 'running');
});

test('command cancellation kills local process group and keeps logs', async t => {
  const { store, root } = await setup(t, { allowCommands: true }); await task(store);
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error('cancel test')), 200);
  await assert.rejects(runCommand({ store, taskId: 'work', signal: controller.signal }, [process.execPath, '-e', 'console.log("started"); setInterval(()=>{},1000)']), /cancel test/);
  assert.equal(store.read().tasks.work.children.length, 0); assert.ok(fs.readdirSync(path.join(root, '.research-loop/logs')).length);
});

test('write scope rejects symlink escapes and runtime-state mutations', async t => {
  const { store, root } = await setup(t); await task(store);
  const tools = builtins(); const ctx = { store, taskId: 'work', signal: new AbortController().signal };
  await assert.rejects(tools.execute('write_file', { path: 'project.json', content: '{}' }, ctx), /scope/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(tools.execute('write_file', { path: 'escape/outside', content: 'x' }, ctx), /outside project/);
  await assert.rejects(addTask(store, { id: 'bad', prompt: 'bad', stage: 'topic', requiresTopic: false, outputs: ['project.json'], writes: ['project.json'] }), /Runtime state/);
});

test('portable bundle replays offline and detects tampered artifacts', async t => {
  const { store, root } = await setup(t); await task(store); await runAgent(store, 'work', root, new AbortController().signal, { model: new FixtureModel(store), retrieve: fixtureRetrieval });
  const bundle = path.join(root, 'bundle.json'); pack(store, bundle); assert.equal(replay(bundle).passed, true);
  const data = JSON.parse(fs.readFileSync(bundle, 'utf8')); data.files['work.md'].base64 = Buffer.from('changed').toString('base64'); fs.writeFileSync(bundle, JSON.stringify(data));
  assert.equal(replay(bundle).passed, false);
});

test('real HTTP provider and detached worker: concurrent scheduler ticks dispatch exactly once', async t => {
  process.env.TEST_RESEARCH_KEY = 'fixture-only';
  let executorCalls = 0; let reviewerCalls = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); let message;
    if (payload.model === 'reviewer') { reviewerCalls++; message = text(JSON.stringify(pass)); }
    else { executorCalls++; message = executorCalls === 1 ? call('write_file', { path: 'topic.md', content: '选题报告' }) : text('Done'); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address() as { port: number }; const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const { store, root } = await setup(t, { executor: { ...route, baseUrl }, reviewer: { ...route, baseUrl, family: 'reviewer', model: 'reviewer' } });
  await task(store, 'topic', 'topic');
  const launches = await Promise.all([tick(store, root), tick(store, root), tick(store, root)]);
  assert.equal(launches.flat().length, 1);
  const deadline = Date.now() + 15000;
  while ((store.read().tasks.topic.execution === 'running' || store.read().tasks.topic.startedAt) && Date.now() < deadline) await sleep(100);
  assert.equal(store.read().tasks.topic.acceptance, 'accepted', JSON.stringify(store.read().tasks.topic));
  assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL'); assert.equal(executorCalls, 2); assert.equal(reviewerCalls, 1);
  assert.equal(store.read().usage.requests, 3); assert.equal(store.read().usage.inputTokens, 30);
  await tick(store, root); assert.equal(store.read().tasks.topic.attempts, 1);
});

test('sandbox prevents commands from changing the control record while allowing assigned outputs', async t => {
  const { store, root } = await setup(t, { allowCommands: true }); await task(store);
  const before = fs.readFileSync(store.file, 'utf8');
  const result = await runCommand({ store, taskId: 'work', signal: new AbortController().signal }, [process.execPath, '-e', 'const fs=require("fs"); fs.writeFileSync("work.md","valid output"); try { fs.writeFileSync("project.json","corrupted"); process.exit(3); } catch { console.log("control record protected"); }']) as { exitCode: number; tail: string };
  assert.equal(result.exitCode, 0, result.tail); assert.match(result.tail, /protected/);
  assert.equal(fs.readFileSync(path.join(root, 'work.md'), 'utf8'), 'valid output');
  assert.equal(store.read().goal, JSON.parse(before).agentLoop.goal);
});

test('manuscript citations require a retrieved member, even when claims are registered', async t => {
  const { store, root } = await setup(t); await task(store, 'work', 'topic'); fs.writeFileSync(path.join(root, 'work.md'), '[source](https://unretrieved.example/paper)');
  assert.match(evidenceGate(root, store.read(), store.read().tasks.work).join(' '), /Unretrieved manuscript citation/);
});

test('required experiment record checker runs automatically, blocks missing runs, and reuses valid input hashes', async t => {
  const { store, root } = await setup(t); await task(store);
  await store.update(s => { s.tasks.work.stage = 'experiment'; });
  const skillRoot = path.resolve('.claude/skills');
  assert.match((await runChecks(store, 'work', skillRoot, new AbortController().signal)).join(' '), /Missing required/);
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, 'research/planned-runs.json'), '[{"run_id":"a"},{"run_id":"b"}]');
  fs.writeFileSync(path.join(root, 'research/observed-runs.json'), '[{"run_id":"a","status":"completed"}]');
  assert.match((await runChecks(store, 'work', skillRoot, new AbortController().signal)).join(' '), /failed/);
  fs.writeFileSync(path.join(root, 'research/observed-runs.json'), '[{"run_id":"a","status":"completed"},{"run_id":"b","status":"failed","reason":"OOM"}]');
  assert.deepEqual(await runChecks(store, 'work', skillRoot, new AbortController().signal), []);
  const count = store.read().events.filter(e => e.type === 'deterministic_check_started').length;
  assert.deepEqual(await runChecks(store, 'work', skillRoot, new AbortController().signal), []);
  assert.equal(store.read().events.filter(e => e.type === 'deterministic_check_started').length, count);
});

test('full enforced pipeline crosses the human checkpoint and delivers through real workers and HTTP fixtures', async t => {
  process.env.TEST_RESEARCH_KEY = 'fixture-only';
  let store: Store; let root: string; const calls: Record<string, number> = {};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ results: [{ id: 'https://openalex.org/fixture', title: 'Fixture primary evidence', updated_date: 'fixture-v1' }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); let message: Message;
    if (payload.model === 'reviewer') { const pack = JSON.parse(payload.messages[1].content); message = text(JSON.stringify({ ...pass, ...(pack.task.pipelineStep?.checkpoint ? { transition: { action: 'advance', reason: 'Fixture checkpoint criteria checked against original artifacts.' } } : {}) })); }
    else {
      const assignment = payload.messages.findLast((m: Message) => m.role === 'user' && m.content?.startsWith('{"goal"'));
      const current = JSON.parse(assignment.content.split('\n<skill')[0]).task;
      const index = calls[current.id] ?? 0; calls[current.id] = index + 1;
      if (index < current.outputs.length) {
        const output = current.outputs[index]; let content = `Fixture artifact for ${current.id}.`;
        if (output.endsWith('planned-runs.json')) content = '[{"run_id":"a"}]';
        if (output.endsWith('observed-runs.json')) content = '[{"run_id":"a","attempt_id":"1","status":"completed","score":0}]';
        if (output === 'PAPER_CLAIM_AUDIT.json') content = JSON.stringify({ verdict: 'PASS', audited_input_hashes: { 'research/manuscript.md': hash(path.join(root, 'research/manuscript.md')), 'research/observed-runs.json': hash(path.join(root, 'research/observed-runs.json')) } });
        message = call('write_file', { path: output, content }, `${current.id}-${index}`);
      } else if (index === current.outputs.length && current.stage !== 'topic') {
        message = call('record_claim', { id: `${current.id}-claim`, text: 'A fixture assertion for pipeline verification.', evidence: [{ sourceId: Object.keys(store.read().sources)[0], location: '$.title' }] }, `${current.id}-claim`);
      } else message = text('Ready for the runtime checks.');
    }
    res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ store, root } = await setup(t, { maxRequests: 80, searchUrl: baseUrl + '/works', executor: { ...route, baseUrl: baseUrl + '/v1' }, reviewer: { ...route, baseUrl: baseUrl + '/v1', family: 'reviewer', model: 'reviewer' } }));
  await pipeline(store); const skillRoot = path.resolve('.claude/skills');
  const waitForIdle = async () => {
    const deadline = Date.now() + 25000;
    do { await tick(store, skillRoot); if (!Object.values(store.read().tasks).some(t => t.execution === 'running' || t.startedAt)) return; await sleep(50); } while (Date.now() < deadline);
    throw new Error('Fixture pipeline timed out: ' + JSON.stringify(store.read().tasks));
  };
  await waitForIdle(); assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL');
  assert.equal(store.read().tasks.literature.attempts, 0);
  await approveTopic(store, 1, 'Explicit fixture user approval'); await waitForIdle();
  assert.ok(Object.values(store.read().tasks).every(t => t.acceptance === 'accepted'), JSON.stringify(store.read().tasks));
  assert.equal(store.read().events.filter(e => e.type === 'independent_review_started').length, 10);
  assert.equal(store.read().events.filter(e => e.type === 'adversarial_retrieval_started').length, 9);
  assert.ok(store.read().tasks.experiment.checks?.['run-records'].passed);
  assert.ok(store.read().tasks.delivery.checks?.['run-records'].passed);
  const bundle = path.join(root, 'delivery.json'); pack(store, bundle); assert.equal(replay(bundle).passed, true);
});

test('a major review challenge stays open until evidence-backed independent resolution', async t => {
  const { store, root } = await setup(t); await task(store);
  let reviews = 0; let executor = 0;
  const model: Model = { complete: async route => {
    const sourceId = Object.keys(store.read().sources)[0];
    if (route.family === 'reviewer') {
      reviews++;
      return { message: text(JSON.stringify(reviews === 1 ? { ...pass, verdict: 'FAIL', challenges: [{ id: 'Q1', claimId: 'C1', severity: 'major', reason: 'Explain counterevidence' }] } : { ...pass, resolvedChallengeIds: ['Q1'] })) };
    }
    const steps = [
      call('write_file', { path: 'work.md', content: 'The result is zero.' }),
      call('record_claim', { id: 'C1', text: 'The result is zero.', evidence: [{ sourceId, location: 'line 1' }] }), text('Done'),
      call('respond_challenge', { id: 'Q1', reason: 'The recorded counterevidence addresses this concern.', evidence: [{ sourceId, passage: 'Counterevidence was investigated.' }] }), text('Ready for recheck'),
    ]; return { message: steps[executor++] ?? text('Done') };
  } };
  await runAgent(store, 'work', root, new AbortController().signal, { model, retrieve: fixtureRetrieval });
  assert.equal(reviews, 2); assert.equal(store.read().challenges.Q1.status, 'resolved');
  assert.equal(store.read().tasks.work.acceptance, 'accepted');
  assert.ok(store.read().events.some(e => e.type === 'acceptance_blocked'));
});

test('reviewer failure is ERROR and cannot become scientific acceptance', async t => {
  const { store, root } = await setup(t); await task(store);
  const normal = new FixtureModel(store);
  const model: Model = { complete: async (route, messages, tools, signal) => route.family === 'reviewer' ? { message: text('not valid JSON') } : normal.complete(route, messages) };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve: fixtureRetrieval }));
  assert.equal(store.read().tasks.work.review?.verdict, 'ERROR'); assert.notEqual(store.read().tasks.work.acceptance, 'accepted');
  assert.ok(store.read().tasks.work.executionCompletedAt);
  const failure = store.read().events.find(e => e.type === 'independent_review_failed');
  assert.equal(failure?.data.task, 'work'); assert.equal(failure?.data.session, store.read().tasks.work.review?.session);
  assert.equal(failure?.data.uncertain, false);
});

test('knowledge can be reused across topics without importing approval or task acceptance', async t => {
  const first = await setup(t); await task(first.store); await runAgent(first.store, 'work', first.root, new AbortController().signal, { model: new FixtureModel(first.store), retrieve: fixtureRetrieval });
  const bundle = path.join(first.root, 'bundle.json'); pack(first.store, bundle);
  const second = await setup(t); await importKnowledge(second.store, bundle); await importKnowledge(second.store, bundle);
  assert.equal(Object.keys(second.store.read().sources).length, 1); assert.equal(Object.keys(second.store.read().claims).length, 1);
  assert.equal(second.store.read().topic.status, 'UNSELECTED'); assert.deepEqual(second.store.read().tasks, {});
  assert.equal(queryKnowledge(second.store, 'zero').claims.length, 1);
});

test('model resource cap stops before another dispatch', async t => {
  const { store, root } = await setup(t, { maxRequests: 1 }); await task(store, 'work', 'topic');
  const model = new FixtureModel(store, () => call('write_file', { path: 'work.md', content: 'artifact' }));
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model }), /budget exhausted/);
  assert.equal(model.executorCalls, 1); assert.equal(store.read().usage.requests, 1); assert.notEqual(store.read().tasks.work.acceptance, 'accepted');
});

test('unchanged failed reviews are reused instead of polling for a favorable verdict', async t => {
  const { store, root } = await setup(t, { maxNoProgress: 1 }); await task(store);
  const executor = new FixtureModel(store); let reviews = 0;
  const model: Model = { complete: async (route, messages) => {
    if (route.family !== 'reviewer') return executor.complete(route, messages);
    reviews++; return { message: text(JSON.stringify({ ...pass, verdict: 'BLOCKED', summary: 'Need more primary evidence' })) };
  } };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model, retrieve: fixtureRetrieval }), /no progress/);
  assert.equal(reviews, 1); assert.ok(store.read().events.some(e => e.type === 'independent_review_reused'));
});

test('execution and review have separate clocks while project time includes both', async t => {
  const { store } = await setup(t, { maxTaskSeconds: 10, maxReviewSeconds: 20, maxWallSeconds: 100 }); await task(store);
  const s = store.read(); const work = s.tasks.work; work.startedAt = 1000;
  assert.match(taskTimeLimit(s, work, 12000)!, /Execution time/);
  work.reviewStartedAt = 10000;
  assert.equal(taskTimeLimit(s, work, 12000), undefined, 'Review is not charged against the execution clock');
  assert.match(taskTimeLimit(s, work, 31000)!, /Review time/);
  delete work.reviewStartedAt; work.reviewElapsedSeconds = 5;
  assert.equal(taskTimeLimit(s, work, 15000), undefined, 'Completed review time is excluded during execution repair');
  assert.match(taskTimeLimit(s, work, 17000)!, /Execution time/);
  work.reviewStartedAt = 100000;
  assert.match(taskTimeLimit(s, work, 102000)!, /Project resource time/, 'Review cannot bypass the total project budget');
});

test('review-only retry preserves artifacts and skips executor and retrieval after a review error', async t => {
  const { store, root } = await setup(t); await task(store);
  const normal = new FixtureModel(store);
  const broken: Model = { complete: async (route, messages) => route.family === 'reviewer' ? { message: text('invalid JSON') } : normal.complete(route, messages) };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model: broken, retrieve: fixtureRetrieval }));
  const before = fs.readFileSync(path.join(root, 'work.md')); const completedAt = store.read().tasks.work.executionCompletedAt;
  await retry(store, 'work', 'Repair review input packaging; preserve completed work', undefined, true);
  let reviews = 0;
  const fixed: Model = { complete: async route => {
    assert.equal(route.family, 'reviewer', 'Recovery must not dispatch the executor'); reviews++;
    return { message: text(JSON.stringify(pass)) };
  } };
  await runAgent(store, 'work', root, new AbortController().signal, { model: fixed, retrieve: async () => { throw new Error('Retrieval must not restart'); } });
  assert.equal(reviews, 1); assert.equal(store.read().tasks.work.acceptance, 'accepted');
  assert.deepEqual(fs.readFileSync(path.join(root, 'work.md')), before);
  assert.equal(store.read().tasks.work.executionCompletedAt, completedAt);
  assert.ok(store.read().events.some(e => e.type === 'review_only_resumed'));
});

test('review-only retry rejects artifacts changed after queuing and does not dispatch a model', async t => {
  const { store, root } = await setup(t); await task(store);
  const normal = new FixtureModel(store);
  const broken: Model = { complete: async (route, messages) => route.family === 'reviewer' ? { message: text('invalid JSON') } : normal.complete(route, messages) };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model: broken, retrieve: fixtureRetrieval }));
  await retry(store, 'work', 'Retry the failed reviewer', undefined, true);
  fs.writeFileSync(path.join(root, 'work.md'), 'Changed after review-only retry was queued');
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, {
    model: { complete: async () => { assert.fail('No model call allowed with stale artifacts'); } },
  }), /Review-only retry inputs changed/);
});

test('review deadline aborts a slow reviewer without accepting its output', async t => {
  const { store, root } = await setup(t, { maxReviewSeconds: 0.05 }); await task(store);
  const normal = new FixtureModel(store);
  const slow: Model = { complete: async (route, messages, _tools, signal) => {
    if (route.family !== 'reviewer') return normal.complete(route, messages);
    await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return { message: text(JSON.stringify(pass)) };
  } };
  await assert.rejects(runAgent(store, 'work', root, new AbortController().signal, { model: slow, retrieve: fixtureRetrieval }), /Review time budget exhausted/);
  const result = store.read().tasks.work;
  assert.equal(result.review?.verdict, 'ERROR'); assert.notEqual(result.acceptance, 'accepted');
  assert.equal(result.reviewStartedAt, undefined); assert.ok(result.reviewElapsedSeconds! >= 0.05);
});

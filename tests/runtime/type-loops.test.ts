import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, hash, identity } from '../../src/store.js';
import { configSchema, paperTypes, type Message, type PaperType } from '../../src/types.js';
import { pipeline, blockers, approveTopic } from '../../src/workflow.js';
import { pipelineSpecs, syncPipeline } from '../../src/pipeline-plan.js';
import { applyWorkflowRevisions, validateTransition } from '../../src/loop-transitions.js';
import { executionGate } from '../../src/gates.js';
import { runAgent } from '../../src/agent.js';
import { tick, overlaps, usedSeconds } from '../../src/scheduler.js';
import { snapshot, type ToolContext } from '../../src/tools.js';
import { dashboardSnapshot } from '../../src/dashboard.js';
import { updateResearchInputs } from '../../src/research-inputs.js';
import type { Model } from '../../src/model.js';

const skillRoot = path.resolve('.claude/skills');
const route = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'executor', apiKeyEnv: 'TYPE_LOOP_FIXTURE_KEY' };
const pass = { verdict: 'PASS', summary: 'Fixture evidence checked.', challenges: [], resolvedChallengeIds: [], limitations: [] };
const advance = { action: 'advance', reason: 'Fixture checkpoint criteria are satisfied.' };
const revision = { action: 'revise', target: 'experiment', reason: 'The proof has an unresolved step; repair the proof artifact.' };
const message = (content: string): Message => ({ role: 'assistant', content });

async function setup(t: test.TestContext, type: PaperType = 'theory', overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'type-loop-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('A bounded contribution-specific fixture', configSchema.parse({ executor: route, reviewer: { ...route, model: 'reviewer', family: 'reviewer' }, maxNoProgress: 1, maxRequests: 150, ...overrides }), 'automatic', { paperType: type, seedPapers: [], targetJournal: null });
  await pipeline(store); return { store, root };
}

test('eight paper types have distinct dependency graphs, mandatory checkpoints and valid back edges', async t => {
  const graphs = new Set<string>();
  for (const type of paperTypes) {
    const { store, root } = await setup(t, type); const state = store.read(); const specs = pipelineSpecs(type);
    graphs.add(JSON.stringify(specs.map(spec => [spec.id, spec.dependencies])));
    const seen = new Set<string>();
    for (const spec of specs) {
      assert.ok(spec.dependencies.every(id => seen.has(id)), 'Forward graph must be topological'); seen.add(spec.id);
      for (const target of spec.pipelineStep.checkpoint?.reworkTargets ?? []) assert.ok(seen.has(target) && target !== 'topic' && target !== spec.id);
      assert.ok(spec.outputs.every(file => spec.id === 'delivery' || state.tasks.delivery.inputs.includes(file)));
    }
    const gate = specs.find(spec => spec.pipelineStep.checkpoint)!;
    assert.ok(blockers(state, gate.id).length);
    let calls = 0;
    await assert.rejects(runAgent(store, gate.id, root, new AbortController().signal, { model: { async complete() { calls++; return { message: message('Bypass') }; } } }), /prerequisites/);
    assert.equal(calls, 0);
    const shown = dashboardSnapshot(state, store.file);
    assert.deepEqual(shown.pipelineGraph?.nodes.map(node => node.id), specs.map(spec => spec.id));
  }
  assert.equal(graphs.size, 8);
  const { store } = await setup(t, 'theory'); const state = store.read();
  assert.deepEqual(state.tasks.proof_audit.dependencies, ['experiment', 'counterexamples']);
  assert.equal(overlaps(state.tasks.experiment, state.tasks.counterexamples), false, 'Independent proof/counterexample branches can run concurrently');
});

async function preparedGate(t: test.TestContext) {
  const { store, root } = await setup(t);
  for (const task of Object.values(store.read().tasks)) for (const file of task.outputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), `Fixture artifact for ${task.id}.`);
  }
  await store.update(s => {
    s.topic = { version: 1, status: 'APPROVED', approval: 'Fixture user approval' };
    for (const id of ['topic', 'literature', 'plan', 'experiment', 'counterexamples']) { s.tasks[id].execution = 'completed'; s.tasks[id].acceptance = 'accepted'; s.tasks[id].attempts = 1; }
    s.tasks.proof_audit.execution = 'running'; s.tasks.proof_audit.attempts = 1;
  });
  const retrieve = async (ctx: ToolContext) => {
    const id = await snapshot(ctx, { identity: 'fixture:proof', title: 'Fixture premise', version: '1', content: 'This fixture premise is supported.' });
    await store.update(s => {
      s.tasks.proof_audit.retrievals.push({ query: 'Counterevidence', intent: 'adversarial', sourceIds: [id] });
      s.tasks.proof_audit.claimIds = ['C1']; s.claims.C1 = { id: 'C1', taskId: 'proof_audit', text: 'Fixture premise', evidence: [{ sourceId: id, passage: 'This fixture premise is supported.' }], revision: 1 };
    }); return [{ sourceId: id }];
  };
  const run = async (reply: unknown) => {
    const model: Model = { async complete(_route, messages, tools) {
      if (!tools.length) { const pack = JSON.parse(messages[1].content!); assert.ok(pack.task.pipelineStep.checkpoint.reworkTargets.includes('experiment')); return { message: message(JSON.stringify(reply)) }; }
      return { message: message('Ready') };
    } };
    await runAgent(store, 'proof_audit', skillRoot, new AbortController().signal, { model, retrieve });
  };
  return { store, root, run };
}

test('checkpoint reviews cannot omit the transition, skip an ancestor or contradict their verdict', async t => {
  for (const reply of [pass, { ...pass, transition: revision }, { ...pass, verdict: 'FAIL', transition: { ...revision, target: 'writing' } }, { ...pass, verdict: 'FAIL', transition: { ...revision, target: 'topic' } }]) {
    const { store, run } = await preparedGate(t); await assert.rejects(run(reply));
    assert.equal(store.read().tasks.proof_audit.review?.verdict, 'ERROR'); assert.equal(store.read().tasks.proof_audit.pendingRework, undefined);
    assert.notEqual(store.read().tasks.proof_audit.acceptance, 'accepted');
  }
  const { store } = await setup(t); assert.throws(() => validateTransition(store.read().tasks.experiment, { verdict: 'PASS', transition: { action: 'advance', reason: 'Unexpected' } }), /Only workflow checkpoints/);
});

test('a reviewed back edge preserves history, reopens only affected nodes and requires changed repair artifacts', async t => {
  const { store, root, run } = await preparedGate(t); await run({ ...pass, verdict: 'FAIL', transition: revision });
  const before = store.read(); assert.equal(before.tasks.proof_audit.pendingRework?.target, 'experiment');
  assert.ok(blockers(before, 'analysis').includes('WORKFLOW_REVISION_PENDING'));
  await store.update(s => applyWorkflowRevisions(s, root)); const state = store.read();
  assert.equal(state.pipelineGraph?.revisions, 1); assert.equal(state.tasks.experiment.execution, 'pending');
  assert.equal(state.tasks.proof_audit.execution, 'pending'); assert.equal(state.tasks.proof_audit.review, undefined);
  assert.equal(state.tasks.counterexamples.acceptance, 'accepted'); assert.equal(state.topic.status, 'APPROVED');
  assert.ok(state.events.some(event => event.type === 'workflow_node_reopened' && (event.data.previous as { review?: unknown }).review));
  assert.ok(executionGate(root, state.tasks.experiment).some(error => error.includes('changed repair artifacts')));
  fs.appendFileSync(path.join(root, 'research/proofs.md'), '\nRepaired proof step with a grounded justification.');
  assert.deepEqual(executionGate(root, state.tasks.experiment), []);
  await store.update(s => applyWorkflowRevisions(s, root)); assert.equal(store.read().pipelineGraph?.revisions, 1, 'Scheduler ticks cannot replay a consumed revision');
});

test('workflow revisions wait for live workers and stop at resource, uncertainty and evidence boundaries', async t => {
  for (const condition of ['worker', 'limit', 'uncertain', 'evidence', 'inputs'] as const) {
    const { store, root, run } = await preparedGate(t); await run({ ...pass, verdict: 'BLOCKED', transition: revision });
    await store.update(s => {
      if (condition === 'worker') s.tasks.proof_audit.worker = identity();
      if (condition === 'limit') s.config.maxWorkflowRevisions = 0;
      if (condition === 'uncertain') s.sessions.main.pending = { kind: 'tool', id: 'uncertain-call' };
    });
    if (condition === 'evidence') fs.appendFileSync(path.join(root, 'research/proofs.md'), ' changed during scheduling');
    if (condition === 'inputs') await updateResearchInputs(store, { paperType: 'theory', seedPapers: [], targetJournal: { name: 'Changed scope' } }, 1);
    await store.update(s => applyWorkflowRevisions(s, root)); const state = store.read();
    assert.equal(state.pipelineGraph?.revisions, 0); assert.equal(state.tasks.experiment.execution, 'completed');
    if (condition === 'worker') assert.ok(state.tasks.proof_audit.pendingRework);
    else assert.equal(state.tasks.proof_audit.pendingRework, undefined);
  }
});

test('reviewed stop does not trigger another model call or automatic revision', async t => {
  const { store, root, run } = await preparedGate(t);
  await run({ ...pass, verdict: 'BLOCKED', transition: { action: 'stop', reason: 'Required original evidence is unavailable.' } });
  const calls = store.read().usage.requests; await store.update(s => applyWorkflowRevisions(s, root));
  assert.equal(store.read().usage.requests, calls); assert.equal(store.read().tasks.proof_audit.acceptance, 'blocked');
  assert.equal(store.read().tasks.proof_audit.pendingRework, undefined); assert.ok(store.read().events.some(event => event.type === 'workflow_stopped'));
});

test('switching contribution retires old branch nodes without losing their artifacts or dispatching them', async t => {
  const { store } = await setup(t, 'method'); await store.update(s => { s.tasks.mechanism_check.attempts = 1; s.tasks.mechanism_check.execution = 'failed'; s.tasks.mechanism_check.elapsedSeconds = 42; });
  const old = store.read().tasks.mechanism_check;
  await updateResearchInputs(store, { paperType: 'survey', seedPapers: [], targetJournal: null }, 1);
  const state = store.read(); assert.deepEqual(state.tasks.mechanism_check, old);
  assert.ok(blockers(state, 'mechanism_check').includes('WORKFLOW_NODE_RETIRED'));
  assert.ok(state.tasks.coverage_audit); assert.ok(!dashboardSnapshot(state, store.file).tasks.some(task => task.id === 'mechanism_check'));
  const shown = dashboardSnapshot(state, store.file);
  assert.deepEqual(shown.tasks.map(task => task.id), state.pipelineGraph!.taskIds);
  assert.equal(Object.hasOwn(shown.pipelineGraph!, 'maxRevisions'), false);
  assert.equal(usedSeconds(state), 42, 'Retired nodes still count against the time budget');
  const before = state.events.length; await store.update(syncPipeline); assert.equal(store.read().events.length, before);
});

test('real workers execute the theory branch and reviewed proof repair before delivery', async t => {
  process.env.TYPE_LOOP_FIXTURE_KEY = 'fixture-only'; let store: Store; let root: string; const calls: Record<string, number> = {}; let auditReviews = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ results: [{ id: 'fixture:theory-source', title: 'Fixture formal evidence', updated_date: '1' }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk; const request = JSON.parse(body); let reply: Message;
    if (request.model === 'reviewer') {
      const pack = JSON.parse(request.messages[1].content); const repair = pack.task.id === 'proof_audit' && auditReviews++ === 0;
      reply = message(JSON.stringify({ ...pass, ...(repair ? { verdict: 'FAIL' } : {}), ...(pack.task.pipelineStep?.checkpoint ? { transition: repair ? revision : advance } : {}) }));
    } else {
      const assignment = request.messages.findLast((item: Message) => item.role === 'user' && item.content?.startsWith('{"goal"'));
      const task = JSON.parse(assignment.content.split('\n<skill')[0]).task; const key = `${task.id}:${task.attempts}`; const index = calls[key] ?? 0; calls[key] = index + 1;
      const tool = (name: string, args: unknown): Message => ({ role: 'assistant', content: null, tool_calls: [{ id: `${task.id}-${task.attempts}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (index < task.outputs.length) {
        const file = task.outputs[index]; const content = file === 'PAPER_CLAIM_AUDIT.json' ? JSON.stringify({ verdict: 'PASS', audited_input_hashes: { 'research/manuscript.md': hash(path.join(root, 'research/manuscript.md')) } }) : `Fixture ${task.id}, attempt ${task.attempts}.`;
        reply = tool('write_file', { path: file, content });
      } else if (index === task.outputs.length && task.stage !== 'topic') reply = tool('record_claim', { id: `${task.id}-claim`, text: 'Fixture formal premise.', evidence: [{ sourceId: Object.keys(store.read().sources)[0], location: '$.title' }] });
      else reply = message('Ready for independent checking.');
    }
    res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ store, root } = await setup(t, 'theory', { executor: { ...route, baseUrl: url }, reviewer: { ...route, baseUrl: url, model: 'reviewer', family: 'reviewer' }, searchUrl: url + '/search' }));
  const idle = async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await tick(store, skillRoot); const state = store.read();
      if (!Object.values(state.tasks).some(task => task.execution === 'running' || task.startedAt || task.pendingRework)) return;
      await sleep(50);
    }
    throw new Error('Theory fixture timed out');
  };
  await idle(); assert.equal(store.read().topic.status, 'AWAITING_TOPIC_APPROVAL');
  await approveTopic(store, 1, 'Approve this fixture theory topic'); await idle(); const state = store.read();
  assert.ok(Object.values(state.tasks).every(task => task.acceptance === 'accepted'), JSON.stringify(Object.values(state.tasks).map(task => ({ id: task.id, acceptance: task.acceptance, reasons: task.reasons }))));
  assert.equal(state.tasks.experiment.attempts, 2); assert.equal(state.tasks.counterexamples.attempts, 1); assert.equal(state.tasks.proof_audit.attempts, 2);
  assert.equal(state.pipelineGraph?.revisions, 1); assert.equal(state.tasks.delivery.acceptance, 'accepted');
  assert.ok(!fs.existsSync(path.join(root, 'research/observed-runs.json')));
});

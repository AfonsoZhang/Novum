import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { boundToolContent, READ_PAGE_BYTES, textPage, TOOL_OUTPUT_BYTES } from '../../src/tool-output.js';
import { builtins, snapshot, ToolRegistry } from '../../src/tools.js';
import { runAgent } from '../../src/agent.js';
import { Store } from '../../src/store.js';
import { addTask } from '../../src/workflow.js';
import { request, type Model } from '../../src/model.js';
import { traceDetail } from '../../src/trace.js';
import { testConfig } from './fixtures.js';
import { boundReviewInput } from '../../src/review-input.js';

async function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json')); await store.init('Fixture', testConfig());
  await addTask(store, { id: 'topic', stage: 'topic', prompt: 'Fixture', outputs: ['topic.md'], writes: ['topic.md'], requiresTopic: false });
  return { root, store, ctx: { store, taskId: 'topic', signal: new AbortController().signal } };
}

test('byte pages reconstruct Unicode and a single large line without dropping content or stalling', () => {
  const input = '中文🙂abc'.repeat(100); let offset = 0; let reconstructed = '';
  for (;;) {
    const page = textPage(input, offset, 7); reconstructed += page.content;
    assert.ok(Buffer.byteLength(page.content) <= 7); assert.ok(!page.content.includes('\ufffd'));
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(reconstructed, input);
  assert.throws(() => textPage(input, 99999), /outside/);
});

test('fetched HTML retains exact raw evidence and exposes bounded readable pages and literal search', async t => {
  const { root, store, ctx } = await project(t);
  const html = '<html><script>' + 'hidden-script'.repeat(90000) + '</script><body><h1>Paper &amp; evidence</h1><p>' + '可核验正文 '.repeat(8000) + '</p><p>CONCLUSION_MARKER</p></body></html>';
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = builtins();
  const output = await registry.execute('fetch_source', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, title: 'Fixture paper' }, ctx) as Record<string, any>;
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= TOOL_OUTPUT_BYTES);
  assert.equal(fs.readFileSync(path.join(root, output.rawPath), 'utf8'), html);
  assert.equal(store.read().sources[output.sourceId].path, output.rawPath);
  assert.match(output.content, /Paper & evidence/); assert.doesNotMatch(output.content, /hidden-script/);
  assert.equal(output.truncated, true); assert.ok(output.nextOffset > 0);
  const found = await registry.execute('read_file', { path: output.readPath, query: 'CONCLUSION_MARKER', limit: 500 }, ctx) as Record<string, any>;
  assert.match(found.content, /CONCLUSION_MARKER/); assert.ok(Buffer.byteLength(found.content) <= 500);
  const next = await registry.execute('read_file', { path: output.readPath, offset: output.nextOffset }, ctx) as Record<string, any>;
  assert.equal(next.offset, output.nextOffset); assert.ok(Buffer.byteLength(next.content) <= READ_PAGE_BYTES);
});

test('generic oversized outputs preserve complete bytes and show both preview and continuation instructions', async t => {
  const { root, ctx } = await project(t); const text = 'BEGIN ' + '\u0001🙂'.repeat(30000) + ' END';
  const registry = new ToolRegistry();
  registry.register({ declaration: { type: 'function', function: { name: 'fixture', description: '', parameters: {} } }, async run() { return text; } });
  const output = await registry.execute('fixture', {}, ctx) as Record<string, any>;
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < TOOL_OUTPUT_BYTES);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, output.fullOutputPath), 'utf8')), text);
  assert.match(output.content, /BEGIN/); assert.match(output.tail, /END/); assert.equal(output.outputTruncated, true);
});

test('legacy oversized tool messages are projected without changing historical messages, IDs, or trace inputs', async t => {
  const { root, store } = await project(t);
  const original = JSON.stringify({ sourceId: 'src_fixture', content: '<html><body>BEGIN ' + 'content '.repeat(200000) + ' END</body></html>' });
  await store.update(s => { s.sessions.main.messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fetch_source', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: original },
  ]; });
  const model: Model = { async complete(_route, messages) {
    assert.equal(messages[1].tool_call_id, 'call_1');
    assert.ok(Buffer.byteLength(JSON.stringify(messages)) < TOOL_OUTPUT_BYTES);
    const result = JSON.parse(messages[1].content!); assert.equal(result.sourceId, 'src_fixture');
    assert.equal(fs.readFileSync(path.join(root, result.fullOutputPath), 'utf8'), original);
    return { message: { role: 'assistant', content: 'Continue with paged evidence.' } };
  } };
  await request(store, 'main', store.read().config.executor, model, [], new AbortController().signal, { task: 'topic', phase: 'executor' });
  const state = store.read(); assert.equal(state.sessions.main.messages[1].content, original);
  const started = state.events.find(e => e.type === 'model_request_started')!;
  const shown = traceDetail(state, started.seq).sections.find(s => s.title === '发送给模型的消息')!;
  assert.match(shown.text, /fullOutputPath/);
  assert.equal(JSON.parse(shown.text)[1].content, (started.data.messageOverrides as { content: string }[])[0].content);
  assert.equal(boundToolContent(root, '"small"'), '"small"');
});

test('independent review pages full evidence through read-only scoped tools and preserves the raw source', async t => {
  const { root, store, ctx } = await project(t);
  await store.update(s => { s.researchInputs!.paperType = 'method'; });
  const raw = 'Introduction\n' + 'raw evidence '.repeat(30000) + '\nDECISIVE_RESULT: zero';
  const sourceId = await snapshot(ctx, { identity: 'fixture:large-source', version: '1', title: 'Large raw evidence', content: raw });
  await store.update(s => { s.tasks.topic.retrievals.push({ query: 'fixture', intent: 'adversarial', sourceIds: [sourceId] }); });
  let executorCalls = 0; let reviewCalls = 0; let readPath = '';
  const model: Model = { async complete(route, messages, declarations) {
    if (route.family === store.read().config.executor.family) {
      executorCalls++;
      return { message: executorCalls === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'topic.md', content: 'A grounded fixture topic.' }) } }] }
        : { role: 'assistant', content: 'Ready for review.' } };
    }
    reviewCalls++;
    assert.deepEqual(declarations.map(d => d.function.name), ['read_file']);
    if (reviewCalls === 1) {
      const pack = JSON.parse(messages[1].content!);
      const preview = pack.originalArtifacts[store.read().sources[sourceId].path]; readPath = preview.readPath;
      assert.ok(preview.outputTruncated); assert.ok(Buffer.byteLength(messages[1].content!) < 40000);
      return { message: { role: 'assistant', content: null, tool_calls: [
        { id: 'forbidden', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'project.json' }) } },
        { id: 'read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: readPath, query: 'DECISIVE_RESULT', limit: 200 }) } },
      ] } };
    }
    const rejected = messages.find(m => m.tool_call_id === 'forbidden')!;
    assert.match(rejected.content!, /only read files/);
    const read = messages.find(m => m.tool_call_id === 'read')!;
    assert.match(read.content!, /DECISIVE_RESULT: zero/);
    return { message: { role: 'assistant', content: JSON.stringify({ verdict: 'PASS', summary: 'Checked original evidence.', challenges: [], resolvedChallengeIds: [], limitations: [] }) } };
  } };
  await runAgent(store, 'topic', root, new AbortController().signal, { model });
  assert.equal(store.read().tasks.topic.acceptance, 'accepted'); assert.equal(reviewCalls, 2);
  assert.equal(fs.readFileSync(path.join(root, store.read().sources[sourceId].path), 'utf8'), raw);
});

test('review input caps the aggregate of many individually small sources and keeps them readable', async t => {
  const { root, store, ctx } = await project(t);
  await store.update(s => { s.researchInputs!.paperType = 'method'; s.config.maxReviewInputBytes = 32768; });
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push(await snapshot(ctx, { identity: `fixture:source-${i}`, version: '1', title: `Source ${i}`, content: 'Evidence '.repeat(4000) + ` DECISIVE_${i}` }));
  await store.update(s => { s.tasks.topic.retrievals.push({ query: 'fixture', intent: 'adversarial', sourceIds: ids }); });
  let executorCalls = 0; let reviewerCalls = 0; let selected = '';
  const model: Model = { async complete(route, messages, declarations) {
    if (route.family === 'executor') {
      if (!executorCalls++) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'topic.md', content: 'Review all retrieved evidence.' }) } }] } };
      return { message: { role: 'assistant', content: 'Ready for review' } };
    }
    if (!reviewerCalls++) {
      assert.ok(Buffer.byteLength(messages[1].content!) <= 32768);
      const pack = JSON.parse(messages[1].content!); const source = store.read().sources[ids[0]];
      selected = pack.originalArtifacts[source.path].readPath;
      assert.equal(selected, source.path); assert.ok(pack.originalArtifacts[selected].outputTruncated);
      assert.deepEqual(declarations.map(d => d.function.name), ['read_file']);
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: selected, query: 'DECISIVE_0', limit: 200 }) } }] } };
    }
    assert.match(messages.find(m => m.tool_call_id === 'read')!.content!, /DECISIVE_0/);
    return { message: { role: 'assistant', content: JSON.stringify({ verdict: 'PASS', summary: 'Fixture evidence inspected', challenges: [], resolvedChallengeIds: [], limitations: [] }) } };
  } };
  await runAgent(store, 'topic', root, new AbortController().signal, { model });
  assert.equal(reviewerCalls, 2); assert.equal(store.read().tasks.topic.acceptance, 'accepted');
  assert.ok(fs.readFileSync(path.join(root, selected), 'utf8').endsWith('DECISIVE_0'));
});

test('oversized review claim indexes are deferred losslessly instead of bypassing the aggregate limit', async t => {
  const { root } = await project(t); const allowed = new Set<string>();
  const claims = Array.from({ length: 100 }, (_, i) => ({ id: `C${i}`, text: '中文 evidence '.repeat(100) }));
  const result = boundReviewInput(root, { task: { id: 'topic' }, claims, originalArtifacts: {} }, allowed, 4096);
  assert.ok(Buffer.byteLength(result) <= 4096);
  const pack = JSON.parse(result); assert.ok(pack.claims.outputTruncated);
  assert.ok(allowed.has(path.join(root, pack.claims.readPath)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, pack.claims.readPath), 'utf8')), claims);
});

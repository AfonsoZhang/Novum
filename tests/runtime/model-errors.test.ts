import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpModel, request, UncertainDispatch } from '../../src/model.js';
import { configSchema } from '../../src/types.js';
import { Store } from '../../src/store.js';

async function fixture(t: test.TestContext, handler: http.RequestListener) {
  const keyName = 'MODEL_ERRORS_FIXTURE_KEY'; const key = 'fixture-private-key-123';
  const previous = process.env[keyName]; process.env[keyName] = key;
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
  });
  const config = configSchema.parse({ executor: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture', family: 'fixture', apiKeyEnv: keyName } });
  return { config, key };
}

test('HTTP rejection persists useful sanitized diagnostics, clears pending state and never retries', async t => {
  let calls = 0;
  const { config, key } = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Request-ID': 'fixture-request-17' });
    res.end(JSON.stringify({ error: { message: 'Invalid messages[8]: api_key=fixture-private-key-123; Bearer unrelated-token',
      type: 'invalid_request_error', code: 'invalid_message', param: 'messages[8]', request: { secret: 'must-not-log-request' } },
      headers: { authorization: 'must-not-log-headers' } }));
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-errors-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json')); await store.init('Fixture', config);
  await store.update(s => { s.sessions.main = { messages: [{ role: 'user', content: 'Fixture request' }], inbox: [] }; });
  await assert.rejects(request(store, 'main', config.executor, new HttpModel(), [], new AbortController().signal), error => {
    assert.ok(error instanceof Error && !(error instanceof UncertainDispatch));
    assert.match(error.message, /Model HTTP 400; no automatic retry/);
    assert.match(error.message, /request_id=fixture-request-17/);
    assert.match(error.message, /param=messages\[8\]/);
    return true;
  });
  const state = store.read(); const persisted = await fs.readFile(store.file, 'utf8');
  assert.match(persisted, /invalid_message/);
  for (const secret of [key, 'unrelated-token', 'must-not-log-request', 'must-not-log-headers']) assert.ok(!persisted.includes(secret));
  assert.equal(calls, 1); assert.equal(state.usage.unknownRequests, 0); assert.equal(state.sessions.main.pending, undefined);
  assert.equal(state.events.at(-1)?.type, 'model_request_failed');
});

test('plain-text and oversized error responses remain bounded without leaking credentials', async t => {
  let large = false;
  const { config, key } = await fixture(t, (_req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(large ? 'x'.repeat(20000) + 'fixture-private-key-123' : 'Gateway rejected token: fixture-private-key-123; password="private value"');
  });
  for (const oversized of [false, true]) {
    large = oversized;
    await assert.rejects(new HttpModel().complete(config.executor, [], [], new AbortController().signal), error => {
      assert.ok(error instanceof Error && !(error instanceof UncertainDispatch));
      assert.match(error.message, /Model HTTP 502/);
      assert.ok(error.message.length < 3200); assert.ok(!error.message.includes(key)); assert.ok(!error.message.includes('private value'));
      assert.match(error.message, oversized ? /byte limit/ : /Gateway rejected/); return true;
    });
  }
});

test('incomplete HTTP error bodies retain the known rejection status', async t => {
  const { config } = await fixture(t, (_req, res) => { res.writeHead(400); res.flushHeaders(); res.write('{"error":'); });
  await assert.rejects(new HttpModel().complete({ ...config.executor, requestTimeoutMs: 100 }, [], [], new AbortController().signal), error => {
    assert.ok(error instanceof Error && !(error instanceof UncertainDispatch));
    assert.match(error.message, /Model HTTP 400.*Error response unavailable/); return true;
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HttpModel,
  Limited,
  TypedModelError,
  UncertainDispatch,
  classifyHttpFailure,
  parseRetryAfterMs,
  request,
} from '../../src/model.js';
import { compactSession, computeContextBudget, projectMessagesForModel, safeSplitBoundaries } from '../../src/context-budget.js';
import { preflightProvider } from '../../src/preflight.js';
import { configSchema, type Message } from '../../src/types.js';
import { Store } from '../../src/store.js';

async function httpFixture(t: test.TestContext, handler: http.RequestListener) {
  const keyName = 'HARDENING_FIXTURE_KEY';
  const key = 'fixture-secret-xyz';
  const previous = process.env[keyName];
  process.env[keyName] = key;
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  });
  const port = (server.address() as { port: number }).port;
  return { keyName, key, baseUrl: `http://127.0.0.1:${port}/v1` };
}

test('proactive model-aware compaction retains raw history, preserves tool pairs, and pins decisions/IDs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-proactive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  const config = configSchema.parse({
    executor: {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'fixture-model',
      family: 'fixture',
      apiKeyEnv: 'K',
      maxOutputTokens: 256,
      contextWindowTokens: 1200,
      compactThresholdRatio: 0.7,
    },
  });
  await store.init('Verify proactive compaction', config);
  const longBlock = 'Evidence block '.repeat(60);
  const rawMessages: Message[] = [
    { role: 'system', content: 'System prompt stays pinned.' },
    { role: 'user', content: 'Investigate CLM-1 and DEC-42 with SRC-9.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'tc-1', content: longBlock },
    { role: 'assistant', content: 'Observed first block for CLM-1.' },
    { role: 'user', content: 'Continue with second check.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } }] },
    { role: 'tool', tool_call_id: 'tc-2', content: longBlock },
    { role: 'assistant', content: 'Latest finding ready.' },
  ];
  await store.update(s => {
    s.topic = { version: 1, status: 'APPROVED', approval: 'Approved by researcher' };
    s.sessions.main = { messages: rawMessages, inbox: [] };
  });

  // Ensure safeSplitBoundaries never starts on a tool message.
  const boundaries = safeSplitBoundaries(rawMessages, 1);
  assert.ok(!boundaries.some(idx => rawMessages[idx].role === 'tool'));

  let seenMessages: Message[] = [];
  const reply = await request(
    store,
    'main',
    config.executor,
    {
      complete: async (_route, messages) => {
        seenMessages = messages;
        return { message: { role: 'assistant', content: 'Done' }, usage: { prompt_tokens: 100, completion_tokens: 10 } };
      },
    },
    [],
    new AbortController().signal,
  );
  assert.equal(reply.content, 'Done');

  const state = store.read();
  const session = state.sessions.main;
  // Raw history retained intact (+1 assistant reply).
  assert.equal(session.messages.length, rawMessages.length + 1);
  assert.ok(session.compaction);
  assert.equal(session.compaction.reason, 'proactive_budget');
  assert.ok(session.compaction.keptFromIndex > 1);
  assert.notEqual(session.messages[session.compaction.keptFromIndex].role, 'tool');
  assert.ok(session.compaction.summary.includes('CLM-1'));
  assert.ok(session.compaction.summary.includes('DEC-42'));
  assert.ok(session.compaction.summary.includes('Approved by researcher'));
  assert.ok(seenMessages[0].role === 'system');
  assert.ok(seenMessages[1].content?.includes('[Compacted context summary'));
  assert.ok(state.events.some(e => e.type === 'context_compacted'));
});

test('context overflow triggers exactly one bounded compaction recovery', async t => {
  const { keyName, baseUrl } = await httpFixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.messages.length > 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model maximum context length is 4096 tokens', code: 'context_length_exceeded' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Recovered after compaction' } }] }));
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-overflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  const config = configSchema.parse({
    executor: { baseUrl, model: 'fixture', family: 'fixture', apiKeyEnv: keyName, contextWindowTokens: 500_000 },
  });
  await store.init('Overflow recovery test', config);
  await store.update(s => {
    s.sessions.main = {
      inbox: [],
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Reply 1' },
        { role: 'user', content: 'Turn 2' },
        { role: 'assistant', content: 'Reply 2' },
        { role: 'user', content: 'Final question' },
      ],
    };
  });

  const reply = await request(store, 'main', config.executor, new HttpModel(), [], new AbortController().signal);
  assert.equal(reply.content, 'Recovered after compaction');
  const state = store.read();
  assert.equal(state.sessions.main.compaction?.reason, 'context_overflow');
  assert.equal(state.usage.requests, 2);

  // If provider still overflows even after one recovery, do not loop infinitely.
  const { keyName: k2, baseUrl: url2 } = await httpFixture(t, (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } }));
  });
  const cfg2 = configSchema.parse({ executor: { baseUrl: url2, model: 'fixture', family: 'fixture', apiKeyEnv: k2, contextWindowTokens: 500_000 } });
  await store.update(s => {
    delete s.sessions.main.compaction;
    s.sessions.main.messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'T1' },
      { role: 'assistant', content: 'R1' },
      { role: 'user', content: 'T2' },
    ];
  });
  await assert.rejects(request(store, 'main', cfg2.executor, new HttpModel(), [], new AbortController().signal), err => {
    assert.ok(err instanceof TypedModelError && err.category === 'context_overflow');
    return true;
  });
});

test('typed error recovery retries rate_limit and provider_outage within budget, never retries auth or uncertain dispatch', async t => {
  let step = 0;
  const { keyName, baseUrl } = await httpFixture(t, (_req, res) => {
    step++;
    if (step === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' } }));
      return;
    }
    if (step === 2) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Succeeded after transient retries' } }] }));
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  const config = configSchema.parse({
    executor: { baseUrl, model: 'fixture', family: 'fixture', apiKeyEnv: keyName },
    maxErrorRetries: 2,
    retryBaseDelayMs: 5,
    maxRetryDelayMs: 1000,
  });
  await store.init('Typed retry test', config);
  await store.update(s => { s.sessions.main = { messages: [{ role: 'user', content: 'Hi' }], inbox: [] }; });

  const reply = await request(store, 'main', config.executor, new HttpModel(), [], new AbortController().signal);
  assert.equal(reply.content, 'Succeeded after transient retries');
  assert.equal(step, 3);
  assert.equal(store.read().usage.requests, 3);
  assert.equal(store.read().events.filter(e => e.type === 'model_retry_scheduled').length, 2);

  // Authentication failure (401) must never retry.
  let authCalls = 0;
  const authServer = await httpFixture(t, (_req, res) => {
    authCalls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }));
  });
  const authCfg = configSchema.parse({ executor: { baseUrl: authServer.baseUrl, model: 'fixture', family: 'fixture', apiKeyEnv: authServer.keyName }, maxErrorRetries: 3, retryBaseDelayMs: 5 });
  await assert.rejects(request(store, 'main', authCfg.executor, new HttpModel(), [], new AbortController().signal), err => {
    assert.ok(err instanceof TypedModelError && err.category === 'authentication' && !err.retryable);
    return true;
  });
  assert.equal(authCalls, 1);

  // Retry-After exceeding maxRetryDelayMs throws Limited instead of sleeping beyond budget.
  const slowLimit = await httpFixture(t, (_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    res.end(JSON.stringify({ error: { message: 'Slow down' } }));
  });
  const slowCfg = configSchema.parse({ executor: { baseUrl: slowLimit.baseUrl, model: 'fixture', family: 'fixture', apiKeyEnv: slowLimit.keyName }, maxErrorRetries: 2, maxRetryDelayMs: 500 });
  await assert.rejects(request(store, 'main', slowCfg.executor, new HttpModel(), [], new AbortController().signal), Limited);

  // UncertainDispatch must never retry and leaves pending state intact.
  let uncertainCalls = 0;
  await assert.rejects(
    request(store, 'main', config.executor, {
      complete: async () => { uncertainCalls++; throw new UncertainDispatch('Socket reset mid-response'); },
    }, [], new AbortController().signal),
    UncertainDispatch,
  );
  assert.equal(uncertainCalls, 1);
  assert.ok(store.read().sessions.main.pending);
});

test('classifyHttpFailure and parseRetryAfterMs handle standard HTTP statuses and headers', () => {
  assert.equal(classifyHttpFailure(401).category, 'authentication');
  assert.equal(classifyHttpFailure(429, { retryAfterMs: 2000 }).category, 'rate_limit');
  assert.equal(classifyHttpFailure(502).category, 'provider_outage');
  assert.equal(classifyHttpFailure(400, { message: 'maximum context length exceeded' }).category, 'context_overflow');
  assert.equal(classifyHttpFailure(400, { message: 'bad field' }).category, 'invalid_request');
  assert.equal(parseRetryAfterMs('3'), 3000);
  const futureDate = new Date(1_700_000_005_000).toUTCString();
  assert.equal(parseRetryAfterMs(futureDate, 1_700_000_000_000), 5000);
});

test('read-only provider capability preflight probes /models without calling /chat/completions and never assumes env var validity', async t => {
  let completionsCalled = 0;
  let modelsStatus = 200;
  let supportsTools = true;
  const { keyName, key, baseUrl } = await httpFixture(t, (req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      completionsCalled++;
      res.writeHead(500);
      res.end('Should never call completions');
      return;
    }
    if (req.url?.endsWith('/models')) {
      if (modelsStatus !== 200) {
        res.writeHead(modelsStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Rejected token ${key}` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          {
            id: 'fixture-pro',
            context_length: 262144,
            max_output_tokens: 16384,
            supported_parameters: supportsTools ? ['tools', 'reasoning'] : ['reasoning'],
          },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const config = configSchema.parse({
    executor: { baseUrl, model: 'fixture-pro', family: 'fixture', apiKeyEnv: keyName, maxOutputTokens: 8192 },
  });

  const okReport = await preflightProvider(config);
  assert.equal(okReport.readOnly, true);
  assert.equal(okReport.passed, true);
  assert.equal(okReport.executor.credentialStatus, 'valid');
  assert.equal(okReport.executor.contextWindowTokens, 262144);
  assert.equal(okReport.executor.maxOutputTokens, 16384);
  assert.equal(okReport.executor.limitSource, 'provider');
  assert.equal(okReport.executor.supportsTools, true);
  assert.equal(okReport.executor.supportsReasoning, true);
  assert.equal(completionsCalled, 0);

  // Executor lacking tool support fails preflight.
  supportsTools = false;
  const noToolsReport = await preflightProvider(config);
  assert.equal(noToolsReport.passed, false);
  assert.equal(noToolsReport.executor.supportsTools, false);

  // 401 from /models proves env var presence != credential validity.
  supportsTools = true;
  modelsStatus = 401;
  const rejectedReport = await preflightProvider(config);
  assert.equal(rejectedReport.passed, false);
  assert.equal(rejectedReport.executor.credentialPresent, true);
  assert.equal(rejectedReport.executor.credentialStatus, 'rejected');
  assert.ok(!JSON.stringify(rejectedReport).includes(key));

  // Missing env var reports missing without network call.
  delete process.env[keyName];
  const missingReport = await preflightProvider(config);
  assert.equal(missingReport.passed, false);
  assert.equal(missingReport.executor.credentialPresent, false);
  assert.equal(missingReport.executor.credentialStatus, 'missing');
  assert.equal(completionsCalled, 0);
});

test('computeContextBudget and projectMessagesForModel preserve tool-call pairs and compute budget limits', () => {
  const config = configSchema.parse({
    executor: { baseUrl: 'http://127.0.0.1:1/v1', model: 'claude-sonnet-4', family: 'anthropic', apiKeyEnv: 'K', maxOutputTokens: 4096 },
  });
  const budget = computeContextBudget(config.executor, []);
  assert.equal(budget.contextWindowTokens, 200_000);
  assert.equal(budget.reserveOutputTokens, 4096);
  assert.ok(budget.proactiveInputLimit < budget.hardInputLimit);

  const session = {
    inbox: [],
    messages: [
      { role: 'system' as const, content: 'Sys' },
      { role: 'user' as const, content: 'Old' },
      { role: 'user' as const, content: 'Recent' },
    ],
    compaction: {
      summary: '[Compacted context summary]',
      keptFromIndex: 2,
      compactedAt: new Date().toISOString(),
      reason: 'proactive_budget' as const,
      pinnedIds: ['CLM-1'],
      originalMessageCount: 3,
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 20,
    },
  };
  const proj = projectMessagesForModel(os.tmpdir(), session);
  assert.equal(proj.messages.length, 3);
  assert.equal(proj.messages[0].content, 'Sys');
  assert.equal(proj.messages[1].content, '[Compacted context summary]');
  assert.equal(proj.messages[2].content, 'Recent');
  // compactSession returns null cleanly when fewer than 3 messages.
  assert.equal(compactSession(os.tmpdir(), { version: 1, goal: 'g', config, mode: 'automatic', topic: { version: 0, status: 'UNSELECTED' }, tasks: {}, sessions: { s: { messages: [{ role: 'user', content: 'hi' }], inbox: [] } }, sources: {}, claims: {}, challenges: {}, edges: [], events: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, unknownRequests: 0 } }, 's', 'proactive_budget', budget), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store, event } from '../../src/store.js';
import { configSchema } from '../../src/types.js';
import { runScheduler } from '../../src/run-control.js';

async function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-contention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'project.json'));
  await store.init('Isolated contention fixture', configSchema.parse({ executor: {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', family: 'fixture', apiKeyEnv: 'UNUSED_FIXTURE_KEY',
  } }), 'on_demand');
  return store;
}

test('unchanged transactions leave the project inode, contents and mtime intact', async t => {
  const store = await setup(t);
  const before = fs.statSync(store.file, { bigint: true });
  const content = fs.readFileSync(store.file);
  assert.equal(await store.update(s => s.goal), 'Isolated contention fixture');
  await store.transaction(() => undefined);
  const after = fs.statSync(store.file, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readFileSync(store.file), content);
});

test('separate Store instances queue in order and a failed callback does not block subsequent writes', async t => {
  const store = await setup(t);
  const writes = Array.from({ length: 30 }, (_, i) => new Store(store.file).update(s => {
    event(s, 'queued', { i });
    if (i === 10) throw new Error('Fixture callback failed before commit');
  }));
  const results = await Promise.allSettled(writes);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(store.read().events.filter(e => e.type === 'queued').map(e => e.data.i),
    Array.from({ length: 30 }, (_, i) => i).filter(i => i !== 10));
});

test('independent processes preserve all updates to a large project record', async t => {
  const store = await setup(t);
  await store.transaction(r => { r.retainedEvidence = 'x'.repeat(2 * 1024 * 1024); });
  const moduleUrl = new URL('../../src/store.js', import.meta.url).href;
  const script = `
    const { Store, event } = await import(process.argv[1]);
    const store = new Store(process.argv[2]);
    for (let i = 0; i < 12; i++) {
      await store.update(s => event(s, 'process-write', { worker: process.argv[3], i }));
      await store.update(() => undefined);
    }
  `;
  await Promise.all(Array.from({ length: 3 }, (_, worker) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, store.file, String(worker)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`)));
  })));
  const state = store.read();
  const events = state.events.filter(e => e.type === 'process-write');
  assert.equal(events.length, 36);
  assert.equal(new Set(events.map(e => `${e.data.worker}:${e.data.i}`)).size, 36);
  assert.deepEqual(state.events.map(e => e.seq), Array.from({ length: state.events.length }, (_, i) => i + 1));
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).retainedEvidence.length, 2 * 1024 * 1024);
});

test('scheduler survives acquisition contention at claim, tick, status and finalization', async t => {
  const store = await setup(t);
  const update = store.update.bind(store); let calls = 0;
  store.update = async fn => {
    // Each operation first exhausts its lower-level acquisition allowance.
    if ([1, 3, 6, 8].includes(++calls)) throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
    return update(fn);
  };
  await runScheduler(store, store.root);
  assert.equal(store.read().scheduler?.status, 'stopped');
  assert.equal(store.read().usage.requests, 0);
  assert.equal(store.read().events.filter(e => e.type === 'scheduler_started').length, 1);
  assert.equal(store.read().events.filter(e => e.type === 'scheduler_stopped').length, 1);
});

test('scheduler bounds lock retries and does not retry unrelated persistence failures', async t => {
  const store = await setup(t); let calls = 0;
  store.update = async () => { calls++; throw Object.assign(new Error('busy'), { code: 'ELOCKED' }); };
  await assert.rejects(runScheduler(store, store.root), /busy/);
  assert.equal(calls, 3);
  calls = 0;
  store.update = async () => { calls++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(runScheduler(store, store.root), /disk full/);
  assert.equal(calls, 1);
});

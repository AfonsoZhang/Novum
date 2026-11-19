import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hash, local, Store, atomic } from './store.js';
import { evidenceGate, invalidate } from './gates.js';
import { activePipelineTask } from './pipeline-plan.js';

export function validate(store: Store) {
  const state = store.read(); invalidate(store.root, state);
  const active = Object.values(state.tasks).filter(task => activePipelineTask(state, task) || task.execution === 'running');
  return { passed: active.length > 0 && active.every(t => t.acceptance === 'accepted') && state.topic.status === 'APPROVED',
    topic: state.topic, tasks: Object.values(state.tasks).map(task => ({ id: task.id, execution: task.execution, executionCompletedAt: task.executionCompletedAt, acceptance: task.acceptance, outcome: task.outcome, errors: evidenceGate(store.root, state, task), reasons: task.reasons, expectedSeconds: task.expectedSeconds, elapsedSeconds: task.elapsedSeconds })), usage: state.usage };
}

/** Portable data bundle, never executes source files when inspecting or replaying. */
export function pack(store: Store, output: string): void {
  const state = store.read();
  const names = new Set(Object.values(state.tasks).flatMap(t => [...t.inputs, ...t.outputs]));
  for (const source of Object.values(state.sources)) names.add(source.path);
  for (const task of Object.values(state.tasks)) for (const check of Object.values(task.checks ?? {})) names.add(check.report);
  for (const name of ['package-lock.json', 'package.json', 'requirements.txt', 'uv.lock', 'environment.yml']) if (fs.existsSync(local(store.root, name))) names.add(name);
  const files: Record<string, { hash: string; base64: string }> = {};
  for (const name of names) {
    const file = local(store.root, name); if (fs.existsSync(file)) files[name] = { hash: hash(file), base64: fs.readFileSync(file).toString('base64') };
  }
  atomic(output, { format: 'research-loop-bundle-v1', environment: { node: process.version, platform: process.platform, arch: process.arch }, record: JSON.parse(fs.readFileSync(store.file, 'utf8')), validation: validate(store), files });
}

export function replay(file: string): { passed: boolean; errors: string[]; events: number; tasks: number } {
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8')); const errors: string[] = [];
  if (bundle.format !== 'research-loop-bundle-v1') throw new Error('Unknown replay bundle format');
  for (const [name, entry] of Object.entries(bundle.files) as [string, { hash: string; base64: string }][]) {
    // Hash binary bytes, rather than decoding evidence as text.
    const bytes = Buffer.from(entry.base64, 'base64');
    if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== entry.hash) errors.push(`Bundle hash mismatch: ${name}`);
  }
  const state = bundle.record.agentLoop;
  state.events.forEach((e: { seq: number }, i: number) => { if (e.seq !== i + 1) errors.push(`Invalid event sequence: ${i}`); });
  for (const task of Object.values(state.tasks) as { id: string; acceptance: string; review?: unknown }[]) if (task.acceptance === 'accepted' && !task.review) errors.push(`Accepted task without review: ${task.id}`);
  return { passed: errors.length === 0, errors, events: state.events.length, tasks: Object.keys(state.tasks).length };
}


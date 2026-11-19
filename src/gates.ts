import fs from 'node:fs';
import path from 'node:path';
import { hash, local } from './store.js';
import type { Ref, State, Task } from './types.js';
import { verdicts } from './types.js';
import { inputLookupKeys, inputRevisionErrors, researchInputs } from './research-inputs.js';

export function hashes(root: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map(name => [name, hash(local(root, name))]));
}
export function changed(root: string, values: Record<string, string>): string[] {
  return Object.entries(values).filter(([name, expected]) => {
    const p = local(root, name); return !fs.existsSync(p) || hash(p) !== expected;
  }).map(([name]) => name);
}
export function auditFreshness(file: string): { verdict: string; stale: boolean; errors: string[] } {
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors: string[] = [];
  if (!verdicts.includes(audit.verdict)) errors.push('Unknown audit verdict');
  const entries = Object.entries(audit.audited_input_hashes ?? {});
  if (!entries.length) errors.push('Missing audited_input_hashes');
  for (const [name, expected] of entries) {
    const p = path.resolve(path.dirname(file), name);
    if (!fs.existsSync(p) || hash(p) !== expected) errors.push(`Stale audit input: ${name}`);
  }
  return { verdict: audit.verdict, stale: errors.length > 0, errors };
}
export function refErrors(root: string, state: State, refs: Ref[]): string[] {
  return refs.flatMap(ref => {
    const source = state.sources[ref.sourceId];
    if (!source) return [`Source not retrieved: ${ref.sourceId}`];
    const errors: string[] = [];
    const p = local(root, source.path);
    if (!fs.existsSync(p) || hash(p) !== source.hash) errors.push(`Source snapshot missing/stale: ${source.id}`);
    if (!ref.passage && !ref.page && !ref.location) errors.push(`Evidence location missing: ${source.id}`);
    if (ref.passage && fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes(ref.passage)) errors.push(`Passage absent from snapshot: ${source.id}`);
    return errors;
  });
}
export function executionGate(root: string, task: Task): string[] {
  const errors = task.outputs.filter(name => !fs.existsSync(local(root, name)) || !fs.statSync(local(root, name)).isFile() || fs.statSync(local(root, name)).size === 0).map(name => `Missing artifact: ${name}`);
  errors.push(...changed(root, task.inputHashes).map(name => `Input changed during execution: ${name}`));
  if (task.reworkBaseline && Object.keys(task.reworkBaseline).length && !changed(root, task.reworkBaseline).length) errors.push('Workflow revision requires changed repair artifacts before another review');
  return errors;
}
export function citationsIn(text: string): string[] {
  return [
    ...[...text.matchAll(/\\cite\w*\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(s => s.trim())),
    ...[...text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]),
  ];
}
export function evidenceGate(root: string, state: State, task: Task): string[] {
  const errors = executionGate(root, task);
  errors.push(...inputRevisionErrors(state, task));
  const inputs = task.researchInputs ?? researchInputs(state);
  for (const key of inputLookupKeys(inputs)) {
    const lookup = task.inputLookups?.revision === inputs.revision ? task.inputLookups.results.find(r => r.key === key) : undefined;
    if (!lookup) errors.push(`Required research input lookup has not run: ${key}`);
    else errors.push(...refErrors(root, state, lookup.sourceIds.map(sourceId => ({ sourceId, location: 'Research input lookup snapshot' }))));
  }
  const members = new Set(Object.values(state.sources).flatMap(s => [s.id, s.identity, ...(s.citationKeys ?? [])]));
  for (const name of task.outputs.filter(n => /\.(md|tex)$/.test(n))) {
    const file = local(root, name); if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const citation of citationsIn(text)) if (!members.has(citation)) errors.push(`Unretrieved manuscript citation: ${citation}`);
  }
  if (task.stage !== 'topic') {
    if (!task.claimIds.length) errors.push('Declare the claims or methodological assertions checked by this task');
    if (!task.retrievals.some(r => r.intent === 'adversarial')) errors.push('Adversarial evidence retrieval has not run');
  }
  for (const id of task.claimIds) {
    const claim = state.claims[id];
    if (!claim || !claim.evidence.length) errors.push(`Claim lacks evidence: ${id}`);
    else errors.push(...refErrors(root, state, claim.evidence));
  }
  for (const challenge of Object.values(state.challenges)) {
    if (challenge.taskId !== task.id && !task.claimIds.includes(challenge.claimId)) continue;
    if (challenge.severity !== 'minor' && challenge.status !== 'resolved') errors.push(`Open consequential challenge: ${challenge.id}`);
    if (challenge.status === 'resolved') {
      if (!challenge.response?.evidence.length || !challenge.resolutionReviewer) errors.push(`Unsupported resolution: ${challenge.id}`);
      else errors.push(...refErrors(root, state, challenge.response.evidence));
    }
  }
  if (task.stage === 'delivery') {
    const audit = local(root, 'PAPER_CLAIM_AUDIT.json');
    if (!fs.existsSync(audit)) errors.push('Missing PAPER_CLAIM_AUDIT.json (including NOT_APPLICABLE when appropriate)');
    else {
      const result = auditFreshness(audit); errors.push(...result.errors);
      if (['FAIL', 'BLOCKED', 'ERROR'].includes(result.verdict)) errors.push(`Paper audit: ${result.verdict}`);
    }
  }
  return errors;
}

/** Revalidate accepted work recursively before releasing any dependent task. */
export function invalidate(root: string, state: State): void {
  let again = true;
  while (again) {
    again = false;
    for (const task of Object.values(state.tasks)) {
      if (task.acceptance !== 'accepted') continue;
      const stale = changed(root, { ...task.inputHashes, ...task.outputHashes, ...task.review?.inputHashes });
      const dependency = task.dependencies.some(id => state.tasks[id]?.acceptance !== 'accepted');
      if (stale.length || dependency || (task.requiresTopic && task.topicVersion !== state.topic.version) || evidenceGate(root, state, task).length) {
        task.acceptance = 'stale'; task.reasons = [...stale.map(x => `Stale artifact: ${x}`), ...inputRevisionErrors(state, task), ...(dependency ? ['Dependency acceptance changed'] : [])]; again = true;
      }
    }
  }
}

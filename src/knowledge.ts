import fs from 'node:fs';
import path from 'node:path';
import { contentHash, event, local, Store } from './store.js';
import { replay } from './delivery.js';
import type { State } from './types.js';

export function queryKnowledge(store: Store, query: string) {
  const state = store.read(); const matches = (value: unknown) => JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
  return { sources: Object.values(state.sources).filter(matches), claims: Object.values(state.claims).filter(matches), edges: state.edges.filter(matches) };
}
/** Merge reusable knowledge into the SAME record; never import task acceptance or authority. */
export async function importKnowledge(store: Store, bundlePath: string): Promise<void> {
  const check = replay(bundlePath); if (!check.passed) throw new Error(check.errors.join('; '));
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')); const sourceState = bundle.record.agentLoop as State;
  const prefix = 'import_' + contentHash(sourceState.goal).slice(0, 10) + '_';
  for (const source of Object.values(sourceState.sources)) {
    if (!/^src_[a-f0-9]{24}$/.test(source.id)) throw new Error('Invalid imported source ID');
    const entry = bundle.files[source.path]; if (!entry || entry.hash !== source.hash) throw new Error(`Missing source bytes: ${source.id}`);
    const target = local(store.root, `.research-loop/evidence/${source.id}.txt`); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.from(entry.base64, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  await store.update(s => {
    for (const source of Object.values(sourceState.sources)) s.sources[source.id] ??= { ...source, citationKeys: [], path: `.research-loop/evidence/${source.id}.txt` };
    for (const claim of Object.values(sourceState.claims)) {
      const id = prefix + claim.id; s.claims[id] ??= { ...claim, id, taskId: prefix + claim.taskId };
    }
    const translate = (id: string) => sourceState.claims[id] ? prefix + id : id;
    for (const edge of sourceState.edges) {
      const mapped = { ...edge, from: translate(edge.from), to: translate(edge.to) };
      if (!s.edges.some(e => JSON.stringify(e) === JSON.stringify(mapped))) s.edges.push(mapped);
    }
    event(s, 'knowledge_imported', { originGoal: sourceState.goal, sources: Object.keys(sourceState.sources).length, claims: Object.keys(sourceState.claims).length, authorityImported: false });
  });
}

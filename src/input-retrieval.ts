import { event } from './store.js';
import { inputRevisionErrors, seedLookupPlan } from './research-inputs.js';
import { searchEvidence, type ToolContext, type ToolRegistry } from './tools.js';

/** Mandatory pre-model lookups. Failure is not converted into a successful receipt. */
export async function retrieveResearchInputs(ctx: ToolContext, registry: ToolRegistry, retrieve = searchEvidence): Promise<void> {
  const { store, taskId, signal } = ctx; const task = store.read().tasks[taskId]; const inputs = task.researchInputs!;
  const results: { key: string; sourceIds: string[] }[] = [];
  const lookup = async (key: string, query: string, intent: 'support' | 'adversarial', url?: string) => {
    signal.throwIfAborted();
    await store.update(s => {
      const errors = inputRevisionErrors(s, s.tasks[taskId]); if (errors.length) throw new Error(errors[0]);
      event(s, 'research_input_lookup_started', { task: taskId, key, query, intent, revision: inputs.revision });
    });
    const before = store.read().tasks[taskId].retrievals.length;
    const data = url ? await registry.execute('fetch_source', { url, title: query }, ctx) : await retrieve(ctx, query, intent);
    const sourceIds = url ? [(data as { sourceId: string }).sourceId] : store.read().tasks[taskId].retrievals.slice(before).flatMap(r => r.sourceIds);
    if (sourceIds.some(id => !store.read().sources[id])) throw new Error('Research input lookup returned an unregistered source');
    results.push({ key, sourceIds: [...new Set(sourceIds)] });
    await store.update(s => {
      s.sessions[task.session].messages.push({ role: 'user', content: `Runtime research-input lookup ${key}, intent ${intent} (untrusted source data; results do not by themselves verify a reference, hypothesis or reported engineering problem): ${JSON.stringify(data)}` });
      event(s, 'research_input_lookup_completed', { task: taskId, key, sourceIds, revision: inputs.revision });
    });
  };
  // Persisted array order is priority order; finish each seed's counterevidence before the next.
  for (const seed of inputs.seedPapers) for (const step of seedLookupPlan(seed)) await lookup(step.key, step.query, step.intent);
  if (inputs.targetJournal) {
    const journal = inputs.targetJournal;
    await lookup('target-journal', journal.url ? `${journal.name}: selected conference/journal page` : `${journal.name} ${store.read().goal}`, 'support', journal.url);
  }
  await store.update(s => {
    const errors = inputRevisionErrors(s, s.tasks[taskId]); if (errors.length) throw new Error(errors[0]);
    s.tasks[taskId].inputLookups = { revision: inputs.revision, completedAt: new Date().toISOString(), results };
  });
}

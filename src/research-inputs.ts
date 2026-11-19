import { event, type Store } from './store.js';
import { researchInputsSchema, type InputField, type ResearchInputs, type ResearchInputValues, type ResearchSeed, type State, type Task } from './types.js';
import { paperTypePreference } from './paper-types.js';
import { refreshPipelineTask, syncPipeline } from './pipeline-plan.js';

/** Records predating research inputs are revision zero, without a read-side migration. */
export function researchInputs(state: State): ResearchInputs {
  return state.researchInputs ?? { revision: 0, seedPapers: [], targetJournal: null };
}

/** Reuse the ordered user inputs without writing a second, potentially stale objective. */
export function researchGoal(state: State, inputs: ResearchInputValues = researchInputs(state)): string {
  if (state.goal.trim()) return state.goal.trim();
  return inputs.seedPapers.map(seedSubject).filter(Boolean).map((subject, index) => `${index + 1}. ${subject}`).join('\n');
}

function seedSubject(seed: ResearchSeed): string {
  return seed.title.trim() || ((seed.kind ?? 'paper') !== 'paper' ? seed.notes?.trim() || seed.url?.trim() || '' : '');
}

export class InputConflict extends Error {}

export function seedPriority(inputs: ResearchInputValues) {
  return inputs.seedPapers.map((seed, index) => ({ rank: index + 1, seedId: seed.id }));
}

function comparableInputs(inputs: ResearchInputValues, state: State): string {
  const parsed = researchInputsSchema.parse({ paperType: inputs.paperType, seedPapers: inputs.seedPapers, targetJournal: inputs.targetJournal });
  // Adding an explicit paper kind to a legacy entry is not a research change.
  return JSON.stringify({ paperType: paperTypePreference(state, parsed), seedPapers: parsed.seedPapers.map(({ kind, ...seed }) => ({ ...seed, kind: kind ?? 'paper' })), targetJournal: parsed.targetJournal });
}

export function replaceResearchInputs(state: State, raw: unknown, expectedRevision: number, source: 'user' | 'initialization' = 'user', editedFields?: InputField[]): ResearchInputs {
  const values = researchInputsSchema.parse(raw); const previous = researchInputs(state);
  delete values.selectedDirectionId; // Retired input: array order is the only priority source.
  // Older input editors may omit this field. Clearing it explicitly uses null.
  if (values.paperType === undefined && previous.paperType !== undefined) values.paperType = previous.paperType;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== previous.revision) throw new InputConflict('研究输入已在其他窗口更新，请重新打开编辑后合并修改。');
  if (source === 'user' && state.initialization) {
    for (const field of editedFields ?? ['paperType', 'seedPapers', 'targetJournal']) {
      if (!state.initialization.protectedFields.includes(field)) state.initialization.protectedFields.push(field);
      for (const finding of state.initialization.findings.filter(item => item.field === field && item.applied)) { finding.applied = false; finding.reason = '保留人工编辑'; }
    }
  }
  if (comparableInputs(values, state) === comparableInputs(previous, state)) return previous;
  const previousType = paperTypePreference(state, previous); const nextType = paperTypePreference(state, values);
  const previousResolution = state.paperTypeResolution;
  const priorityChanged = JSON.stringify(seedPriority(previous)) !== JSON.stringify(seedPriority(values));
  const next = { ...values, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
  state.researchInputs = next;
  delete state.paperTypeResolution;
  if (previousResolution) event(state, 'paper_type_resolution_invalidated', { previous: previousResolution, revision: next.revision });
  if (previousType !== nextType || previousResolution || priorityChanged) {
    const previousTopic = state.topic;
    state.topic = { version: previousTopic.version + 1, status: 'UNSELECTED' };
    event(state, previousType !== nextType ? 'paper_type_changed' : priorityChanged ? 'seed_priority_changed' : 'research_direction_changed', { previousType, paperType: nextType, previous: seedPriority(previous), current: seedPriority(next), previousTopic, topicVersion: state.topic.version, revision: next.revision, message: 'Research contribution scope or seed priority changed; a new topic proposal and explicit approval are required' });
  }
  for (const task of Object.values(state.tasks)) {
    if (previousType !== nextType || previousResolution) refreshPipelineTask(state, task);
    if (task.acceptance === 'accepted') {
      task.acceptance = 'stale'; task.reasons = ['Research inputs changed; retry with the current research seeds and target journal'];
    }
  }
  event(state, 'research_inputs_updated', { revision: next.revision, previous, current: next, message: `Research inputs revision ${next.revision}: ${next.seedPapers.length} research seeds; target venue ${next.targetJournal?.name ?? 'unset'}` });
  syncPipeline(state);
  return next;
}

export function updateResearchInputs(store: Store, raw: unknown, expectedRevision: number, edit?: { fields: InputField[]; base: ResearchInputValues }): Promise<ResearchInputs> {
  return store.update(state => {
    if (!edit) return replaceResearchInputs(state, raw, expectedRevision);
    const supplied = researchInputsSchema.parse(raw); const current = researchInputs(state);
    if (expectedRevision > current.revision) throw new InputConflict('研究输入版本无效，请刷新后重试。');
    const merged: ResearchInputValues = { paperType: current.paperType ?? null, seedPapers: current.seedPapers, targetJournal: current.targetJournal };
    for (const field of edit.fields) {
      const changed = JSON.stringify(current[field] ?? null) !== JSON.stringify(edit.base[field] ?? null);
      if (expectedRevision !== current.revision && changed && (!state.initialization || state.initialization.protectedFields.includes(field))) throw new InputConflict('这个字段已在其他窗口修改，请保留当前草稿并重新核对。');
      Object.assign(merged, { [field]: supplied[field] ?? null });
    }
    return replaceResearchInputs(state, merged, current.revision, 'user', edit.fields);
  });
}

export function seedLookupPlan(seed: ResearchSeed): { key: string; query: string; intent: 'support' | 'adversarial' }[] {
  const key = `seed:${seed.id}`;
  const subject = seedSubject(seed);
  if ((seed.kind ?? 'paper') !== 'paper' && !subject) return [];
  switch (seed.kind ?? 'paper') {
    case 'paper': return [{ key, query: seed.doi ?? seed.title, intent: 'support' }];
    case 'direction': return [
      { key, query: `${subject} research gaps open problems`, intent: 'support' },
      { key: `${key}:adversarial`, query: `${subject} limitations conflicting evidence`, intent: 'adversarial' },
    ];
    case 'engineering_problem': return [
      { key, query: `${subject} causes failure modes mitigation evaluation`, intent: 'support' },
      { key: `${key}:adversarial`, query: `${subject} failed solutions tradeoffs limitations`, intent: 'adversarial' },
    ];
  }
}

export function inputLookupKeys(inputs: ResearchInputs): string[] {
  return [...inputs.seedPapers.flatMap(seed => seedLookupPlan(seed).map(lookup => lookup.key)), ...(inputs.targetJournal ? ['target-journal'] : [])];
}

export function inputRevisionErrors(state: State, task: Task): string[] {
  return (task.researchInputs?.revision ?? 0) === researchInputs(state).revision ? [] : ['Research inputs changed during this task; retry to use the current revision'];
}

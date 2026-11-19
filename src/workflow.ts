import fs from 'node:fs';
import path from 'node:path';
import { event, local, Store } from './store.js';
import { taskSchema, type State, type TaskSpec } from './types.js';
import { activePipelineTask, syncPipeline } from './pipeline-plan.js';
import { paperType } from './paper-types.js';
import { waitingForRevision } from './loop-transitions.js';
import { researchGoal } from './research-inputs.js';

function normalizeTask(store: Store, raw: unknown): TaskSpec {
  const spec = taskSchema.parse(raw);
  if (['__proto__', 'constructor', 'prototype'].some(key => spec.id === key || spec.session === key)) throw new Error('Reserved task/session ID');
  for (const key of ['inputs', 'outputs', 'writes'] as const) spec[key] = spec[key].map(name => path.relative(store.root, local(store.root, name)));
  for (const name of [...spec.outputs, ...spec.writes]) {
    if (!name || name.startsWith('.research-loop') || local(store.root, name) === store.file) throw new Error('Runtime state and project root cannot be assigned as write scope');
  }
  for (const name of spec.outputs) {
    if (!spec.writes.some(w => name === w || name.startsWith(w.replace(/\/$/, '') + '/'))) throw new Error(`Output outside write scope: ${name}`);
  }
  return spec;
}

function registerTask(state: State, spec: TaskSpec, standardPipeline = false): void {
  if (state.tasks[spec.id]) throw new Error(`Duplicate task ID: ${spec.id}`);
  if (spec.requiresTopic === false && spec.stage !== 'topic') throw new Error('Only topic work may bypass topic approval');
  for (const id of spec.dependencies) if (!state.tasks[id]) throw new Error(`Unknown dependency: ${id}`);
  if (state.mode === 'on_demand' && Object.keys(state.tasks).length) throw new Error('Multiple stages require explicit automatic/autopilot mode');
  state.tasks[spec.id] = { ...spec, ...(standardPipeline ? { pipeline: true as const, paperType: paperType(state) } : {}), execution: 'pending', acceptance: 'pending', attempts: 0, topicVersion: state.topic.version, inputHashes: {}, outputHashes: {}, claimIds: [], retrievals: [], reasons: [], children: [], elapsedSeconds: 0, noProgress: 0 };
  state.sessions[spec.session] ??= { messages: [], inbox: [] };
  event(state, 'task_added', { task: spec.id, stage: spec.stage, expectedSeconds: spec.expectedSeconds });
}

export async function addTask(store: Store, raw: unknown): Promise<void> {
  const spec = normalizeTask(store, raw);
  await store.update(state => registerTask(state, spec));
}

export function initializePipeline(state: State): void {
    if (state.mode === 'on_demand') throw new Error('Pipeline requires explicit automatic or autopilot mode');
    if (Object.keys(state.tasks).length) throw new Error('Pipeline already initialized or custom tasks exist');
    state.pipelineGraph = { version: 1, type: paperType(state), taskIds: [], revisions: 0 };
    syncPipeline(state);
}

export async function pipeline(store: Store): Promise<void> {
  await store.update(initializePipeline);
}

export async function approveTopic(store: Store, version: number, response: string): Promise<void> {
  if (!response.trim()) throw new Error('Explicit user response required');
  await store.update(state => {
    if (state.topic.status !== 'AWAITING_TOPIC_APPROVAL' || state.topic.version !== version) throw new Error('No matching topic proposal awaiting approval');
    const proposal = Object.values(state.tasks).find(t => t.stage === 'topic' && t.outputs.includes(state.topic.proposal ?? ''));
    if (proposal && proposal.acceptance !== 'accepted') throw new Error('Topic proposal is stale or unaccepted; retry before approval');
    if (paperType(state) === null) throw new Error('Paper type is unresolved; complete topic review before approval');
    state.topic.status = 'APPROVED'; state.topic.approval = response;
    event(state, 'topic_approved', { version, response, source: 'user_cli' });
  });
}

export function blockers(state: State, id: string): string[] {
  const task = state.tasks[id]; const reasons: string[] = [];
  if (state.initialization?.status === 'running') reasons.push('PROJECT_INITIALIZING');
  if (!researchGoal(state)) reasons.push('RESEARCH_GOAL_REQUIRED');
  if (!activePipelineTask(state, task)) reasons.push('WORKFLOW_NODE_RETIRED');
  if (waitingForRevision(state, id)) reasons.push('WORKFLOW_REVISION_PENDING');
  if (task.requiresTopic && state.topic.status !== 'APPROVED') reasons.push('AWAITING_TOPIC_APPROVAL');
  if (task.stage !== 'topic' && paperType(state) === null) reasons.push('PAPER_TYPE_UNRESOLVED');
  for (const dep of task.dependencies) if (state.tasks[dep]?.acceptance !== 'accepted') reasons.push(`Unaccepted dependency: ${dep}`);
  if (task.noProgress >= state.config.maxNoProgress && !task.diagnosis) reasons.push('New diagnosis required after repeated no progress');
  return reasons;
}

export function skillText(skillRoot: string, names: string[]): string {
  return names.map(name => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid skill name');
    const file = local(skillRoot, `${name}/SKILL.md`);
    if (!fs.existsSync(file)) throw new Error(`Missing required skill: ${name}`);
    return `\n<skill name="${name}">\n${fs.readFileSync(file, 'utf8')}\n</skill>`;
  }).join('\n');
}

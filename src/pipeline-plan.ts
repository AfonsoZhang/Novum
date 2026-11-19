import { event } from './store.js';
import { paperProfile, paperType } from './paper-types.js';
import { taskSchema, type PaperType, type Stage, type State, type Task, type TaskSpec } from './types.js';

const legacyTopicPrompt = 'Select and justify a research topic within the stated goal. Save a Chinese topic-approval report. No downstream research before human approval.';
const topicScopeGuidance = 'If prior work narrowed the initial question, show which finding changed its scope and state the resulting question.';
const stageSpecs: { stage: Stage; skills: string[]; output: string; prompt: string }[] = [
  { stage: 'topic', skills: ['research-companion', 'idea-evaluator'], output: 'research/topic.md', prompt: 'Compare candidate questions. In the topic-approval report cite the closest paper or versioned open-source system, explain what it establishes, what remains open, and what evidence would overturn the proposed distinction. If unresolved, give the smallest check that could settle it. Use the selected report language and wait for explicit human approval.' },
  { stage: 'literature', skills: ['research-lit', 'novelty-check'], output: 'research/literature.md', prompt: 'Retrieve primary evidence, closest comparators and counterevidence. Establish the gap with traceable claims.' },
  { stage: 'plan', skills: ['experiment-plan'], output: 'research/protocol.md', prompt: 'Freeze a task-appropriate protocol, success and stopping criteria, comparisons and resource estimates before observing results. For nonempirical research, state the corresponding proof or source protocol.' },
  { stage: 'experiment', skills: ['experiment-bridge', 'run-experiment'], output: 'research/execution.md', prompt: 'Execute the frozen protocol within resources, preserve raw outputs and all failed or missing attempts. For nonempirical work execute the planned proof/source investigation.' },
  { stage: 'analysis', skills: ['analyze-results'], output: 'research/analysis.md', prompt: 'Check protocol deviations and raw results; classify supporting, opposing, invalid and inconclusive evidence with uncertainty.' },
  { stage: 'writing', skills: ['paper-writer', 'nature-figure'], output: 'research/manuscript.md', prompt: 'Write the complete manuscript, tracing claims, citations and figures to the accepted evidence. Preserve scope and inference strength.' },
  { stage: 'review', skills: ['pre-submission-reviewer', 'paper-claim-audit'], output: 'PAPER_CLAIM_AUDIT.json', prompt: 'Review the manuscript and audit numeric claims against raw evidence. Save the audit with a valid verdict and complete audited_input_hashes; distinguish NOT_APPLICABLE, BLOCKED and ERROR.' },
  { stage: 'delivery', skills: [], output: 'research/delivery.md', prompt: 'Deliver manuscript, reproduction instructions, verification records, limitations and open issues. Do not submit, publish or push. Recheck the audit input hashes.' },
];


function legacyTypedSpecs(type: PaperType | null): TaskSpec[] {
  const profile = paperProfile(type);
  return stageSpecs.map((entry, i) => {
    const extra = profile.artifacts[entry.stage as keyof typeof profile.artifacts] ?? [];
    const spec: TaskSpec = { id: entry.stage, stage: entry.stage, prompt: entry.prompt, session: 'main', skills: [...entry.skills], expectedSeconds: 300,
      dependencies: i ? [stageSpecs[i - 1].stage] : [], inputs: stageSpecs.slice(0, i).flatMap(s => [s.output, ...(profile.artifacts[s.stage as keyof typeof profile.artifacts] ?? [])]),
      outputs: [entry.output, ...extra], writes: [entry.output, `research/${entry.stage}-assets`, ...extra], requiresTopic: i !== 0 };
    spec.prompt += `\nPaper contribution type: ${type ?? 'undecided'}. ${profile.focus}`;
    if (entry.stage === 'topic') spec.prompt += '\n' + topicScopeGuidance;
    if (entry.stage === 'plan') { spec.skills = profile.planSkills; spec.prompt += '\n' + profile.plan; }
    if (entry.stage === 'experiment') { spec.skills = profile.executionSkills; spec.prompt = profile.execution + `\nPaper contribution type: ${type ?? 'undecided'}. ${profile.focus} Save the investigation record in research/execution.md.`; }
    if (entry.stage === 'analysis') { spec.skills = profile.analysisSkills; spec.prompt = profile.analysis + `\nPaper contribution type: ${type ?? 'undecided'}. ${profile.focus} Save the analysis in research/analysis.md.`; }
    if (entry.stage === 'writing') spec.skills = profile.writingSkills;
    if (profile.empirical) {
      if (entry.stage === 'plan') { spec.outputs.push('research/planned-runs.json'); spec.writes.push('research/planned-runs.json'); spec.prompt += ' Save research/planned-runs.json as an array of expected runs with unique run_id values, before any runs start.'; }
      if (entry.stage === 'experiment') { spec.inputs.push('research/planned-runs.json'); spec.outputs.push('research/observed-runs.json'); spec.writes.push('research/observed-runs.json'); spec.prompt += ' Save research/observed-runs.json with run_id, unique attempt_id, status, metrics and failure/exclusion reasons for every planned run.'; }
      if (['analysis', 'writing', 'review', 'delivery'].includes(entry.stage)) spec.inputs.push('research/planned-runs.json', 'research/observed-runs.json');
    }
    return spec;
  });
}

/** Recognize only the exact standard legacy template, never overwrite a custom prompt. */
function legacyPipelineTask(task: Task): boolean {
  const entry = stageSpecs.find(s => s.stage === task.stage);
  if (!entry) return false;
  const i = stageSpecs.indexOf(entry);
  return [false, true].some(empirical => {
    const expected = { id: entry.stage, stage: entry.stage, session: 'main', prompt: entry.stage === 'topic' ? legacyTopicPrompt : entry.prompt, skills: entry.skills,
      dependencies: i ? [stageSpecs[i - 1].stage] : [], inputs: stageSpecs.slice(0, i).map(s => s.output),
      outputs: [entry.output], writes: [entry.output, `research/${entry.stage}-assets`], requiresTopic: i !== 0 };
    if (empirical) {
      if (entry.stage === 'plan') { expected.outputs.push('research/planned-runs.json'); expected.writes.push('research/planned-runs.json'); expected.prompt += ' Save research/planned-runs.json as an array of expected runs with unique run_id values, before any runs start.'; }
      if (entry.stage === 'experiment') { expected.inputs.push('research/planned-runs.json'); expected.outputs.push('research/observed-runs.json'); expected.writes.push('research/observed-runs.json'); expected.prompt += ' Save research/observed-runs.json with run_id, unique attempt_id, status, metrics and failure/exclusion reasons for every planned run.'; }
      if (['analysis', 'writing', 'review', 'delivery'].includes(entry.stage)) expected.inputs.push('research/planned-runs.json', 'research/observed-runs.json');
    }
    return (Object.keys(expected) as (keyof typeof expected)[]).every(key => JSON.stringify(task[key]) === JSON.stringify(expected[key]));
  });
}

type PlannedTask = TaskSpec & { pipelineStep: NonNullable<Task['pipelineStep']> };
type ExtraNode = { id: string; stage: Stage; label: string; after: string[]; output: string; instruction: string; skills?: string[]; back?: string[]; session?: string };
const routes: Record<PaperType, { nodes: ExtraNode[]; experimentAfter: string[]; analysisAfter: string[]; writingAfter?: string[]; analysisBack: string[] }> = {
  method: {
    nodes: [
      { id: 'implementation', stage: 'experiment', label: '方法实现', after: ['plan'], output: 'research/method-implementation.md', instruction: 'Implement the proposed mechanism and validate the implementation against the frozen hypotheses before comparisons.', skills: ['experiment-bridge'] },
      { id: 'mechanism_check', stage: 'analysis', label: '机制与归因检查', after: ['experiment'], output: 'research/mechanism-check.md', instruction: 'Assess whether mechanism or causal attribution claims need ablations or other discriminating evidence. Examine the applicable controls; explicitly justify non-applicability without inventing a component quota.', back: ['plan', 'implementation', 'experiment'] },
    ], experimentAfter: ['implementation'], analysisAfter: ['mechanism_check'], analysisBack: ['plan', 'experiment'],
  },
  system: {
    nodes: [
      { id: 'implementation', stage: 'experiment', label: '系统实现', after: ['plan'], output: 'research/system-implementation.md', instruction: 'Build the architecture against the declared constraints; record implementation verification and workload instrumentation.', skills: ['experiment-bridge'] },
      { id: 'reliability', stage: 'analysis', label: '可靠性与资源核验', after: ['experiment'], output: 'research/reliability.md', instruction: 'Reconcile reliability, failure behavior, cost and resource measurements with the claimed operating conditions. Report missing coverage, not invented guarantees.', back: ['plan', 'implementation', 'experiment'] },
    ], experimentAfter: ['implementation'], analysisAfter: ['reliability'], analysisBack: ['plan', 'experiment'],
  },
  benchmark: {
    nodes: [
      { id: 'construction', stage: 'experiment', label: '评测资源与协议构建', after: ['plan'], output: 'research/benchmark-construction.md', instruction: 'Construct or select the evaluation resources and measurement pipeline; preserve provenance, splits and annotation procedures where applicable.', skills: ['benchmark-research-skill'] },
      { id: 'quality_gate', stage: 'plan', label: '质量与泄漏检查', after: ['construction'], output: 'research/benchmark-quality.md', instruction: 'Validate coverage, measurement targets, provenance, splits, annotation quality and applicable leakage checks before evaluation.', back: ['plan', 'construction'] },
    ], experimentAfter: ['quality_gate'], analysisAfter: ['experiment'], analysisBack: ['plan', 'construction', 'experiment'],
  },
  empirical: {
    nodes: [
      { id: 'sampling_check', stage: 'plan', label: '采样与控制检查', after: ['plan'], output: 'research/sampling-check.md', instruction: 'Check sampling units, comparison/control design, confounds, uncertainty and stopping criteria before collecting outcomes.', back: ['plan'] },
      { id: 'sensitivity', stage: 'analysis', label: '敏感性与替代解释', after: ['experiment'], output: 'research/sensitivity.md', instruction: 'Assess sensitivity to justified analysis choices and plausible alternative explanations. Distinguish a supported negative result from an invalid or inconclusive measurement.', back: ['plan', 'experiment'] },
    ], experimentAfter: ['sampling_check'], analysisAfter: ['sensitivity'], analysisBack: ['plan', 'experiment'],
  },
  replication: {
    nodes: [
      { id: 'alignment_check', stage: 'plan', label: '原协议与实现对齐', after: ['plan'], output: 'research/replication-alignment.md', instruction: 'Check faithful implementation, datasets, metrics and intended deviations against the original claim and protocol before execution.', skills: ['experiment-bridge'], back: ['plan'] },
      { id: 'deviation_audit', stage: 'analysis', label: '复现偏差诊断', after: ['experiment'], output: 'research/deviation-audit.md', instruction: 'Diagnose observed disagreement and implementation/protocol departures using original evidence. Non-significance is not equivalence.', back: ['plan', 'alignment_check', 'experiment'] },
    ], experimentAfter: ['alignment_check'], analysisAfter: ['deviation_audit'], analysisBack: ['plan', 'experiment'],
  },
  theory: {
    nodes: [
      { id: 'counterexamples', stage: 'experiment', label: '反例与边界探索', after: ['plan'], output: 'research/counterexamples.md', instruction: 'Search for counterexamples, boundary cases and assumption violations for the frozen statements independently of the proof construction. Record unresolved cases.', session: 'pipeline-counterexamples' },
      { id: 'proof_audit', stage: 'analysis', label: '证明与反例核验', after: ['experiment', 'counterexamples'], output: 'research/proof-audit.md', instruction: 'Check every pivotal proof obligation against definitions, assumptions and counterexamples. Empirical evidence cannot substitute for missing proofs.', back: ['plan', 'experiment', 'counterexamples'] },
    ], experimentAfter: ['plan'], analysisAfter: ['proof_audit'], analysisBack: ['plan', 'experiment', 'counterexamples'],
  },
  survey: {
    nodes: [
      { id: 'search', stage: 'literature', label: '协议化检索', after: ['plan'], output: 'research/search-record.md', instruction: 'Execute the frozen search protocol, register source snapshots and retain queries, dates, versions and coverage limitations.', skills: ['research-lit'] },
      { id: 'extraction', stage: 'analysis', label: '文献信息提取', after: ['experiment'], output: 'research/source-extraction.md', instruction: 'Extract comparable findings, methods, contexts and limitations from included sources with passage locations. Keep exclusions and disagreements visible.', skills: ['research-lit'] },
      { id: 'coverage_audit', stage: 'analysis', label: '综合与覆盖审查', after: ['analysis'], output: 'research/coverage-audit.md', instruction: 'Check whether the synthesis and coverage claims follow the actual search, inclusion decisions and extracted evidence. Request targeted supplementary search or correction when needed.', back: ['plan', 'search', 'experiment', 'extraction', 'analysis'] },
    ], experimentAfter: ['search'], analysisAfter: ['extraction'], writingAfter: ['coverage_audit'], analysisBack: ['search', 'experiment', 'extraction'],
  },
  position: {
    nodes: [
      { id: 'premises', stage: 'literature', label: '论据与事实前提', after: ['plan'], output: 'research/premises.md', instruction: 'Ground factual premises in original sources and distinguish them from normative proposals.', skills: ['research-lit'] },
      { id: 'objections', stage: 'analysis', label: '反方论证', after: ['premises'], output: 'research/objections.md', instruction: 'Develop serious alternatives and counterarguments, including their strongest supporting evidence.', skills: ['research-lit'] },
    ], experimentAfter: ['objections'], analysisAfter: ['experiment'], analysisBack: ['plan', 'premises', 'objections', 'experiment'],
  },
};
const baseLabels: Record<Stage, string> = { topic: '选题', literature: '相关工作', plan: '研究方案', experiment: '研究执行', analysis: '结果分析', writing: '写作', review: '终稿审查', delivery: '交付' };

/** Contribution-specific DAGs; only explicit review transitions introduce back edges. */
export function pipelineSpecs(type: PaperType | null): PlannedTask[] {
  const profile = paperProfile(type);
  const specs = new Map(legacyTypedSpecs(type).map(spec => [spec.id, { ...spec, pipelineStep: { label: baseLabels[spec.stage], checkRuns: false } } as PlannedTask]));
  if (type) {
    const route = routes[type];
    for (const node of route.nodes) specs.set(node.id, {
      id: node.id, stage: node.stage, session: node.session ?? 'main', dependencies: node.after, inputs: [], outputs: [node.output], writes: [node.output, `research/${node.id}-assets`],
      skills: node.skills ?? [], expectedSeconds: 300, requiresTopic: true,
      prompt: `${node.instruction} Save the grounded report in ${node.output}.\nPaper contribution type: ${type}. ${profile.focus}`,
      pipelineStep: { label: node.label, checkRuns: false, ...(node.back ? { checkpoint: { criteria: [node.instruction], reworkTargets: node.back } } : {}) },
    });
    specs.get('experiment')!.dependencies = route.experimentAfter;
    specs.get('analysis')!.dependencies = route.analysisAfter;
    specs.get('writing')!.dependencies = route.writingAfter ?? ['analysis'];
    specs.get('analysis')!.pipelineStep.checkpoint = { criteria: [profile.analysis, profile.focus], reworkTargets: route.analysisBack };
    const review = specs.get('review')!;
    review.prompt += '\nFor pivotal empirical claims about the implemented method, link the run record, resolved config and executed source snapshots to the claim with snapshot_file and record_claim so the reviewer can inspect them. Include the consulted files in audited_input_hashes.';
    review.pipelineStep.checkpoint = {
      criteria: [
        'Claims, citations, scope and audited raw evidence support the final manuscript.',
        'Where an empirical conclusion depends on an implementation choice, trace the result to its run and inspect the relevant executed code and settings. Report a material contradiction as FAIL and missing run provenance as BLOCKED.',
      ],
      reworkTargets: ['writing'],
    };
    const labels = type === 'theory' ? ['定义与假设', '证明构建', '理论结论'] : type === 'survey' ? ['检索协议', '纳入与排除', '文献综合'] : type === 'position' ? ['论证方案', '论证修订', '论证与适用范围'] : ['实验方案', type === 'replication' ? '复现实验' : type === 'benchmark' ? '评测执行' : type === 'system' ? '工作负载测试' : '对照实验', '结果分析'];
    for (const [i, id] of ['plan', 'experiment', 'analysis'].entries()) specs.get(id)!.pipelineStep.label = labels[i];
  }
  const ordered: PlannedTask[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return; if (visiting.has(id)) throw new Error('Cyclic forward workflow');
    const spec = specs.get(id); if (!spec) throw new Error(`Unknown workflow dependency: ${id}`);
    visiting.add(id); for (const dep of spec.dependencies) visit(dep);
    const ancestors = new Set<string>(); const collect = (key: string) => { if (ancestors.has(key)) return; ancestors.add(key); for (const dep of specs.get(key)!.dependencies) collect(dep); };
    spec.dependencies.forEach(collect);
    spec.inputs = [...new Set(ordered.filter(other => ancestors.has(other.id)).flatMap(other => other.outputs))];
    spec.pipelineStep.checkRuns = profile.empirical && (id === 'experiment' || ancestors.has('experiment'));
    for (const target of spec.pipelineStep.checkpoint?.reworkTargets ?? []) if (!ancestors.has(target) || target === 'topic') throw new Error(`Invalid workflow back edge: ${id} -> ${target}`);
    visiting.delete(id); visited.add(id); ordered.push(spec);
  };
  for (const id of specs.keys()) visit(id);
  return ordered;
}

export function activePipelineTask(state: State, task: Task): boolean {
  return !task.pipeline || !state.pipelineGraph || state.pipelineGraph.taskIds.includes(task.id);
}

/** Synchronize queued nodes only. Completed/live attempts and retired nodes stay in history. */
export function syncPipeline(state: State): void {
  if (!state.pipelineGraph && stageSpecs.every(({ stage }) => state.tasks[stage] && (state.tasks[stage].pipeline || legacyPipelineTask(state.tasks[stage])))) {
    state.pipelineGraph = { version: 1, type: paperType(state), taskIds: [], revisions: 0 };
  }
  if (!state.pipelineGraph) return;
  const type = paperType(state); const specs = pipelineSpecs(type);
  for (const spec of specs) if (state.tasks[spec.id] && !state.tasks[spec.id].pipeline && !legacyPipelineTask(state.tasks[spec.id])) throw new Error(`Workflow node conflicts with custom task: ${spec.id}`);
  const previous = state.pipelineGraph;
  const taskIds = specs.map(spec => spec.id);
  if (previous.type !== type || JSON.stringify(previous.taskIds) !== JSON.stringify(taskIds)) {
    state.pipelineGraph = { version: 1, type, taskIds, revisions: previous.revisions };
    event(state, 'workflow_graph_selected', { paperType: type, previous, taskIds });
  }
  for (const spec of specs) {
    const task = state.tasks[spec.id];
    if (!task) {
      state.tasks[spec.id] = { ...taskSchema.parse(spec), pipelineStep: spec.pipelineStep, pipeline: true, paperType: type, execution: 'pending', acceptance: 'pending', attempts: 0, topicVersion: state.topic.version, inputHashes: {}, outputHashes: {}, claimIds: [], retrievals: [], reasons: [], children: [], elapsedSeconds: 0, noProgress: 0 };
      state.sessions[spec.session] ??= { messages: [], inbox: [] };
      event(state, 'task_added', { task: spec.id, stage: spec.stage, expectedSeconds: spec.expectedSeconds });
    } else {
      if (task.acceptance === 'accepted' && (JSON.stringify(task.dependencies) !== JSON.stringify(spec.dependencies) || JSON.stringify(task.inputs) !== JSON.stringify(spec.inputs))) {
        task.acceptance = 'stale'; task.reasons = ['Workflow prerequisites changed; retry under the current graph'];
        event(state, 'workflow_acceptance_invalidated', { task: task.id, dependencies: spec.dependencies });
      }
      refreshPipelineTask(state, task);
    }
  }
}

export function refreshPipelineTask(state: State, task: Task): void {
  if (task.execution !== 'pending' || (!task.pipeline && !legacyPipelineTask(task))) return;
  const type = paperType(state); const spec = pipelineSpecs(type).find(s => s.id === task.id);
  if (!spec) return;
  const legacyTopic = task.stage === 'topic' && [legacyTopicPrompt, stageSpecs[0].prompt].some(prompt =>
    task.prompt === prompt + `\nPaper contribution type: ${type ?? 'undecided'}. ${paperProfile(type).focus}`);
  if (!legacyTopic && task.pipeline && task.paperType === type && JSON.stringify(task.pipelineStep) === JSON.stringify(spec.pipelineStep) && JSON.stringify(task.dependencies) === JSON.stringify(spec.dependencies)) return;
  event(state, 'paper_type_task_routed', { task: task.id, paperType: type, previous: { paperType: task.paperType, prompt: task.prompt, skills: task.skills, dependencies: task.dependencies, inputs: task.inputs, outputs: task.outputs, writes: task.writes, checks: task.checks, pipelineStep: task.pipelineStep } });
  Object.assign(task, { ...spec, paperType: type, pipeline: true });
  state.sessions[spec.session] ??= { messages: [], inbox: [] };
  delete task.checks;
}

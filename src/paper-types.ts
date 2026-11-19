import type { PaperType, ResearchInputValues, State, Task } from './types.js';

export interface PaperProfile {
  type: PaperType | null; label: string; description: string; empirical: boolean;
  focus: string; plan: string; execution: string; analysis: string;
  planSkills: string[]; executionSkills: string[]; analysisSkills: string[]; writingSkills: string[];
  artifacts: { plan: string[]; experiment: string[]; analysis: string[] };
}
const empiricalSkills = { planSkills: ['experiment-plan'], executionSkills: ['experiment-bridge', 'run-experiment'], analysisSkills: ['analyze-results'], writingSkills: ['paper-writer', 'nature-figure'] };
export const paperProfiles: (PaperProfile & { type: PaperType })[] = [
  { type: 'method', label: '方法 / 算法论文', description: '提出方法或算法，验证机制、效果与适用边界。', empirical: true, ...empiricalSkills, writingSkills: ['tech-paper-template', ...empiricalSkills.writingSkills],
    focus: 'Define the mechanism and claimed property; compare relevant baselines. Do not require SOTA or an arbitrary number of components.',
    plan: 'Specify method hypotheses, comparisons and attribution controls when needed.', execution: 'Implement and evaluate the proposed method against the frozen comparisons.', analysis: 'Assess effect, uncertainty, limitations and the scope of any mechanism attribution.', artifacts: { plan: [], experiment: [], analysis: [] } },
  { type: 'system', label: '系统 / 工程论文', description: '构建系统，评估工作负载下的性能、可靠性、成本与取舍。', empirical: true, ...empiricalSkills, writingSkills: ['tech-paper-template', ...empiricalSkills.writingSkills],
    focus: 'Explain design constraints and trade-offs. Match evaluation to claimed system outcomes; novelty of every component and production deployment are not required.',
    plan: 'Document architecture, constraints, workloads and resource accounting in research/system-design.md.', execution: 'Run comparable system workloads, including failures and resource measurements.', analysis: 'Document supported and unresolved design trade-offs in research/system-tradeoffs.md.', artifacts: { plan: ['research/system-design.md'], experiment: [], analysis: ['research/system-tradeoffs.md'] } },
  { type: 'benchmark', label: '基准 / 评测 / 资源论文', description: '定义测量目标，检查覆盖范围、指标可靠性与资源复用价值。', empirical: true, ...empiricalSkills, planSkills: ['benchmark-research-skill', 'experiment-plan'], writingSkills: ['benchmark-paper-template', ...empiricalSkills.writingSkills],
    focus: 'Establish measurement value, construct validity, coverage and metric reliability. Check provenance, annotation, leakage and access where applicable. A new method or dataset is not required for every evaluation paper.',
    plan: 'Freeze measurement target, coverage, protocol, metrics and applicable data-quality checks in research/benchmark-protocol.md.', execution: 'Execute the benchmark or evaluation protocol and retain all attempted runs.', analysis: 'Assess construct validity, coverage, metric reliability and applicable leakage risks in research/benchmark-validity.md.', artifacts: { plan: ['research/benchmark-protocol.md'], experiment: [], analysis: ['research/benchmark-validity.md'] } },
  { type: 'empirical', label: '实证分析 / 负结果论文', description: '研究经验规律或失败边界，保留负结果并区分无效与不确定。', empirical: true, ...empiricalSkills,
    focus: 'State sampling, controls and uncertainty. Separate observations from causal attribution; an inconclusive pilot is not a demonstrated negative result. A new method or positive gain is not required.',
    plan: 'Freeze the empirical question, sampling, sensitivity and alternative explanations in research/analysis-design.md.', execution: 'Execute the frozen study and retain failed, missing and opposing results.', analysis: 'Distinguish implementation failure, inconclusive evidence, supported effects and informative negative results.', artifacts: { plan: ['research/analysis-design.md'], experiment: [], analysis: [] } },
  { type: 'replication', label: '复现 / 可重复性论文', description: '复核已有结论，记录实现差异、协议偏离与一致性证据。', empirical: true, ...empiricalSkills,
    focus: 'Identify the original claim and protocol. Evaluate faithful implementation, departures and uncertainty; non-significance does not establish equality.',
    plan: 'Identify the original sources, claims and protocol, plus intended deviations, in research/replication-protocol.md.', execution: 'Record actual departures, implementation checks and reproduction conditions in research/replication-deviations.md.', analysis: 'Explain what confirmation or disagreement establishes relative to the original claim.', artifacts: { plan: ['research/replication-protocol.md'], experiment: ['research/replication-deviations.md'], analysis: [] } },
  { type: 'theory', label: '理论 / 形式化论文', description: '明确假设与定义，以证明或反例支持形式化结论。', empirical: false,
    planSkills: [], executionSkills: [], analysisSkills: [], writingSkills: ['paper-writer'],
    focus: 'Check definitions, assumptions, theorem scope, proofs and counterexamples. Experiments cannot substitute for a missing proof; empirical side claims require their own evidence.',
    plan: 'Write precise definitions, assumptions and target statements in research/definitions.md.', execution: 'Write checkable proofs, counterexamples and unresolved proof obligations in research/proofs.md; do not fabricate empirical runs.', analysis: 'Audit logical dependencies, theorem scope and unresolved proof obligations.', artifacts: { plan: ['research/definitions.md'], experiment: ['research/proofs.md'], analysis: [] } },
  { type: 'survey', label: '综述 / 文献综合论文', description: '明确检索与纳入标准，形成有来源依据的分类和综合。', empirical: false,
    planSkills: ['research-lit'], executionSkills: ['research-lit'], analysisSkills: [], writingSkills: ['paper-writer'],
    focus: 'State coverage and source/version quality. Build useful synthesis or taxonomy. Systematic or exhaustive claims require a transparent matching search protocol, not a new experiment.',
    plan: 'Record scope, queries, search dates and inclusion/exclusion criteria in research/search-protocol.md.', execution: 'Save research/source-selection.json as a nonempty array of {sourceId, decision:"include"|"exclude", reason}; use registered source IDs, retain exclusions, and include at least one source. Preserve the actual search record.', analysis: 'Synthesize included sources, compare findings and expose coverage gaps; distinguish selective from systematic coverage.', artifacts: { plan: ['research/search-protocol.md'], experiment: ['research/source-selection.json'], analysis: [] } },
  { type: 'position', label: '观点 / 概念论文', description: '提出清晰论点，以文献、论证和反方观点检验其成立范围。', empirical: false,
    planSkills: [], executionSkills: ['research-lit'], analysisSkills: [], writingSkills: ['good-story', 'paper-writer'],
    focus: 'State the thesis, supporting reasoning, alternatives and implications. Separate normative proposals from factual assertions; new experiments or a system are not required.',
    plan: 'Record the thesis, argument structure and serious alternatives in research/argument-plan.md.', execution: 'Ground factual premises in sources and assess objections in research/argument-evidence.md.', analysis: 'Examine logical consistency, counterarguments, inference limits and practical implications.', artifacts: { plan: ['research/argument-plan.md'], experiment: ['research/argument-evidence.md'], analysis: [] } },
];

export function paperTypePreference(state: State, inputs: ResearchInputValues | undefined = state.researchInputs): PaperType | null {
  if (inputs?.paperType !== undefined) return inputs.paperType;
  return state.config.researchKind === 'theory' ? 'theory' : state.config.researchKind === 'survey' ? 'survey' : 'method';
}
export function paperType(state: State): PaperType | null {
  const preference = paperTypePreference(state); if (preference !== null) return preference;
  const resolution = state.paperTypeResolution; const task = resolution && state.tasks[resolution.taskId];
  return resolution && resolution.inputRevision === (state.researchInputs?.revision ?? 0) && resolution.topicVersion === state.topic.version
    && task?.acceptance === 'accepted' && task.review?.session === resolution.session ? resolution.type : null;
}
const undecided: PaperProfile = {
  type: null, label: '暂不选择 · 自动判断', description: '先围绕研究问题探索，在选题审查后判断适合的论文类型。', empirical: false,
  focus: 'No contribution type has been selected. Explore the question and evidence without assuming a method, experiment or positive result. The independent topic review must recommend a suitable contribution type with reasons before downstream work.',
  plan: 'Await the accepted topic and its contribution type before planning.', execution: 'Await the contribution-specific investigation protocol.', analysis: 'Await contribution-specific analysis requirements.',
  planSkills: [], executionSkills: [], analysisSkills: [], writingSkills: ['paper-writer'], artifacts: { plan: [], experiment: [], analysis: [] },
};
export function paperProfile(type: PaperType | null): PaperProfile { return type === null ? undecided : paperProfiles.find(profile => profile.type === type)!; }
export function taskPaperType(state: State, task: Task): PaperType | null { return task.paperType !== undefined ? task.paperType : paperType(state); }

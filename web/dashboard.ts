import type { AgentInvocation, DashboardSnapshot, DashboardTask, Lane, ResearchSeed, SeedKind, TaskPhase, TraceCategory, TraceDetail, TraceEntry, TracePage, VenueCatalog } from './types.js';
import { initWorkspace, workspacePending, updateInitialization } from './workspace.js';
import { parsePaperReference, paperLink, type PaperReference } from './paper-reference.js';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const labels: Record<string, string> = { topic: '选题', literature: '文献', plan: '方案', experiment: '实验', analysis: '分析', writing: '写作', review: '审查', delivery: '交付', pending: '待执行', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已取消', limited: '预算受限', interrupted: '已中断', accepted: '已验收', blocked: '验收阻塞', stale: '验收已过期', open: '待回应', responded: '待复核', resolved: '已解决', limitation: '已记录局限', critical: '关键', major: '重大', minor: '次要', automatic: '自动模式', autopilot: '选题后自主运行', on_demand: '按需执行', APPROVED: '选题已批准', AWAITING_TOPIC_APPROVAL: '等待选题批准', UNSELECTED: '尚未选题' };
const eventLabels: Record<string, string> = { project_initialized: '项目初始化', task_added: '任务已登记', task_dispatched: '任务已派发', worker_started: '工作进程启动', worker_finished: '工作进程结束', worker_interrupted: '工作进程中断', task_stopped: '任务已停止', task_accepted: '任务通过验收', topic_approved: '用户批准选题', topic_approval_required: '等待用户批准选题', adversarial_retrieval_started: '开始反例检索', retrieval_completed: '检索完成', retrieval_cache_hit: '复用检索证据', evidence_snapshotted: '证据快照已保存', claim_recorded: '论点已登记', challenge_responded: '质疑已回应', independent_review_started: '独立审查开始', independent_review_completed: '独立审查完成', independent_review_reused: '复用有效审查', acceptance_blocked: '科学验收被阻塞', execution_artifacts_checked: '执行产物检查完成', deterministic_check_started: '确定性校验开始', deterministic_check_completed: '确定性校验完成', deterministic_checks_not_applicable: '本阶段无需确定性校验', model_request_started: '模型请求开始', model_request_completed: '模型请求完成', model_request_failed: '模型请求失败', tool_started: '工具执行开始', tool_completed: '工具执行完成', skills_loaded: '研究方法已载入', validation_feedback: '校验反馈已送回', process_started: '本地进程启动', process_finished: '本地进程结束', cancel_requested: '收到取消请求', retry_authorized: '已登记新的尝试', resources_authorized: '资源额度已更新', inbox_consumed: '补充指令已读取', steering_queued: '补充指令已排队' };
const stageOrder = ['topic', 'literature', 'plan', 'experiment', 'analysis', 'writing', 'review', 'delivery'];
const laneLabels: Record<Lane, string> = { queued: '等待执行', active: '正在执行', attention: '需要关注', done: '已验收' };
let snapshot: DashboardSnapshot | undefined;
const viewFromHash = () => ['agents', 'trace', 'evidence', 'events'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'board';
let view = viewFromHash(); let stage = ''; let query = ''; let busy = false; let previewRequest = 0;
let streamLive = false; let lastSnapshotVersion = ''; let agentFilter = 'all';
const phaseLabels: Record<TaskPhase, string> = { waiting: '等待条件满足', ready: '可派发 · 等待 runtime', preparing: '准备执行', retrieval: '检索证据', model: '等待模型返回', tool: '执行工具', checking: '检查与验收', reviewing: '独立审查中', completed: '已验收', attention: '需要关注', offline: '工作进程离线', stalled: '心跳超时' };
const workflowLabels: Record<DashboardSnapshot['workflow']['status'], string> = { empty: '尚无任务', running: '正在推进', attention: '需要处理阻塞', waiting_approval: '等待选题批准', ready: '等待 runtime 派发', waiting: '等待执行条件', completed: '全部任务已验收' };
const agentLabels: Record<AgentInvocation['status'], string> = { queued: '等待启动', running: '运行中', completed: '调用结束', blocked: '审查阻塞', failed: '调用失败', cancelled: '已取消', limited: '额度用尽', interrupted: '已中断', uncertain: '请求结果未确认', offline: '进程离线' };
let editingBase: { paperType: DashboardSnapshot['paperTypePreference']; seedPapers: ResearchSeed[]; targetJournal: DashboardSnapshot['researchInputs']['targetJournal'] } | undefined;
const editedFields = new Set<'paperType' | 'seedPapers' | 'targetJournal'>();
let editingRevision = 0; let editingRecord = ''; let savingInputs = false; let selectedTaskId = '';
let venues: VenueCatalog | undefined; let loadingVenues = false;
let startingRun = false; let runMessage = ''; let runFailed = false; let projectAvailable = false;
let controllingRun: 'pause' | 'resume' | 'terminate' | undefined;
const traceCategories: Record<TraceCategory, string> = { model: '模型调用', tool: '工具执行', retrieval: '证据检索', check: '校验与反馈', review: '独立审查', lifecycle: '任务流程' };
let traceTask = ''; let traceCategory = ''; let traceAttempt = ''; let traceEpoch = 0; let traceBusy = false; let traceSeen = -1; let traceError = '';
let tracePage: TracePage | undefined;
const traceEntries = new Map<number, TraceEntry>(); const traceDetails = new Map<number, TraceDetail>(); const traceOpen = new Set<number>(); const tracePending = new Set<number>(); const traceDetailErrors = new Map<number, string>();
const seedKinds: Record<SeedKind, { label: string; title: string; titleHint: string; notes: string; notesHint: string; url: string; urlHint: string }> = {
  paper: { label: '参考论文', title: '论文', titleHint: '粘贴论文链接、DOI，或输入标题', notes: '关注点', notesHint: '希望借鉴的方法、需要比较的结果或待验证的问题', url: '论文链接', urlHint: '论文主页或 arXiv 链接' },
  direction: { label: '研究方向', title: '方向或研究问题', titleHint: '填写希望探索的研究方向或问题', notes: '研究设想与边界', notesHint: '希望探索什么、为什么值得研究、已有想法及范围约束', url: '相关资料链接', urlHint: '与这个方向有关的资料，可留空' },
  engineering_problem: { label: '工程问题', title: '遇到的问题', titleHint: '填写实际遇到的工程问题', notes: '场景、现象与约束', notesHint: '在哪个场景遇到？实际表现与预期有什么差异？影响、复现线索和资源约束是什么？', url: '问题记录或相关资料', urlHint: '问题记录、技术文档等，可留空' },
};
Object.assign(eventLabels, { workflow_graph_selected: '已配置论文类型流程', workflow_acceptance_invalidated: '流程前置条件已变化', workflow_revision_requested: '检查点要求返工', workflow_revision_applied: '已返回修订节点', workflow_revision_cancelled: '旧流程返工已取消', workflow_node_reopened: '节点已重新排队', workflow_stopped: '流程已停止', research_inputs_updated: '研究输入已更新', research_direction_changed: '研究主题已更换，需重新选题', seed_priority_changed: '种子优先级已更新，需重新选题', paper_type_changed: '论文类型已更换', paper_type_resolved: '已自动判断论文类型', paper_type_resolution_invalidated: '论文类型判断已过期', paper_type_task_routed: '任务已按论文类型调整', research_input_lookup_started: '开始研究输入检索', research_input_lookup_completed: '研究输入检索完成', independent_review_failed: '独立审查失败' });
const number = (n: number) => new Intl.NumberFormat('zh-CN').format(Math.round(n));
Object.assign(eventLabels, { project_initialization_started: '项目初始化开始', project_initialization_stage: '初始化阶段更新', project_initialization_scan: '扫描项目文件', project_initialization_field: '已核验字段来源', project_initialization_finished: '项目初始化结束', project_initialization_failed: '项目初始化未完成' });
Object.assign(eventLabels, { scheduler_start_requested: '已请求启动研究', scheduler_started: '后台调度已启动', scheduler_stopped: '后台调度已停止', scheduler_failed: '后台调度失败' });
Object.assign(eventLabels, { execution_paused: '已暂停任务派发', execution_resumed: '已继续任务派发', execution_terminated: '已请求终止研究', execution_reopened: '已通过诊断重试重新开放执行' });
function duration(n: number) { if (n < 60) return `${Math.round(n)} 秒`; if (n < 3600) return `${Math.floor(n / 60)} 分 ${Math.floor(n % 60)} 秒`; return `${Math.floor(n / 3600)} 小时 ${Math.floor(n % 3600 / 60)} 分`; }
function time(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function status(value: string, text?: string) { const tone = ['accepted', 'APPROVED', 'resolved', 'PASS'].includes(value) ? 'good' : ['blocked', 'limited', 'stale', 'AWAITING_TOPIC_APPROVAL', 'WARN', 'BLOCKED'].includes(value) ? 'warn' : ['failed', 'interrupted', 'ERROR', 'FAIL'].includes(value) ? 'bad' : value === 'running' ? 'active' : ''; return `<span class="status ${tone}">${escape(text ?? labels[value] ?? value)}</span>`; }
const matches = (data: unknown) => !query || JSON.stringify(data).toLowerCase().includes(query);
const taskMatchesStage = (id?: string) => !stage || snapshot?.tasks.some(t => t.id === id && t.stage === stage);
const artifactButton = (name: string, label = name) => `<button class="file-button" data-artifact="${escape(name)}" data-focus="file-${escape(name)}">${escape(label)}</button>`;
const taskButton = (id: string) => `<button class="text-button" data-task="${escape(id)}" data-focus="link-${escape(id)}">${escape(id)}</button>`;
function empty(title: string, body: string) { return `<div class="empty-state"><h2>${escape(title)}</h2><p>${escape(body)}</p></div>`; }
function replaceHtml(selector: string, html: string) { const element = $(selector); if (element.dataset.rendered !== html) { element.innerHTML = html; element.dataset.rendered = html; } }
function shape(s: DashboardSnapshot) { return JSON.stringify({ ...s, initialization: s.initialization ? { ...s.initialization, elapsedSeconds: 0 } : undefined, updatedAt: '', tasks: s.tasks.map(t => ({ ...t, elapsedSeconds: 0, heartbeat: 0 })), agents: s.agents.map(a => ({ ...a, elapsedSeconds: 0, heartbeat: 0 })) }); }
function heartbeatLabel(a: AgentInvocation, now: number) {
  if (a.health === 'offline') return '进程离线';
  if (a.health === 'late') return '心跳超时';
  if (a.health === 'none') return a.finishedAt ? '调用已结束' : '无活动心跳';
  return a.heartbeat ? `${a.role === 'reviewer' ? '宿主' : ''}心跳 ${duration(Math.max(0, (now - a.heartbeat) / 1000))}前` : '等待心跳';
}
function updateClock(s: DashboardSnapshot) {
  for (const element of document.querySelectorAll<HTMLElement>('[data-task-time]')) {
    const task = s.tasks.find(t => t.id === element.dataset.taskTime); if (task) element.textContent = duration(task.elapsedSeconds);
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-agent-time]')) {
    const agent = s.agents.find(a => a.id === element.dataset.agentTime); if (agent) element.textContent = agent.startedAt ? duration(agent.elapsedSeconds) : '时长未记录';
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-agent-heartbeat]')) {
    const agent = s.agents.find(a => a.id === element.dataset.agentHeartbeat); if (agent) element.textContent = heartbeatLabel(agent, Date.parse(s.updatedAt));
  }
  $('#last-updated').textContent = `数据更新于 ${new Date(s.updatedAt).toLocaleTimeString('zh-CN')} · ${streamLive ? '事件实时推送 · 每秒检查心跳' : '每 2 秒轮询 · 正在恢复推送'}`;
}

function renderRunControl(s: DashboardSnapshot) {
  const control = s.runControl; $('#run-controls').hidden = false;
  const disabled = startingRun || !!controllingRun || !projectAvailable;
  const paused = control?.status === 'paused' || control?.status === 'pausing';
  const button = $<HTMLButtonElement>('#start-run'); button.disabled = disabled || !control?.canStart; button.hidden = paused;
  button.textContent = startingRun ? '正在启动…' : control?.label ?? '一键启动';
  const pause = $<HTMLButtonElement>('#pause-run'); pause.disabled = disabled || !control?.canPause; pause.hidden = paused;
  pause.textContent = controllingRun === 'pause' ? '正在暂停…' : '暂停';
  const resume = $<HTMLButtonElement>('#resume-run'); resume.disabled = disabled || !control?.canResume; resume.hidden = !paused;
  resume.textContent = controllingRun === 'resume' ? '正在继续…' : '继续';
  const terminate = $<HTMLButtonElement>('#terminate-run'); terminate.disabled = disabled || !control?.canTerminate;
  terminate.textContent = controllingRun === 'terminate' || control?.status === 'terminating' ? '正在终止…' : '终止';
  let reason = control?.reason ?? '正在读取启动状态…';
  if (s.workspace) reason = reason.replace('请按 runtime 配置设置环境变量并重启看板。', '请在后端配置模型凭据。').replace('请先通过 CLI 调整已授权的额度。', '请在后端调整已授权的运行额度。');
  $('#run-reason').textContent = reason;
  $('#run-result').textContent = runMessage; $('#run-result').hidden = !runMessage;
  $('#run-result').classList.toggle('run-error', runFailed);
}
async function startRun() {
  if (startingRun || controllingRun || !projectAvailable || !snapshot?.runControl?.canStart) return;
  startingRun = true; runMessage = ''; runFailed = false; renderRunControl(snapshot);
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Research-Control': '1', 'X-Research-Workspace': encodeURIComponent(snapshot.workspace?.record ?? '') }, body: JSON.stringify({ expectedRevision: snapshot.researchInputs.revision, topicVersion: snapshot.topic.version }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '启动失败，请重试。');
    runMessage = result.alreadyRunning ? '该项目已经运行，无需重复启动。' : '已启动，可在下方查看实时 Workflow、Subagent 和 Trace。';
  } catch (error) { runFailed = true; runMessage = error instanceof Error ? error.message : '启动状态未确认，请刷新查看后再试。'; }
  finally { startingRun = false; await refresh(); if (snapshot) renderRunControl(snapshot); }
}
async function controlRun(action: 'pause' | 'resume' | 'terminate') {
  if (startingRun || controllingRun || !projectAvailable || !snapshot) return;
  const control = snapshot.runControl;
  if (!(action === 'pause' ? control.canPause : action === 'resume' ? control.canResume : control.canTerminate)) return;
  const record = snapshot.workspace?.record;
  controllingRun = action; runMessage = ''; runFailed = false; renderRunControl(snapshot);
  try {
    const response = await fetch('/api/run/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Research-Control': '1', 'X-Research-Workspace': encodeURIComponent(record ?? '') }, body: JSON.stringify({ action, runId: control.runId, revision: control.revision, expectedRevision: snapshot.researchInputs.revision, topicVersion: snapshot.topic.version }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '操作失败，请重试。');
    if (snapshot?.workspace?.record === record) runMessage = action === 'pause' ? '已暂停派发，当前任务完成后保持暂停。' : action === 'resume' ? '已继续，可查看下方实时进度。' : '终止请求已保存，可在下方查看任务取消结果；产物和 Trace 会保留。';
  } catch (error) { runFailed = true; runMessage = error instanceof Error ? error.message : '操作状态未确认，请刷新查看。'; }
  finally { controllingRun = undefined; await refresh(); if (snapshot) renderRunControl(snapshot); }
}
function renderHeader(s: DashboardSnapshot) {
  $('#project-header').hidden = false;
  renderRunControl(s);
  Object.assign(labels, s.stageLabels);
  const accepted = s.tasks.filter(t => t.lane === 'done').length;
  const attention = s.tasks.filter(t => t.lane === 'attention').length;
  $('#project-header').innerHTML = `<div><div class="project-meta"><span class="project-name">${escape(s.project)}</span><span class="mode-tag">${escape(labels[s.mode] ?? s.mode)}</span></div>${s.workspace ? '' : `<h1 class="goal">${escape(s.goal || '尚未设置研究目标')}</h1>`}<div class="project-bottom">${status(s.topic.status)}<span><strong>${accepted} / ${s.tasks.length}</strong> 个任务已验收</span>${attention ? `<span><strong>${attention}</strong> 项需要关注</span>` : ''}${s.topic.proposal ? artifactButton(s.topic.proposal, '查看选题报告') : ''}</div></div>`;
  $('#stages').classList.toggle('workflow-nodes', !!s.pipelineGraph);
  replaceHtml('#stages', s.pipelineGraph ? s.pipelineGraph.nodes.map((node, index) => {
    const task = s.tasks.find(t => t.id === node.id); const complete = task?.acceptance === 'accepted';
    const name = (id: string) => s.pipelineGraph!.nodes.find(n => n.id === id)?.label ?? id;
    return `<button class="stage ${complete ? 'complete' : task?.lane === 'active' || task?.lane === 'attention' ? 'current' : ''}" data-task="${escape(node.id)}" title="${escape(node.reworkTargets.length ? '验收失败可返回：' + node.reworkTargets.map(name).join('、') : '验收通过后进入后续节点')}"><span class="stage-number">${complete ? '✓' : index + 1}</span><span class="stage-text">${escape(node.label)}<small>${escape(task ? labels[task.acceptance] : '等待配置')}</small>${node.dependencies.length ? `<small>前置：${escape(node.dependencies.map(name).join('、'))}</small>` : ''}${node.reworkTargets.length ? '<small>含返工检查点</small>' : ''}</span></button>`;
  }).join('') : stageOrder.map((name, index) => {
    const tasks = s.tasks.filter(t => t.stage === name); const count = tasks.filter(t => t.lane === 'done').length; const progress = s.workflow.stages.find(p => p.stage === name)!;
    const complete = tasks.length > 0 && count === tasks.length; const current = tasks.some(t => t.lane === 'active' || t.lane === 'attention');
    return `<button class="stage ${complete ? 'complete' : current ? 'current' : ''} ${stage === name ? 'selected' : ''}" data-stage="${name}" data-focus="stage-${name}" aria-pressed="${stage === name}"><span class="stage-number">${complete ? '✓' : index + 1}</span><span class="stage-text">${labels[name]}<small>${tasks.length ? `${count} / ${tasks.length} 已验收` : '暂无任务'}</small>${progress.active ? `<small class="stage-activity">${progress.active} 项运行中</small>` : progress.blocked ? `<small class="stage-attention">${progress.blocked} 项需关注</small>` : ''}</span></button>`;
  }).join(''));
  renderWorkflow(s);
  const inputs = s.researchInputs;
  const profile = s.paperTypes.find(profile => profile.type === s.paperType);
  const typeLabel = s.paperTypePreference === null ? '暂不选择 · 自动判断' : profile?.label ?? '暂不选择 · 自动判断';
  const typeDescription = s.paperTypePreference === null ? (profile ? `已判断为${profile.label}。${s.paperTypeReason ?? ''}` : '先探索研究问题，在选题审查后判断合适的论文类型。') : profile?.description ?? '';
  replaceHtml('#research-inputs', `<div class="direction-overview paper-type-overview"><div class="direction-summary"><h2>论文类型</h2><p class="direction-name">${escape(typeLabel)}</p><p class="input-empty">${escape(typeDescription)}</p></div><button class="quiet-button" data-edit-inputs="paper-type">选择论文类型</button></div><div class="seed-overview"><div class="input-heading"><h2>论文种子 <span class="lane-count">${inputs.seedPapers.length}</span></h2><button class="text-button" data-edit-inputs="seeds">${inputs.seedPapers.length ? '管理论文种子' : '添加论文种子'}</button></div><p class="input-empty">按优先级排序，越靠前越先研究。</p>${inputs.seedPapers.length ? `<ol class="seed-summary">${inputs.seedPapers.slice(0, 3).map((seed, index) => `<li><span class="seed-rank">${index + 1}.</span><span class="seed-kind">${seedKinds[seed.kind ?? 'paper'].label}</span>${paperLink(seed) ? `<a href="${escape(paperLink(seed))}" target="_blank" rel="noopener noreferrer">${escape(seed.title || seed.notes || seed.url || '尚未填写')}</a>` : `<span>${escape(seed.title || seed.notes || seed.url || '尚未填写')}</span>`}</li>`).join('')}</ol>${inputs.seedPapers.length > 3 ? `<p class="editor-note">另有 ${inputs.seedPapers.length - 3} 条，打开管理查看全部。</p>` : ''}` : '<p class="input-empty">从研究方向、工程中遇到的问题或参考论文开始。</p>'}</div><div class="journal-overview"><div class="input-heading"><h2>目标会议 / 期刊</h2><button class="text-button" data-edit-inputs="journal">${inputs.targetJournal ? '编辑目标会议/期刊' : '设置目标会议/期刊'}</button></div><p class="journal-name">${escape(inputs.targetJournal?.name ?? '尚未确定')}</p><p class="input-empty">${escape(inputs.targetJournal?.notes || '指定投稿方向，帮助选题、写作与审查。')}</p></div>`);
}

function renderWorkflow(s: DashboardSnapshot) {
  const w = s.workflow;
  const controlLabel = ({ pausing: '已暂停派发 · 当前任务收尾中', paused: '工作流已暂停', terminating: '正在终止研究', terminated: '研究已终止' } as Record<string, string>)[s.runControl?.status];
  const active = s.tasks.filter(t => w.activeTaskIds.includes(t.id));
  const waiting = s.tasks.filter(t => ['waiting', 'ready', 'attention', 'offline', 'stalled'].includes(t.progress.phase));
  const shown = [...active, ...waiting].slice(0, Math.max(3, active.length));
  replaceHtml('#workflow-live', `<div class="workflow-summary"><div class="workflow-title"><span class="eyebrow">WORKFLOW</span><h2>${controlLabel ?? workflowLabels[w.status]}</h2><p>${w.activeExecutors} 个执行 Agent · ${w.activeReviewers} 个审查会话运行中</p>${s.pipelineGraph ? `<p>已返工 ${s.pipelineGraph.revisions} 次</p>` : ''}</div><div class="workflow-meters"><label for="workflow-executed">执行完成<strong>${w.executed} / ${w.total}</strong></label><progress id="workflow-executed" max="${w.total || 1}" value="${w.executed}"></progress><label for="workflow-accepted">科学验收<strong>${w.accepted} / ${w.total}</strong></label><progress id="workflow-accepted" max="${w.total || 1}" value="${w.accepted}"></progress></div><div class="workflow-counts"><span><strong>${w.active}</strong>执行中</span><span><strong>${w.blocked}</strong>需关注</span><span><strong>${w.ready + w.waiting}</strong>待执行</span><button class="text-button" data-view="agents">查看 Subagent 调用 →</button></div></div>${shown.length ? `<div class="workflow-activity">${shown.map(t => `<button class="activity-row" data-task="${escape(t.id)}" data-focus="activity-${escape(t.id)}"><span class="activity-dot ${s.workflow.activeTaskIds.includes(t.id) ? 'live' : ''}"></span><strong>${escape(t.nodeLabel ?? t.id)}</strong><span class="activity-phase">${phaseLabels[t.progress.phase]}</span><span class="activity-detail">${escape(t.progress.waitReasons[0] || t.reasons[0] || t.progress.detail || (t.progress.phase === 'ready' ? '条件已满足，等待 runtime 执行' : t.prompt))}</span><span aria-hidden="true">↗</span></button>`).join('')}</div>` : ''}`);
}
function agentNode(a: AgentInvocation) {
  const live = a.status === 'running';
  const tone = ['offline', 'uncertain'].includes(a.status) ? 'failed' : a.status;
  return `<article class="agent-node ${a.role} ${live ? 'agent-live' : ''}" data-agent-id="${escape(a.id)}"><div class="agent-heading"><span class="agent-avatar" aria-hidden="true">${a.role === 'executor' ? 'E' : 'R'}</span><div class="agent-title"><h3>${a.role === 'executor' ? '执行 Agent' : '独立审查 Agent'} <span>${escape(a.task)}${a.role === 'executor' ? ` · 第 ${a.attempt} 次` : ''}</span></h3><p>${a.mode === 'process' ? `独立工作进程${a.pid ? ` · PID ${a.pid}` : ''}` : a.role === 'reviewer' ? '独立上下文 · 运行于执行进程内' : '历史会话记录'}${a.model ? ` · ${escape(a.model)}` : ''}</p></div>${status(tone, agentLabels[a.status])}</div><div class="agent-operation"><strong>${live || ['offline', 'interrupted'].includes(a.status) ? phaseLabels[a.phase] : a.verdict ? `审查结论：${escape(a.verdict)}` : agentLabels[a.status]}</strong><span>${escape(a.detail)}</span></div><div class="agent-metrics"><span><b>${a.calls.model}</b> 模型调用</span><span><b>${a.calls.tools}</b> 工具调用</span><span>${number(a.calls.inputTokens)} 输入 / ${number(a.calls.outputTokens)} 输出 tokens</span><span data-agent-time="${escape(a.id)}">${a.startedAt ? duration(a.elapsedSeconds) : '时长未记录'}</span>${a.calls.unknown ? `<span class="uncertain-count">${a.calls.unknown} 次结果未确认</span>` : ''}${a.processCount ? `<span>${a.processCount} 个本地工具进程</span>` : ''}${a.calls.reusedReviews ? `<span>${a.calls.reusedReviews} 次复用审查</span>` : ''}</div><div class="agent-footer"><span class="agent-session" title="${escape(a.session)}">会话 ${escape(a.session)}</span><span data-agent-heartbeat="${escape(a.id)}">${heartbeatLabel(a, Date.parse(snapshot!.updatedAt))}</span><button class="text-button" data-trace-task="${escape(a.task)}" data-trace-agent="${escape(a.role)}" data-trace-attempt="${a.attempt}">查看 Trace →</button></div></article>`;
}
function renderAgents(s: DashboardSnapshot) {
  const attention = new Set(['blocked', 'failed', 'cancelled', 'limited', 'interrupted', 'uncertain', 'offline']);
  const parents = s.agents.filter(a => a.role === 'executor').sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const visible = parents.filter(a => {
    const family = [a, ...s.agents.filter(child => child.parentId === a.id)];
    return taskMatchesStage(a.task) && family.some(matches) && (agentFilter === 'all' || family.some(node => agentFilter === 'active' ? node.status === 'running' : attention.has(node.status)));
  });
  return `<section class="agents-panel"><div class="agent-toolbar"><div><h2>Subagent 调用</h2><p>按实际派发记录展开执行进程与独立审查会话；工具命令另计。</p></div><label>显示<select id="agent-filter"><option value="all" ${agentFilter === 'all' ? 'selected' : ''}>全部调用</option><option value="active" ${agentFilter === 'active' ? 'selected' : ''}>正在运行</option><option value="attention" ${agentFilter === 'attention' ? 'selected' : ''}>需要关注</option></select></label></div><div class="scheduler-node"><span class="scheduler-icon" aria-hidden="true">↳</span><div><strong>任务调度</strong><p>${s.workflow.ready} 项可派发 · ${s.workflow.waiting} 项等待条件</p></div><span>${s.workflow.activeExecutors} 个执行 Agent / ${s.workflow.activeReviewers} 个审查会话运行中</span></div><div class="agent-tree">${visible.map(a => `<div class="agent-branch">${agentNode(a)}${s.agents.filter(child => child.parentId === a.id).map(child => `<div class="agent-child">${agentNode(child)}</div>`).join('')}</div>`).join('') || empty(s.agents.length ? '没有匹配的调用' : '尚未调用 Subagent', s.agents.length ? '调整筛选或搜索条件。' : '任务被 runtime 派发后，执行进程、模型与工具调用会显示在这里。')}</div></section>`;
}

function updateSeedFields(item: HTMLFieldSetElement) {
  const kind = item.querySelector<HTMLSelectElement>('[name="seedKind"]')!.value as SeedKind; const copy = seedKinds[kind];
  item.querySelector<HTMLElement>('[data-seed-title-label]')!.textContent = copy.title + (kind === 'paper' ? '' : '（可选，可重复）');
  item.querySelector<HTMLInputElement>('[name="seedTitle"]')!.placeholder = copy.titleHint;
  item.querySelector<HTMLInputElement>('[name="seedTitle"]')!.maxLength = kind === 'paper' ? 2048 : 500;
  item.querySelector<HTMLInputElement>('[name="seedTitle"]')!.required = kind === 'paper';
  item.querySelector<HTMLElement>('[data-seed-notes-label]')!.textContent = copy.notes;
  item.querySelector<HTMLTextAreaElement>('[name="seedNotes"]')!.placeholder = copy.notesHint;
  item.querySelector<HTMLElement>('[data-seed-url-label]')!.textContent = copy.url;
  item.querySelector<HTMLInputElement>('[name="seedUrl"]')!.placeholder = copy.urlHint;
  item.querySelector<HTMLElement>('[data-seed-doi-field]')!.hidden = kind !== 'paper';
  item.querySelector<HTMLInputElement>('[name="seedDoi"]')!.disabled = kind !== 'paper';
  item.querySelector('.reference-fields')!.classList.toggle('single-reference', kind !== 'paper');
  const details = item.querySelector<HTMLDetailsElement>('[data-reference-details]')!;
  details.open = kind !== 'paper';
  details.querySelector('summary')!.hidden = kind !== 'paper';
  item.querySelector<HTMLElement>('[data-reference-lookup]')!.hidden = kind !== 'paper';
  if (kind !== 'paper') item.querySelector<HTMLElement>('[data-reference-results]')!.replaceChildren();
}
function updateSeedLabels() {
  document.querySelectorAll<HTMLFieldSetElement>('#seed-list .seed-editor').forEach((item, index) => {
    const kind = item.querySelector<HTMLSelectElement>('[name="seedKind"]')!.value as SeedKind;
    const label = `${index + 1} · ${seedKinds[kind].label}`;
    item.querySelector('legend')!.textContent = label;
    item.querySelector('[data-seed-order]')!.setAttribute('aria-label', `调整第 ${index + 1} 条种子的优先级：${seedKinds[kind].label}`);
    item.querySelectorAll<HTMLButtonElement>('[data-seed-move]').forEach(button => {
      const towardStart = ['up', 'first'].includes(button.dataset.seedMove!);
      button.disabled = towardStart ? !item.previousElementSibling : !item.nextElementSibling;
      button.setAttribute('aria-label', `${button.textContent!.trim()}第 ${index + 1} 条种子`);
    });
    item.querySelector('[data-remove-seed]')!.setAttribute('aria-label', `移除第 ${index + 1} 条种子（${seedKinds[kind].label}）`);
  });
}
function announceSeedOrder(item: HTMLFieldSetElement) {
  const index = Array.from($('#seed-list').children).indexOf(item);
  const title = item.querySelector<HTMLInputElement>('[name="seedTitle"]')!.value.trim() || '未命名种子';
  $('#seed-order-status').textContent = `${title}已移到第 ${index + 1} 位，保存后生效。`;
}
function moveSeed(item: HTMLFieldSetElement, move: string, control: HTMLElement) {
  editedFields.add('seedPapers');
  const list = $('#seed-list');
  if (move === 'up' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
  if (move === 'down' && item.nextElementSibling) list.insertBefore(item, item.nextElementSibling.nextElementSibling);
  if (move === 'first') list.prepend(item);
  if (move === 'last') list.append(item);
  updateSeedLabels(); announceSeedOrder(item);
  const focusTarget = control instanceof HTMLButtonElement && control.disabled ? item.querySelector<HTMLElement>('[data-seed-order]')! : control;
  focusTarget.focus();
}
function updatePaperType() {
  const type = $<HTMLSelectElement>('#paper-type').value;
  if (!type) {
    $('#paper-type-description').textContent = '可以先不限定论文类型，根据研究问题、种子和证据探索。';
    $('#paper-type-workflow').textContent = '选题审查会记录适合的类型及理由，再安排相应研究流程；具体选题仍需确认。';
    return;
  }
  const profile = snapshot?.paperTypes.find(profile => profile.type === type); if (!profile) return;
  $('#paper-type-description').textContent = profile.description;
  $('#paper-type-workflow').textContent = profile.nodes ? '流程节点：' + profile.nodes.join('、') + '。检查点按证据决定继续、返回指定节点或停止。' : '按所选论文类型配置研究节点与验收检查。';
}
function bindPaperReference(item: HTMLFieldSetElement, seed?: ResearchSeed) {
  const title = item.querySelector<HTMLInputElement>('[name="seedTitle"]')!;
  const doi = item.querySelector<HTMLInputElement>('[name="seedDoi"]')!;
  const url = item.querySelector<HTMLInputElement>('[name="seedUrl"]')!;
  const kind = item.querySelector<HTMLSelectElement>('[name="seedKind"]')!;
  const message = item.querySelector<HTMLElement>('[data-reference-status]')!;
  const results = item.querySelector<HTMLElement>('[data-reference-results]')!;
  const button = item.querySelector<HTMLButtonElement>('[data-resolve-reference]')!;
  const original = item.querySelector<HTMLElement>('[data-reference-original]')!;
  let version = 0; let pending = '';
  item.dataset.referenceInput = seed?.referenceInput ?? '';
  const showOriginal = () => { original.textContent = item.dataset.referenceInput ? `原始输入：${item.dataset.referenceInput}` : ''; };
  showOriginal();
  const fill = (reference: PaperReference) => { title.value = reference.title; doi.value = reference.doi ?? ''; url.value = reference.url ?? ''; editedFields.add('seedPapers'); };
  item.addEventListener('input', () => { version++; });
  kind.addEventListener('change', () => { version++; });
  title.addEventListener('input', () => {
    if (kind.value !== 'paper') return;
    const raw = title.value; const parsed = parsePaperReference(raw);
    doi.value = parsed.doi ?? ''; url.value = parsed.url ?? '';
    item.dataset.referenceInput = raw.trim(); showOriginal(); results.replaceChildren(); message.textContent = '';
  });
  const resolve = async () => {
    if (kind.value !== 'paper' || !title.value.trim()) return;
    const input = title.value.trim(); if (pending === input) return;
    // Preserve existing manually supplied identifiers unless the main input changed.
    if (!item.dataset.referenceInput) { item.dataset.referenceInput = input; showOriginal(); }
    const parsed = parsePaperReference(input);
    if (parsed.doi || parsed.url) { doi.value = parsed.doi ?? ''; url.value = parsed.url ?? ''; }
    const requestVersion = ++version; pending = input; button.disabled = true;
    message.textContent = '正在识别论文…'; results.replaceChildren();
    const current = () => item.isConnected && kind.value === 'paper' && version === requestVersion && $<HTMLDialogElement>('#input-editor').open;
    try {
      const response = await fetch(`/api/paper-reference?${new URLSearchParams({ input })}`, { headers: { 'X-Research-Inputs': '1' }, signal: AbortSignal.timeout(10000) });
      const data = await response.json(); if (!current()) return;
      if (!response.ok) throw new Error(data.error ?? '检索暂时不可用。');
      const candidates: (PaperReference & { authors?: string; year?: number })[] = data.candidates ?? [];
      if (data.exact && candidates.length === 1) { fill(candidates[0]); message.textContent = '已通过 DOI 补全论文信息。'; }
      else if (candidates.length) {
        message.textContent = '请选择对应论文；未确认前保留你的原始输入。';
        for (const candidate of candidates) {
          const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'reference-candidate';
          choice.textContent = [candidate.title, candidate.authors, candidate.year, candidate.doi].filter(Boolean).join(' · ');
          choice.addEventListener('click', () => { if (!current()) return; fill(candidate); results.replaceChildren(); message.textContent = '已使用所选论文。'; });
          results.append(choice);
        }
      } else message.textContent = '未找到可确认的论文，原始输入已保留。可直接保存，或展开详情手动补充。';
    } catch (error) {
      if (current()) message.textContent = error instanceof Error && error.name !== 'TimeoutError' ? error.message : '检索超时，原始输入已保留，可直接保存或手动补充。';
    } finally { if (pending === input) { pending = ''; button.disabled = false; } }
  };
  title.addEventListener('change', () => { void resolve(); });
  button.addEventListener('click', () => { void resolve(); });
}

function addSeed(seed?: ResearchSeed) {
  if ($('#seed-list').children.length >= 50) { $('#input-error').textContent = '最多添加 50 条论文种子。'; $('#input-error').hidden = false; return; }
  const item = document.createElement('fieldset'); item.className = 'seed-editor'; item.dataset.seedId = seed?.id ?? crypto.randomUUID();
  const kind: SeedKind = seed ? seed.kind ?? 'paper' : 'direction';
  item.innerHTML = `<legend></legend><div class="seed-order-controls" data-seed-order role="group" tabindex="0" aria-label="调整种子优先级" aria-describedby="seed-order-help" aria-keyshortcuts="ArrowUp ArrowDown Home End"><button type="button" data-seed-move="up">↑ 上移</button><button type="button" data-seed-move="down">↓ 下移</button><button type="button" data-seed-move="first">置顶</button><button type="button" data-seed-move="last">置底</button></div><button type="button" class="text-button remove-seed" data-remove-seed aria-label="移除此种子">移除</button>
    <label class="form-field">种子类型<select name="seedKind">${(['direction', 'engineering_problem', 'paper'] as SeedKind[]).map(value => `<option value="${value}" ${value === kind ? 'selected' : ''}>${seedKinds[value].label}</option>`).join('')}</select></label>
    <label class="form-field"><span class="field-label" data-seed-title-label></span><input name="seedTitle" required maxlength="500" value="${escape(seed?.title)}"></label>
    <div data-reference-lookup><button type="button" class="text-button" data-resolve-reference>识别论文</button><p class="editor-note" data-reference-status role="status"></p><div data-reference-results></div></div>
    <details data-reference-details><summary>论文详情 / 手动补充</summary><p class="editor-note" data-reference-original></p><div class="reference-fields"><label class="form-field" data-seed-doi-field>DOI <span>可选</span><input name="seedDoi" maxlength="2048" value="${escape(seed?.doi)}" placeholder="10.… 或 https://doi.org/…"></label><label class="form-field"><span class="field-label" data-seed-url-label></span> <span>可选</span><input name="seedUrl" type="url" maxlength="2048" value="${escape(seed?.url)}"></label></div></details>
    <label class="form-field"><span class="field-label" data-seed-notes-label></span> <span>可选</span><textarea name="seedNotes" rows="3" maxlength="2000">${escape(seed?.notes)}</textarea></label>`;
  bindPaperReference(item, seed);
  updateSeedFields(item);
  $('#seed-list').append(item); $('#no-seeds').hidden = true;
  updateSeedLabels();
  if (!seed) item.querySelector<HTMLSelectElement>('select')!.focus();
  return item.dataset.seedId;
}
function syncVenueChoice() {
  const name = $<HTMLInputElement>('#journal-name').value.trim(); const url = $<HTMLInputElement>('#journal-url').value.trim();
  const match = venues?.venues.find(venue => venue.name === name && venue.url === url);
  $<HTMLSelectElement>('#venue-select').value = match?.id ?? (name || url || $<HTMLTextAreaElement>('#journal-notes').value.trim() ? 'custom' : '');
  const link = $<HTMLAnchorElement>('#venue-link');
  let safe = false; try { safe = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* Invalid draft URL. */ }
  link.hidden = !safe; if (safe) link.href = url; else link.removeAttribute('href');
  link.textContent = match ? `打开 ${match.shortName} 官网` : '打开填写的链接';
}
function renderVenueOptions() {
  $<HTMLSelectElement>('#venue-select').innerHTML = '<option value="">尚未确定</option><option value="custom">自定义会议 / 期刊</option>' + (venues ? (['conference', 'journal'] as const).map(kind => `<optgroup label="${kind === 'conference' ? '会议' : '期刊'}">${venues!.venues.filter(venue => venue.kind === kind).map(venue => `<option value="${escape(venue.id)}" title="${escape(venue.name)}">${escape(venue.shortName)}</option>`).join('')}</optgroup>`).join('') : '');
  syncVenueChoice();
}
async function loadVenues() {
  if (venues || loadingVenues) return;
  loadingVenues = true; $('#retry-venues').hidden = true; $('#venue-catalog-status').textContent = '正在加载常用会议 / 期刊…';
  try {
    const response = await fetch('/api/venues', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Catalog unavailable');
    const data = await response.json() as VenueCatalog;
    if (data.version !== 1 || !Array.isArray(data.venues)) throw new Error('Invalid catalog');
    venues = data; renderVenueOptions();
    $('#venue-catalog-status').textContent = `已收录 ${venues.venues.length} 个常用会议/期刊，选择后自动填写名称和官网。会议年份、征稿与投稿要求以官网为准。`;
  } catch {
    $('#venue-catalog-status').textContent = '常用列表暂时无法加载，仍可填写自定义会议/期刊。'; $('#retry-venues').hidden = false;
  } finally { loadingVenues = false; }
}
function chooseVenue() {
  const id = $<HTMLSelectElement>('#venue-select').value;
  if (id === 'custom') { $('#journal-name').focus(); return; }
  const venue = venues?.venues.find(venue => venue.id === id);
  if (id && !venue) return;
  $<HTMLInputElement>('#journal-name').value = venue?.name ?? '';
  $<HTMLInputElement>('#journal-url').value = venue?.url ?? '';
  if (!id) $<HTMLTextAreaElement>('#journal-notes').value = '';
  syncVenueChoice();
}
function openInputs(section: string) {
  if (!snapshot) return;
  $('#seed-order-status').textContent = '';
  editingRevision = snapshot.researchInputs.revision;
  editingBase = structuredClone({ paperType: snapshot.paperTypePreference, seedPapers: snapshot.researchInputs.seedPapers, targetJournal: snapshot.researchInputs.targetJournal }); editedFields.clear();
  editingRecord = snapshot.workspace?.record ?? '';
  $<HTMLSelectElement>('#paper-type').innerHTML = '<option value="">暂不选择 · 自动判断</option>' + snapshot.paperTypes.map(profile => `<option value="${profile.type}">${escape(profile.label)}</option>`).join('');
  $<HTMLSelectElement>('#paper-type').value = snapshot.paperTypePreference ?? '';
  updatePaperType();
  $('#seed-list').replaceChildren(); $('#input-error').hidden = true; $('#no-seeds').hidden = false;
  for (const seed of snapshot.researchInputs.seedPapers) addSeed(seed);
  $<HTMLInputElement>('#journal-name').value = snapshot.researchInputs.targetJournal?.name ?? '';
  $<HTMLInputElement>('#journal-url').value = snapshot.researchInputs.targetJournal?.url ?? '';
  $<HTMLTextAreaElement>('#journal-notes').value = snapshot.researchInputs.targetJournal?.notes ?? '';
  $<HTMLDetailsElement>('#journal-supplement').open = false;
  renderVenueOptions(); void loadVenues();
  $('#input-context').textContent = `项目研究输入 · 版本 ${editingRevision}。论文信息与正式投稿要求仍需通过来源核验。`;
  $<HTMLDialogElement>('#input-editor').showModal();
  if (section === 'paper-type') $('#paper-type').focus();
  else if (section === 'journal') $('#venue-select').focus();
  else if (!snapshot.researchInputs.seedPapers.length) addSeed();
  else $('#seed-list [data-seed-order]').focus();
}
async function saveInputs(event: SubmitEvent) {
  event.preventDefault(); if (savingInputs) return;
  const optional = (value: string) => value.trim() || undefined;
  const seedPapers = Array.from(document.querySelectorAll<HTMLFieldSetElement>('.seed-editor')).map(item => {
    const value = (name: string) => item.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!.value.trim();
    const kind = value('seedKind') as SeedKind;
    return { id: item.dataset.seedId!, kind, title: value('seedTitle').slice(0, 500), referenceInput: kind === 'paper' ? optional(item.dataset.referenceInput ?? '') : undefined, doi: kind === 'paper' ? optional(value('seedDoi')) : undefined, url: optional(value('seedUrl')), notes: optional(value('seedNotes')) };
  });
  const name = $<HTMLInputElement>('#journal-name').value.trim(); const url = optional($<HTMLInputElement>('#journal-url').value); const notes = optional($<HTMLTextAreaElement>('#journal-notes').value);
  $('#input-error').hidden = true;
  if (!name && (url || notes)) { $('#input-error').textContent = '请填写会议/期刊名称；如需清除目标，请选择“尚未确定”。'; $('#input-error').hidden = false; $('#journal-name').focus(); return; }
  savingInputs = true; $<HTMLButtonElement>('#save-inputs').disabled = true; $('#save-inputs').textContent = '正在保存…';
  try {
    const paperType = $<HTMLSelectElement>('#paper-type').value || null;
    const response = await fetch('/api/research-inputs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Research-Inputs': '1', 'X-Research-Workspace': encodeURIComponent(editingRecord) }, body: JSON.stringify({ expectedRevision: editingRevision, inputs: { paperType, seedPapers, targetJournal: name ? { name, url, notes } : null }, edit: { fields: [...editedFields], base: editingBase } }), signal: AbortSignal.timeout(15000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '保存失败，请重试。');
    $<HTMLDialogElement>('#input-editor').close(); await refresh();
  } catch (error) { $('#input-error').textContent = error instanceof Error ? error.message : '保存失败，请重试。'; $('#input-error').hidden = false; }
  finally { savingInputs = false; $<HTMLButtonElement>('#save-inputs').disabled = false; $('#save-inputs').textContent = '保存研究输入'; }
}

function taskCard(t: DashboardTask) {
  return `<button class="task-card" data-task="${escape(t.id)}" data-focus="task-${escape(t.id)}" aria-label="查看任务：${escape(t.prompt)}"><div class="card-top"><span>${escape(labels[t.stage] ?? t.stage)}</span><span>${t.attempts ? `第 ${t.attempts} 次执行` : '尚未派发'}</span></div><h3 class="task-title">${escape(t.nodeLabel ?? t.prompt)}</h3><div class="card-statuses">${status(t.execution, `执行：${labels[t.execution] ?? t.execution}`)}${status(t.acceptance, `验收：${t.acceptance === 'pending' ? '待检查' : labels[t.acceptance] ?? t.acceptance}`)}</div><p class="card-phase">${phaseLabels[t.progress.phase]}</p>${t.reasons[0] || t.progress.waitReasons[0] ? `<p class="card-reason">${escape(t.reasons[0] || t.progress.waitReasons[0])}</p>` : ''}<div class="card-footer"><span>${escape(t.session)}</span><span ${t.attempts ? `data-task-time="${escape(t.id)}"` : ''}>${t.attempts ? duration(t.elapsedSeconds) : t.dependencies.length ? `${t.dependencies.length} 项上游依赖` : '可独立执行'}</span></div></button>`;
}
function eventRow(e: DashboardSnapshot['events'][number]) {
  return `<div class="event-line"><time datetime="${escape(e.time)}" title="${escape(new Date(e.time).toLocaleString('zh-CN'))}">${time(e.time)}</time><div>${escape(eventLabels[e.type] ?? e.type)}${e.summary ? `<div class="event-summary">${escape(e.summary)}</div>` : ''}</div><span>${e.task ? taskButton(e.task) : `<span class="event-summary">项目</span>`}</span></div>`;
}
function challengeCard(c: DashboardSnapshot['challenges'][number]) {
  return `<article class="challenge"><div class="challenge-meta"><strong>${escape(c.id)}</strong>${status(c.severity === 'minor' ? 'pending' : 'blocked', labels[c.severity] ?? c.severity)}${status(c.status)}<span>${escape(c.claimId)}</span></div><p>${escape(c.reason)}</p>${c.response ? `<p class="event-summary">回应：${escape(c.response)}</p>` : ''}${c.taskId ? taskButton(c.taskId) : ''}</article>`;
}
function renderBoard(s: DashboardSnapshot) {
  const tasks = s.tasks.filter(t => (!stage || t.stage === stage) && matches([t, labels[t.stage], labels[t.execution], labels[t.acceptance]]));
  if (!s.tasks.length) return empty('尚未登记研究任务', s.mode === 'automatic' ? '配置模型与研究输入后，点击“一键启动”创建工作流。' : '使用 runtime 的 task 命令创建任务；看板会自动读取新的记录。');
  if (!tasks.length) return empty('没有匹配的任务', '尝试其他搜索词，或清除阶段筛选。');
  const challenges = s.challenges.filter(c => c.status !== 'resolved' && c.status !== 'limitation' && taskMatchesStage(c.taskId) && matches(c));
  const events = s.events.filter(e => taskMatchesStage(e.task) && matches([e, eventLabels[e.type]])).slice(0, 5);
  return `<section class="board" aria-label="任务状态看板">${(['queued', 'active', 'attention', 'done'] as Lane[]).map(lane => `<section class="lane ${lane}" aria-label="${laneLabels[lane]}"><div class="lane-header"><span class="lane-dot" aria-hidden="true"></span><h2>${laneLabels[lane]}</h2><span class="lane-count">${tasks.filter(t => t.lane === lane).length}</span></div>${tasks.filter(t => t.lane === lane).map(taskCard).join('') || '<div class="empty-lane">当前没有此状态的任务</div>'}</section>`).join('')}</section>
  <div class="lower-panels"><section class="panel"><div class="panel-heading"><h2>最近活动</h2><button class="text-button" data-view="events">查看全部事件</button></div>${events.map(eventRow).join('') || '<p class="event-summary">暂无匹配事件</p>'}</section><section class="panel"><div class="panel-heading"><h2>待解决的质疑 <span class="lane-count">${challenges.length}</span></h2><button class="text-button" data-view="evidence">查看证据</button></div>${challenges.slice(0, 3).map(challengeCard).join('') || '<p class="event-summary">当前没有未解决的质疑。科学结论仍以独立审查为准。</p>'}</section></div>`;
}
function renderEvidence(s: DashboardSnapshot) {
  const claims = s.claims.filter(c => taskMatchesStage(c.taskId) && matches(c));
  const sourceIds = new Set(claims.flatMap(c => c.evidence.map(r => r.sourceId)));
  const sources = s.sources.filter(src => (sourceIds.has(src.id) || (!stage && matches(src))));
  const challenges = s.challenges.filter(c => taskMatchesStage(c.taskId) && matches(c));
  return `<div class="evidence-layout"><section class="panel"><div class="panel-heading"><h2>论点与证据 <span class="lane-count">${claims.length}</span></h2></div>${claims.map(c => `<article class="claim-row"><div class="challenge-meta"><strong>${escape(c.id)}</strong>${taskButton(c.taskId)}</div><h3>${escape(c.text)}</h3>${c.evidence.map(ref => { const src = s.sources.find(source => source.id === ref.sourceId); return `<div class="evidence-ref">${ref.passage ? `<blockquote>${escape(ref.passage)}</blockquote>` : ''}${src ? artifactButton(src.path, src.title || src.id) : escape(ref.sourceId)}<div class="event-summary">${escape([ref.page ? `第 ${ref.page} 页` : '', ref.location].filter(Boolean).join(' · '))}</div></div>`; }).join('')}</article>`).join('') || '<p class="event-summary">尚无匹配的论点。模型登记论点和证据后会显示在此处。</p>'}</section><div><section class="panel"><div class="panel-heading"><h2>质疑记录 <span class="lane-count">${challenges.length}</span></h2></div>${challenges.map(challengeCard).join('') || '<p class="event-summary">暂无匹配的质疑记录</p>'}</section><section class="panel stacked-panel"><div class="panel-heading"><h2>来源快照 <span class="lane-count">${sources.length}</span></h2></div>${sources.map(src => `<div class="source-row">${artifactButton(src.path, src.title || src.id)}<p>${escape(src.identity)}</p><p>版本 ${escape(src.version)} · 检索于 ${escape(new Date(src.retrievedAt).toLocaleString('zh-CN'))}</p></div>`).join('') || '<p class="event-summary">尚无匹配的来源快照</p>'}</section></div></div>`;
}

function resetTrace() {
  traceEpoch++; traceBusy = false; traceSeen = -1; traceError = ''; tracePage = undefined;
  traceEntries.clear(); traceDetails.clear(); traceOpen.clear(); tracePending.clear(); traceDetailErrors.clear();
}
function traceDetailHtml(seq: number): string {
  const detail = traceDetails.get(seq);
  if (!detail) return traceDetailErrors.has(seq) ? `<p class="trace-error" role="alert">${escape(traceDetailErrors.get(seq))} <button class="text-button" data-retry-trace="${seq}">重试读取</button></p>` : '<p class="editor-note">正在读取此步骤的记录…</p>';
  return detail.notes.map(note => `<p class="editor-note">${escape(note)}</p>`).join('') + detail.sections.map(section => `<section class="trace-section"><h3>${escape(section.title)}</h3><pre>${escape(section.text)}</pre>${section.truncated ? '<p class="editor-note">内容较长，已截取预览；完整记录保存在本地项目文件中。</p>' : ''}</section>`).join('');
}
function renderTrace() {
  if (!snapshot || view !== 'trace') return;
  const tasks = snapshot.tasks.filter(t => !stage || t.stage === stage);
  if ((traceTask && !tasks.some(t => t.id === traceTask)) || (stage && !traceTask)) { traceTask = tasks[0]?.id ?? ''; traceAttempt = ''; resetTrace(); }
  if (!$('#trace-root')) $('#view').innerHTML = '<section id="trace-root" class="panel trace-panel"><div id="trace-controls"></div><div id="trace-info" role="status"></div><div id="trace-list"></div><div id="trace-pagination"></div></section>';
  const attempts = Math.max(0, ...tasks.filter(t => !traceTask || t.id === traceTask).map(t => t.attempts));
  replaceHtml('#trace-controls', `<div class="panel-heading"><h2>执行 Trace</h2>${traceTask ? `<button class="text-button" data-task="${escape(traceTask)}">查看任务详情</button>` : ''}</div><div class="trace-controls"><label>任务<select id="trace-task">${!stage ? '<option value="">全部任务与项目事件</option>' : ''}${tasks.map(t => `<option value="${escape(t.id)}" ${traceTask === t.id ? 'selected' : ''}>${escape(labels[t.stage])} · ${escape(t.id)}</option>`).join('')}</select></label><label>步骤类型<select id="trace-category"><option value="">全部步骤</option>${Object.entries(traceCategories).map(([key, text]) => `<option value="${key}" ${traceCategory === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label><label>执行次数<select id="trace-attempt"><option value="">全部执行</option>${Array.from({ length: attempts }, (_, i) => `<option value="${i + 1}" ${traceAttempt === String(i + 1) ? 'selected' : ''}>第 ${i + 1} 次执行</option>`).join('')}</select></label></div>`);
  const entries = [...traceEntries.values()].sort((a, b) => a.seq - b.seq).filter(e => matches([e, eventLabels[e.type], traceCategories[e.category]]));
  $('#trace-info').innerHTML = `<p class="editor-note">按时间从早到晚排列 · 已加载 ${traceEntries.size} / ${tracePage?.total ?? '—'} 条${query ? ` · 当前搜索命中 ${entries.length} 条` : ''} · 点击步骤查看输入、输出或校验记录。</p>${traceError ? `<p class="trace-error" role="alert">${escape(traceError)} <button class="text-button" data-refresh-trace>重新读取</button></p>` : ''}`;
  const stateLabels: Record<TraceEntry['status'], string> = { info: '已记录', started: '开始', completed: '完成', failed: '失败', blocked: '阻塞', uncertain: '结果待确认' };
  const tones: Record<TraceEntry['status'], string> = { info: 'pending', started: 'running', completed: 'completed', failed: 'failed', blocked: 'blocked', uncertain: 'interrupted' };
  const html = entries.map(entry => `<details class="trace-step ${entry.status}" data-trace-seq="${entry.seq}" ${traceOpen.has(entry.seq) ? 'open' : ''}><summary><div class="trace-time"><span>#${entry.seq}</span><time datetime="${escape(entry.time)}" title="${escape(new Date(entry.time).toLocaleString('zh-CN'))}">${time(entry.time)}</time></div><div class="trace-step-content"><div class="trace-title"><span class="trace-kind">${traceCategories[entry.category]}</span><strong>${escape(eventLabels[entry.type] ?? entry.type)}</strong>${status(tones[entry.status], stateLabels[entry.status])}</div><p class="trace-meta">${escape(entry.task ?? '项目 / 未归属任务')}${entry.attempt ? ` · 第 ${entry.attempt} 次执行` : ''}${entry.model ? ` · ${escape(entry.model)}${entry.phase === 'reviewer' ? '（审查）' : ''}` : ''}${entry.durationMs !== undefined ? ` · ${(entry.durationMs / 1000).toFixed(2)} 秒` : ''}${entry.tokens ? ` · 输入 ${number(entry.tokens.input)} / 输出 ${number(entry.tokens.output)} tokens` : ''}</p>${entry.summary ? `<p class="trace-summary">${escape(entry.summary)}</p>` : ''}</div></summary><div class="trace-body">${traceOpen.has(entry.seq) ? traceDetailHtml(entry.seq) : ''}</div></details>`).join('');
  replaceHtml('#trace-list', html || empty(traceBusy ? '正在读取 Trace' : '尚无匹配的步骤', traceBusy ? '正在读取持久化执行记录。' : '任务执行后会自动显示。可调整任务、步骤类型或搜索条件。'));
  replaceHtml('#trace-pagination', `<button class="quiet-button" data-older-trace ${traceBusy || !tracePage?.nextBefore ? 'disabled' : ''}>${traceBusy ? '正在读取…' : tracePage?.nextBefore ? '加载更早的步骤' : '已到最早记录'}</button><span class="editor-note">最新步骤随看板自动刷新</span>`);
}
async function loadTrace(older = false) {
  if (!snapshot || view !== 'trace' || traceBusy || (older && !tracePage?.nextBefore)) return;
  const epoch = traceEpoch; traceBusy = true; traceError = ''; renderTrace();
  const params = new URLSearchParams();
  if (traceTask) params.set('task', traceTask); if (traceCategory) params.set('category', traceCategory); if (traceAttempt) params.set('attempt', traceAttempt);
  if (older) params.set('before', String(tracePage!.nextBefore));
  try {
    const response = await fetch('/api/trace?' + params, { signal: AbortSignal.timeout(10000) }); const data = await response.json();
    if (epoch !== traceEpoch) return;
    if (!response.ok) throw new Error(data.error ?? '无法读取 Trace');
    const page = data as TracePage;
    const disconnected = !older && traceEntries.size > 0 && page.entries.length > 0 && !page.entries.some(entry => traceEntries.has(entry.seq));
    if (disconnected) { traceEntries.clear(); traceDetails.clear(); traceOpen.clear(); }
    const nextBefore = !older && tracePage && !disconnected ? tracePage.nextBefore : page.nextBefore;
    const updated = traceSeen !== page.latestSeq;
    for (const entry of page.entries) traceEntries.set(entry.seq, entry);
    tracePage = { ...page, nextBefore }; traceSeen = page.latestSeq;
    if (updated) for (const seq of traceOpen) if (traceEntries.get(seq)?.type.endsWith('_started')) { traceDetails.delete(seq); void loadTraceDetail(seq); }
  } catch (error) { if (epoch === traceEpoch) traceError = error instanceof Error ? error.message : '无法读取 Trace'; }
  finally { if (epoch === traceEpoch) { traceBusy = false; renderTrace(); } }
}
async function loadTraceDetail(seq: number) {
  if (tracePending.has(seq) || traceDetails.has(seq)) return;
  const epoch = traceEpoch; const seen = traceSeen; tracePending.add(seq); traceDetailErrors.delete(seq);
  try {
    const response = await fetch(`/api/trace/event?seq=${seq}${traceTask ? `&task=${encodeURIComponent(traceTask)}` : ''}`, { signal: AbortSignal.timeout(10000) }); const data = await response.json();
    if (epoch !== traceEpoch) return;
    if (!response.ok) throw new Error(data.error ?? '无法读取此步骤');
    if (seen === traceSeen || !traceEntries.get(seq)?.type.endsWith('_started')) traceDetails.set(seq, data);
  } catch (error) { if (epoch === traceEpoch) traceDetailErrors.set(seq, error instanceof Error ? error.message : '无法读取此步骤'); }
  finally { if (epoch === traceEpoch) { tracePending.delete(seq); renderTrace(); if (seen !== traceSeen && traceOpen.has(seq) && !traceDetails.has(seq) && !traceDetailErrors.has(seq)) void loadTraceDetail(seq); } }
}
function openTrace(task: string, attempt = '', role = '') {
  traceTask = task; traceAttempt = attempt; traceCategory = role === 'reviewer' ? 'review' : ''; stage = ''; view = 'trace'; resetTrace();
  query = ''; $<HTMLInputElement>('#search').value = ''; history.replaceState(null, '', '#trace');
  $<HTMLDialogElement>('#details').close(); render();
}
function renderEmptyWorkspace() {
  $('#project-header').hidden = true;
  replaceHtml('#research-inputs', `<div class="direction-overview paper-type-overview"><div class="direction-summary"><h2>论文类型</h2><p class="direction-name">暂不选择 · 自动判断</p><p class="input-empty">打开或创建项目后，可选择论文类型，也可以保持自动判断。</p></div></div><div class="seed-overview"><div class="input-heading"><h2>论文种子</h2></div><p class="input-empty">尚未添加。研究方向、工程问题和参考论文都可以作为起点。</p></div><div class="journal-overview"><div class="input-heading"><h2>目标会议 / 期刊</h2></div><p class="journal-name">尚未确定</p><p class="input-empty">打开或创建项目后，可从列表选择。</p></div>`);
  $('#run-controls').hidden = false;
  $('#run-reason').textContent = '先打开或创建项目，再开始研究。';
  for (const id of ['start-run', 'pause-run', 'resume-run', 'terminate-run']) $<HTMLButtonElement>('#' + id).disabled = true;
  $('#start-run').hidden = false; $('#resume-run').hidden = true;
  $('#run-result').hidden = true;
  replaceHtml('#workflow-live', '<div class="workflow-summary"><div class="workflow-title"><h2>Workflow</h2><p>尚未开始研究，启动后在这里查看实时进度。</p></div></div>');
  replaceHtml('#stages', '');
  $('#clear-stage').hidden = true;
  const titles: Record<string, string> = { board: '暂无研究任务', agents: '暂无 Subagent 调用', trace: '暂无执行 Trace', evidence: '暂无证据与质疑', events: '暂无事件记录' };
  replaceHtml('#view', empty(titles[view] ?? titles.board, '打开已有项目可恢复进度或初始化文件夹，创建项目可开始新的研究。'));
  $('#last-updated').textContent = '尚未打开项目';
}
function render() {
  document.querySelectorAll<HTMLButtonElement>('.view-tabs [data-view]').forEach(button => { button.classList.toggle('selected', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (!snapshot) { if (emptyWorkspace) renderEmptyWorkspace(); return; }
  const focus = (document.activeElement as HTMLElement)?.dataset.focus;
  renderHeader(snapshot);
  document.querySelectorAll<HTMLButtonElement>('.view-tabs [data-view]').forEach(button => { button.classList.toggle('selected', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#clear-stage').hidden = !stage;
  $<HTMLInputElement>('#search').placeholder = view === 'trace' ? '搜索已加载的 Trace' : '搜索任务、证据、事件';
  if (view === 'board') $('#view').innerHTML = renderBoard(snapshot);
  else if (view === 'agents') $('#view').innerHTML = renderAgents(snapshot);
  else if (view === 'trace') { renderTrace(); if (traceSeen !== snapshot.totalEvents && !traceBusy && !traceError) void loadTrace(); }
  else if (view === 'evidence') $('#view').innerHTML = renderEvidence(snapshot);
  else {
    const events = snapshot.events.filter(e => taskMatchesStage(e.task) && matches([e, eventLabels[e.type]]));
    $('#view').innerHTML = `<section class="panel events-panel"><div class="panel-heading"><h2>事件日志</h2><span class="event-summary">最近 ${snapshot.events.length} 条 / 共 ${number(snapshot.totalEvents)} 条</span></div>${events.map(eventRow).join('') || empty('没有匹配的事件', '调整搜索或阶段筛选。')}</section>`;
  }
  if (focus) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  if ($<HTMLDialogElement>('#details').open && selectedTaskId) showTask(selectedTaskId);
  updateClock(snapshot);
}
function showTask(id: string) {
  const task = snapshot?.tasks.find(t => t.id === id); if (!task) return;
  selectedTaskId = id;
  $('#detail-title').textContent = `${task.nodeLabel ?? labels[task.stage] ?? task.stage} · ${task.id}`;
  const challenges = snapshot!.challenges.filter(c => c.taskId === task.id || task.claimIds.includes(c.claimId));
  $('#detail-content').innerHTML = `<p>${escape(task.prompt)}</p><div class="card-statuses">${status(task.execution)}${status(task.acceptance, task.acceptance === 'pending' ? '等待验收' : undefined)}<button class="text-button" data-trace-task="${escape(task.id)}">查看执行 Trace</button></div><dl class="detail-grid"><div><dt>会话</dt><dd>${escape(task.session)}</dd></div><div><dt>执行次数</dt><dd>${task.attempts}</dd></div><div><dt>本次论文类型</dt><dd>${escape(snapshot!.paperTypes.find(profile => profile.type === task.paperType)?.label ?? '待选题后判断')}</dd></div><div><dt>研究输入版本</dt><dd>${task.attempts ? task.inputRevision : '派发时确定'} / 当前 ${snapshot!.researchInputs.revision}</dd></div><div><dt>累计运行</dt><dd><span data-task-time="${escape(task.id)}">${duration(task.elapsedSeconds)}</span></dd></div><div><dt>预计用时</dt><dd>${duration(task.expectedSeconds)}</dd></div><div><dt>工作进程</dt><dd>${task.workerAlive ? '运行中' : '未运行'}</dd></div><div><dt>执行产物完成</dt><dd>${task.executionCompletedAt ? escape(new Date(task.executionCompletedAt).toLocaleString('zh-CN')) : '尚未完成检查'}</dd></div></dl>
  <h3>当前进度</h3><p>${phaseLabels[task.progress.phase]}${task.progress.detail ? ` · ${escape(task.progress.detail)}` : ''}</p>${task.progress.waitReasons.length ? `<ul class="detail-list">${task.progress.waitReasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul>` : ''}
  ${task.reasons.length ? `<h3>当前阻塞</h3><ul class="detail-list">${task.reasons.map(r => `<li>${escape(r)}</li>`).join('')}</ul>` : ''}
  <h3>上游依赖</h3><div class="detail-files">${task.dependencies.map(taskButton).join('') || '<span class="event-summary">无上游依赖</span>'}</div>
  <h3>产物</h3><div class="detail-files">${task.outputs.map(p => artifactButton(p)).join('') || '<span class="event-summary">无声明产物</span>'}</div>
  ${task.inputs.length ? `<h3>输入</h3><div class="detail-files">${task.inputs.map(p => artifactButton(p)).join('')}</div>` : ''}
  <h3>独立审查</h3>${task.review ? `<div class="review-summary">${status(task.review.verdict)}<p>${escape(task.review.summary)}</p><p class="event-summary">${escape(task.review.model)} · ${escape(task.review.family)} · ${time(task.review.time)}</p>${task.review.limitations.length ? `<ul class="detail-list">${task.review.limitations.map(l => `<li>${escape(l)}</li>`).join('')}</ul>` : ''}</div>` : '<p class="event-summary">尚无独立审查结果。执行成功不会自动视为科学验收通过。</p>'}
  ${task.checks.length ? `<h3>确定性校验</h3><div class="detail-files">${task.checks.map(check => `<div>${status(check.passed ? 'PASS' : 'FAIL')} ${artifactButton(check.report, check.name)}</div>`).join('')}</div>` : ''}
  ${challenges.length ? `<h3>关联质疑</h3>${challenges.map(challengeCard).join('')}` : ''}`;
  if (!$<HTMLDialogElement>('#details').open) $<HTMLDialogElement>('#details').showModal();
}
async function showArtifact(name: string) {
  const version = ++previewRequest;
  $('#artifact-title').textContent = name;
  $('#artifact-content').textContent = ''; $('#artifact-note').textContent = '正在读取产物…';
  if (!$<HTMLDialogElement>('#artifact').open) $<HTMLDialogElement>('#artifact').showModal();
  try {
    const response = await fetch(`/api/artifact?path=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10000) }); const result = await response.json();
    if (version !== previewRequest) return;
    if (!response.ok) throw new Error(result.error ?? '无法读取产物');
    $('#artifact-content').textContent = result.content;
    $('#artifact-note').textContent = result.truncated ? '文件较大，仅预览前 256 KiB。' : '原始文本预览 · 不执行文件内容';
  } catch (error) { if (version === previewRequest) $('#artifact-note').textContent = error instanceof Error ? error.message : '无法读取产物'; }
}
let emptyWorkspace = false;
function applySnapshot(data: DashboardSnapshot | { workspace: { record: string; needsSetup: true } }) {
  if (!('tasks' in data)) {
    if (snapshot) { snapshot = undefined; lastSnapshotVersion = ''; resetTrace(); for (const dialog of document.querySelectorAll<HTMLDialogElement>('#details, #artifact, #input-editor')) dialog.close(); }
    projectAvailable = false; emptyWorkspace = true; $('#error-banner').hidden = true;
    $('#connection').className = 'connection'; workspacePending(data.workspace.record); render(); return;
  }
  if (snapshot?.workspace && data.workspace && snapshot.workspace.record !== data.workspace.record) { location.reload(); return; }
  emptyWorkspace = false; updateInitialization(data.initialization);
  if (snapshot && data.updatedAt < snapshot.updatedAt) return;
  const version = shape(data); const changed = version !== lastSnapshotVersion;
  if (data.workspace && (!snapshot || snapshot.goal !== data.goal || snapshot.tasks.some(t => t.attempts > 0) !== data.tasks.some(t => t.attempts > 0))) void initWorkspace();
  snapshot = data; lastSnapshotVersion = version; projectAvailable = true; $('#error-banner').hidden = true;
  if (traceSeen > data.totalEvents) resetTrace();
  $('#connection').className = 'connection online'; $('#connection').textContent = streamLive ? '实时推送' : '轮询同步';
  if (changed) render(); else { updateClock(data); renderRunControl(data); }
  if (view === 'trace' && !traceBusy && traceSeen !== data.totalEvents) void loadTrace();
}
function showUnavailable(message: string) {
  projectAvailable = false; if (snapshot) renderRunControl(snapshot);
  $('#error-banner').textContent = `${message}${snapshot ? ' 当前保留最后一次成功读取的数据。' : ''}`; $('#error-banner').hidden = false;
  $('#connection').className = 'connection offline'; $('#connection').textContent = '连接中断';
  if (!snapshot) $('#project-header').innerHTML = empty('等待项目连接', '确认看板进程与 project.json 路径；文件恢复后会自动重连。');
}
async function refresh() {
  if (busy) return; busy = true; $<HTMLButtonElement>('#refresh').disabled = true;
  try {
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(8000) }); const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '读取项目记录失败');
    applySnapshot(data);
  } catch (error) {
    if (!streamLive) showUnavailable(error instanceof Error ? error.message : '连接失败');
  } finally { busy = false; $<HTMLButtonElement>('#refresh').disabled = false; }
}
document.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!button) return;
  if (button.dataset.view) { view = button.dataset.view; history.replaceState(null, '', location.pathname + location.search + (view === 'board' ? '' : `#${view}`)); render(); }
  else if (button.dataset.traceTask) openTrace(button.dataset.traceTask, button.dataset.traceAttempt, button.dataset.traceAgent);
  else if (button.hasAttribute('data-older-trace')) void loadTrace(true);
  else if (button.hasAttribute('data-refresh-trace')) void loadTrace();
  else if (button.dataset.retryTrace) void loadTraceDetail(Number(button.dataset.retryTrace));
  else if (button.dataset.editInputs) openInputs(button.dataset.editInputs);
  else if (button.dataset.seedMove) moveSeed(button.closest<HTMLFieldSetElement>('fieldset')!, button.dataset.seedMove, button);
  else if (button.hasAttribute('data-remove-seed')) { button.closest('fieldset')?.remove(); $('#no-seeds').hidden = $('#seed-list').children.length > 0; updateSeedLabels(); }
  else if (button.dataset.stage) { stage = stage === button.dataset.stage ? '' : button.dataset.stage; render(); }
  else if (button.dataset.task) showTask(button.dataset.task);
  else if (button.dataset.artifact) void showArtifact(button.dataset.artifact);
});
document.addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'agent-filter') { agentFilter = target.value; render(); return; }
  if (!['trace-task', 'trace-category', 'trace-attempt'].includes(target.id)) return;
  if (target.id === 'trace-task') { traceTask = target.value; traceAttempt = ''; }
  if (target.id === 'trace-category') traceCategory = target.value;
  if (target.id === 'trace-attempt') traceAttempt = target.value;
  resetTrace(); render();
});
document.addEventListener('toggle', event => {
  const target = event.target as HTMLDetailsElement;
  if (!target.dataset.traceSeq) return; const seq = Number(target.dataset.traceSeq);
  if (target.open) { traceOpen.add(seq); if (!traceDetails.has(seq)) void loadTraceDetail(seq); }
  else traceOpen.delete(seq);
}, true);
$('#refresh').addEventListener('click', () => { void refresh(); });
$('#start-run').addEventListener('click', () => { void startRun(); });
$('#pause-run').addEventListener('click', () => { void controlRun('pause'); });
$('#resume-run').addEventListener('click', () => { void controlRun('resume'); });
$('#terminate-run').addEventListener('click', () => { void controlRun('terminate'); });
$('#clear-stage').addEventListener('click', () => { stage = ''; render(); });
$('#search').addEventListener('input', event => { query = (event.target as HTMLInputElement).value.trim().toLowerCase(); render(); });
$('#close-details').addEventListener('click', () => $<HTMLDialogElement>('#details').close());
$('#close-artifact').addEventListener('click', () => { previewRequest++; $<HTMLDialogElement>('#artifact').close(); });
$('#add-seed').addEventListener('click', () => addSeed());
$('#seed-list').addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const control = (event.target as HTMLElement).closest<HTMLElement>('[data-seed-move], [data-seed-order]');
  const move = ({ ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' } as Record<string, string>)[event.key];
  if (!control || !move) return;
  event.preventDefault();
  moveSeed(control.closest<HTMLFieldSetElement>('fieldset')!, move, control);
});
$('#paper-type').addEventListener('change', updatePaperType);
$('#venue-select').addEventListener('change', chooseVenue);
$('#retry-venues').addEventListener('click', () => { void loadVenues(); });
for (const id of ['journal-name', 'journal-url', 'journal-notes']) $('#' + id).addEventListener('input', syncVenueChoice);
$('#seed-list').addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.name === 'seedKind') { updateSeedFields(target.closest('fieldset')!); updateSeedLabels(); }
});
$('#close-inputs').addEventListener('click', () => $<HTMLDialogElement>('#input-editor').close());
$('#cancel-inputs').addEventListener('click', () => $<HTMLDialogElement>('#input-editor').close());
for (const eventName of ['input', 'change', 'click']) $('#inputs-form').addEventListener(eventName, event => {
  const target = event.target as HTMLElement;
  if (target.closest('#seed-list, #add-seed')) editedFields.add('seedPapers');
  else if (target.closest('#paper-type')) editedFields.add('paperType');
  else if (target.closest('.journal-editor')) editedFields.add('targetJournal');
});
$('#inputs-form').addEventListener('submit', event => { void saveInputs(event as SubmitEvent); });
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) dialog.addEventListener('click', e => { if (e.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); });
void initWorkspace();
void refresh();
const stream = new EventSource('/api/stream');
stream.addEventListener('snapshot', event => {
  try { const data = JSON.parse((event as MessageEvent).data) as DashboardSnapshot; streamLive = true; applySnapshot(data); }
  catch { streamLive = false; showUnavailable('实时数据格式异常，正在重试。'); }
});
stream.addEventListener('unavailable', () => { streamLive = false; showUnavailable('无法读取项目记录，恢复后会自动同步。'); });
stream.onerror = () => { streamLive = false; $('#connection').className = 'connection offline'; $('#connection').textContent = '正在重连'; if (snapshot) updateClock(snapshot); void refresh(); };
setInterval(() => { if (!document.hidden && !streamLive) void refresh(); }, 2000);
window.addEventListener('hashchange', () => { view = viewFromHash(); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

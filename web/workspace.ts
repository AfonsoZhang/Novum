import type { InitializationView } from './types.js';
interface WorkspaceInfo { record: string; status: 'new' | 'ready' | 'invalid'; error?: string }
interface CreationLocation { directory: string; record: string }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
let current: WorkspaceInfo | undefined; let loading = false; let pendingRecord = ''; let operation: 'open' | 'create' | 'retry' | undefined;
let initialization: InitializationView | undefined; let lastInitHtml = '';
let creationLocation: CreationLocation | undefined;
const showError = (message = '') => { $('#workspace-error').textContent = message; $('#workspace-error').hidden = !message; };
function installForm() {
  if ($('#workspace-settings').childElementCount) return;
  $('#workspace-settings').innerHTML = `<div class="workspace-project-row"><div class="workspace-project-info"><h2>研究项目</h2><p id="workspace-status" class="editor-note" role="status"></p></div>
    <div class="workspace-entry-actions" role="group" aria-label="项目操作"><button id="choose-connect" class="secondary-button" type="button">打开已有项目</button><button id="choose-create" class="secondary-button" type="button">创建项目</button></div></div>
    <p class="editor-note workspace-help">打开已有项目：恢复进度或读取现有资料。创建项目：选择保存位置，再命名新建空文件夹。</p>
    <p id="workspace-action-status" class="editor-note" role="status" hidden></p><p id="workspace-error" class="error-banner" role="alert" hidden></p><section id="project-initialization" aria-label="项目初始化" hidden></section>
    <dialog id="create-project-dialog" class="detail-dialog" aria-labelledby="create-project-heading"><header><h2 id="create-project-heading">创建空项目</h2><button id="cancel-create-close" class="icon-button" type="button" aria-label="取消创建">×</button></header>
    <form id="create-project-form" class="create-project-form"><p class="editor-note">将在以下位置新建独立文件夹，研究内容从空白开始。</p><p id="create-project-parent" class="editor-note"></p>
    <label for="create-project-name">项目名称</label><input id="create-project-name" name="name" required maxlength="100" autocomplete="off" placeholder="输入新项目的文件夹名称">
    <p id="create-project-error" class="error-banner" role="alert" hidden></p><div class="create-project-actions"><button id="cancel-create" class="secondary-button" type="button">取消</button><button id="confirm-create" class="primary-button" type="submit">创建并打开</button></div></form></dialog>`;
  $('#choose-connect').addEventListener('click', () => { void chooseNativeProject('open'); });
  $('#choose-create').addEventListener('click', () => { void chooseNativeProject('create'); });
  $('#project-initialization').addEventListener('click', event => { if ((event.target as HTMLElement).closest('#retry-initialization')) void retryInitialization(); });
  const dialog = $<HTMLDialogElement>('#create-project-dialog');
  for (const id of ['cancel-create', 'cancel-create-close']) $('#' + id).addEventListener('click', () => { if (!operation) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (operation) event.preventDefault(); });
  dialog.addEventListener('close', () => { creationLocation = undefined; });
  $('#create-project-form').addEventListener('submit', event => { event.preventDefault(); void createProject(); });
}
function updateControls() {
  for (const [id, purpose, label] of [['choose-connect', 'open', '打开已有项目'], ['choose-create', 'create', '创建项目']]) {
    const button = $<HTMLButtonElement>('#' + id); button.disabled = !!operation; button.textContent = operation === purpose ? '选择文件夹…' : label;
  }
  const retry = document.querySelector<HTMLButtonElement>('#retry-initialization'); if (retry) retry.disabled = !!operation;
}
async function post<T>(body: unknown, timeout = 15000): Promise<T> {
  const response = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Research-Control': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '操作失败，请重试。'); return data as T;
}
async function chooseNativeProject(purpose: 'open' | 'create') {
  if (operation) return; operation = purpose; updateControls(); showError();
  $('#workspace-action-status').textContent = purpose === 'open' ? '请选择已有代码或研究文件夹；已有进度会恢复，普通文件夹将在后台初始化。' : '请选择保存新项目的父文件夹，下一步填写项目名称。';
  $('#workspace-action-status').hidden = false;
  try {
    const result = await post<WorkspaceInfo | CreationLocation | { cancelled: true }>({ action: purpose === 'open' ? 'open-native' : 'create-native' }, 315000);
    if ('cancelled' in result) $('#workspace-action-status').textContent = '已取消选择。';
    else if ('directory' in result) {
      creationLocation = result; $('#create-project-parent').textContent = result.directory;
      $<HTMLInputElement>('#create-project-name').value = ''; $('#create-project-error').hidden = true;
      $('#workspace-action-status').hidden = true; $<HTMLDialogElement>('#create-project-dialog').showModal();
      $('#create-project-name').focus();
    } else location.reload();
  } catch (error) { $('#workspace-action-status').hidden = true; showError(error instanceof Error ? error.message : '无法打开项目，请重试。'); }
  finally { operation = undefined; updateControls(); }
}
async function createProject() {
  if (operation || !creationLocation) return;
  const name = $<HTMLInputElement>('#create-project-name').value.trim();
  if (!name) { $<HTMLInputElement>('#create-project-name').focus(); return; }
  operation = 'create'; updateControls();
  for (const id of ['confirm-create', 'cancel-create', 'cancel-create-close']) $<HTMLButtonElement>('#' + id).disabled = true;
  $('#confirm-create').textContent = '正在创建…'; $('#create-project-error').hidden = true;
  try {
    await post({ action: 'create-project', ...creationLocation, name }); location.reload();
  } catch (error) {
    $('#create-project-error').textContent = error instanceof Error ? error.message : '无法创建项目，请重试。';
    $('#create-project-error').hidden = false;
  } finally {
    operation = undefined; updateControls();
    for (const id of ['confirm-create', 'cancel-create', 'cancel-create-close']) $<HTMLButtonElement>('#' + id).disabled = false;
    $('#confirm-create').textContent = '创建并打开';
  }
}
async function retryInitialization() {
  if (operation || !current || !initialization?.canRetry) return;
  operation = 'retry'; updateControls(); showError();
  try { const result = await post<{ initialization: InitializationView }>({ action: 'retry-init', record: current.record, runId: initialization.id }); updateInitialization(result.initialization); }
  catch (error) { showError(error instanceof Error ? error.message : '无法重试初始化。'); }
  finally { operation = undefined; updateControls(); }
}
export function updateInitialization(value?: InitializationView) {
  initialization = value; if (!$('#project-initialization')) return;
  const container = $('#project-initialization'); container.hidden = !value;
  if (!value) { container.replaceChildren(); lastInitHtml = ''; return; }
  const names: Record<string, string> = { scan: '扫描文件', read: '读取文档', extract: '提取研究输入', agents: '补充项目说明', save: '保存记录' };
  const statuses: Record<string, string> = { pending: '等待', running: '进行中', completed: '完成', failed: '未完成' };
  const elapsed = Math.floor(value.elapsedSeconds); const elapsedText = elapsed < 60 ? `${value.elapsedSeconds.toFixed(1)} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  const html = `<div class="init-heading"><div><h3>${value.status === 'running' ? '正在初始化项目' : value.status === 'completed' ? '项目初始化完成' : '项目初始化未完成'}</h3><p>${value.files} 个文件 · 已读取 ${value.documents.length} 份文档${value.skipped ? ` · 跳过 ${value.skipped} 项` : ''} · <span id="init-elapsed"></span></p></div>${value.canRetry ? '<button id="retry-initialization" class="quiet-button" type="button">重试初始化</button>' : ''}</div>
    <ol class="init-stages">${value.steps.map(step => `<li class="init-${step.status}"><span class="init-step-dot" aria-hidden="true"></span><span>${names[step.id] ?? escape(step.id)}<small>${statuses[step.status] ?? escape(step.status)}</small></span></li>`).join('')}</ol>
    ${value.error ? `<p class="init-error" role="status">${escape(value.error)}</p>` : ''}<p class="editor-note">有来源的字段会逐步同步；未确定的内容留空，你可以随时填写。人工修改会保留，初始化不会启动研究。</p>
    ${value.documents.length ? `<details class="init-sources"><summary>查看已读取文档与字段来源</summary><ul>${value.documents.map(doc => `<li>${escape(doc.path)}${doc.extracted ? ' · 已处理' : ' · 已读取'}</li>`).join('')}</ul>${value.findings.map(finding => `<p>${escape(({ paperType: '论文类型', seedPapers: '论文种子', targetJournal: '目标会议 / 期刊' } as Record<string, string>)[finding.field])} · ${escape(finding.source)}:${finding.line} · ${finding.applied ? '已同步' : escape(finding.reason)}<q>${escape(finding.quote)}</q></p>`).join('')}</details>` : ''}`;
  if (html !== lastInitHtml) { const expanded = container.querySelector('details')?.open; container.innerHTML = html; const details = container.querySelector('details'); if (details && expanded) details.open = true; lastInitHtml = html; }
  $('#init-elapsed').textContent = elapsedText; updateControls();
}
export async function initWorkspace() {
  if (loading) return; loading = true;
  try {
    const response = await fetch('/api/workspace', { signal: AbortSignal.timeout(8000) }); if (!response.ok) return;
    const data = await response.json(); if (data.enabled === false) return;
    current = data; installForm(); $('#workspace-settings').hidden = false;
    $('#workspace-status').textContent = data.status === 'ready' ? data.record : data.error ?? '打开已有代码或研究文件夹，或创建一个空项目。';
    updateControls(); updateInitialization(initialization);
  } catch { /* The dashboard reports connection failures. */ }
  finally { loading = false; if (pendingRecord && current?.record !== pendingRecord) { pendingRecord = ''; void initWorkspace(); } }
}
export function workspacePending(record: string) {
  $('#connection').textContent = '尚未打开项目'; updateInitialization();
  if (current?.record !== record || current.status === 'ready') { pendingRecord = record; void initWorkspace(); }
}

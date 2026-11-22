import fs from 'node:fs';
import { browseWorkspace } from './workspace-picker.js';
import { pickProjectDirectory, type FolderPicker } from './native-folder-picker.js';
import { initializationView, launchInitialization, prepareInitialization } from './project-initialization.js';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { alive, local, Store } from './store.js';
import { invalidate } from './gates.js';
import type { State, Task } from './types.js';
import { researchInputsSchema } from './types.js';
import { InputConflict, researchInputs, updateResearchInputs } from './research-inputs.js';
import type { DashboardSnapshot, Lane } from '../web/types.js';
import { tracePage, traceDetail, TraceNotFound } from './trace.js';
import { activitySnapshot } from './activity.js';
import { snapshotStream } from './dashboard-stream.js';
import { paperProfile, paperProfiles, paperType, paperTypePreference, taskPaperType } from './paper-types.js';
import { venueCatalog } from './venues.js';
import { resolvePaperReference } from './paper-reference.js';
import { activePipelineTask, pipelineSpecs } from './pipeline-plan.js';
import { controlScheduler, defaultSkillRoot, launchScheduler, runControl, StartError } from './run-control.js';
import { createNamedWorkspace, createWorkspace, saveWorkspace, workspaceInfo, workspaceRequest, workspaceStore, WorkspaceError, type BackendConfig } from './web-workspace.js';

function lane(task: Task, workerAlive: boolean): Lane {
  if (task.acceptance === 'stale') return 'attention';
  if (task.execution === 'running') return workerAlive ? 'active' : 'attention';
  if (task.acceptance === 'accepted') return 'done';
  if (task.acceptance === 'blocked' || ['failed', 'cancelled', 'limited', 'interrupted'].includes(task.execution)) return 'attention';
  return 'queued';
}

export function dashboardSnapshot(state: State, project: string, root?: string, skillRoot = defaultSkillRoot): DashboardSnapshot {
  const activity = activitySnapshot(state, { root });
  const graphOrder = new Map(state.pipelineGraph?.taskIds.map((id, index) => [id, index]) ?? []);
  const tasks = Object.values(state.tasks).filter(task => activePipelineTask(state, task) || task.execution === 'running').sort((a, b) => (graphOrder.get(a.id) ?? Infinity) - (graphOrder.get(b.id) ?? Infinity)).map(task => {
    const workerAlive = alive(task.worker);
    const reasons = [...task.reasons];
    if (task.execution === 'running' && !workerAlive) reasons.unshift('工作进程已离线，等待 runtime 恢复检查。');
    const activeSeconds = task.startedAt ? Math.max(0, ((workerAlive ? Date.now() : task.heartbeat ?? task.startedAt) - task.startedAt) / 1000) : 0;
    return {
      id: task.id, stage: task.stage, prompt: task.prompt, session: task.session, lane: lane(task, workerAlive),
      nodeLabel: task.pipelineStep?.label,
      execution: task.execution, acceptance: task.acceptance, attempts: task.attempts,
      dependencies: task.dependencies, outputs: task.outputs, inputs: task.inputs, reasons,
      elapsedSeconds: task.elapsedSeconds + activeSeconds, expectedSeconds: task.expectedSeconds,
      workerAlive, heartbeat: task.heartbeat, executionCompletedAt: task.executionCompletedAt,
      inputRevision: task.researchInputs?.revision ?? 0,
      paperType: taskPaperType(state, task),
      progress: activity.progress[task.id],
      review: task.review ? { verdict: task.review.verdict, summary: task.review.summary, family: task.review.family, model: task.review.model, limitations: task.review.limitations, time: task.review.time } : undefined,
      checks: Object.entries(task.checks ?? {}).map(([name, check]) => ({ name, passed: check.passed, report: check.report })), claimIds: task.claimIds,
    };
  });
  return {
    runControl: runControl(state, root, skillRoot),
    project, goal: state.goal, mode: state.mode, updatedAt: new Date().toISOString(), initialization: initializationView(state),
    researchInputs: researchInputs(state),
    paperType: paperType(state), paperTypePreference: paperTypePreference(state), paperTypeReason: paperTypePreference(state) === null && paperType(state) !== null ? state.paperTypeResolution?.reason : undefined,
    paperTypes: paperProfiles.map(({ type, label, description, empirical }) => ({ type, label, description, empirical, nodes: pipelineSpecs(type).map(spec => spec.pipelineStep.label) })),
    pipelineGraph: state.pipelineGraph ? { type: state.pipelineGraph.type, revisions: state.pipelineGraph.revisions, nodes: pipelineSpecs(state.pipelineGraph.type).map(spec => ({ id: spec.id, label: spec.pipelineStep.label, dependencies: spec.dependencies, reworkTargets: spec.pipelineStep.checkpoint?.reworkTargets ?? [] })) } : undefined,
    stageLabels: paperType(state) === null ? { plan: '研究方案', experiment: '研究执行', analysis: '分析' } : paperProfile(paperType(state)).empirical ? { plan: '实验方案', experiment: '实验', analysis: '分析' } : paperType(state) === 'theory' ? { plan: '定义与假设', experiment: '证明与反例', analysis: '理论分析' } : paperType(state) === 'survey' ? { plan: '检索方案', experiment: '文献筛选', analysis: '综合分析' } : { plan: '论证方案', experiment: '证据与反驳', analysis: '论证分析' },
    workflow: activity.workflow, agents: activity.agents,
    topic: { status: state.topic.status, version: state.topic.version, proposal: state.topic.proposal }, tasks,
    claims: Object.values(state.claims).map(c => ({ id: c.id, taskId: c.taskId, text: c.text, evidence: c.evidence })),
    sources: Object.values(state.sources).map(s => ({ id: s.id, title: s.title, identity: s.identity, version: s.version, path: s.path, retrievedAt: s.retrievedAt })),
    challenges: Object.values(state.challenges).map(c => ({ id: c.id, claimId: c.claimId, taskId: c.taskId, severity: c.severity, status: c.status, reason: c.reason, response: c.response?.reason })),
    events: state.events.slice(-250).reverse().map(e => ({ seq: e.seq, type: e.type, time: e.time, task: typeof e.data.task === 'string' ? e.data.task : undefined, summary: ['verdict', 'check', 'reason', 'message'].flatMap(key => typeof e.data[key] === 'string' ? [e.data[key] as string] : []).join(' · ').slice(0, 500) })), totalEvents: state.events.length,
  };
}

function artifactPaths(state: State): Set<string> {
  return new Set([
    ...Object.values(state.tasks).flatMap(t => [...t.inputs, ...t.outputs, ...Object.values(t.checks ?? {}).map(c => c.report)]),
    ...Object.values(state.sources).map(s => s.path), ...(state.topic.proposal ? [state.topic.proposal] : []),
  ]);
}

export async function startDashboard(options: { record?: string; port?: number; skillRoot?: string; workspace?: boolean; workspaceConfig?: BackendConfig; pickDirectory?: FolderPicker } = {}) {
  const skillRoot = path.resolve(options.skillRoot ?? defaultSkillRoot);
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid dashboard port');
  let selectedStore = new Store(options.record ?? 'project.json');
  let activePicker: AbortController | undefined;
  const workspace = options.workspace === true;
  const launchDirectory = process.cwd();
  const assets = fileURLToPath(new URL('../dashboard/', import.meta.url));
  const readState = () => {
    const state = selectedStore.read();
    if (!state || state.version !== 1) throw new Error('Unsupported project record');
    return state;
  };
  const readSnapshot = () => {
    const store = selectedStore;
    if (workspace) {
      const info = workspaceInfo(store, options.workspaceConfig);
      if (info.status !== 'ready') return { workspace: { record: store.file, needsSetup: true, error: info.status === 'invalid' ? info.error : undefined } };
    }
    const state = readState(); invalidate(store.root, state);
    return { ...dashboardSnapshot(state, path.basename(store.root), store.root, skillRoot), ...(workspace ? { workspace: { record: store.file } } : {}) };
  };
  let stream = snapshotStream(readSnapshot, selectedStore.file);
  const server = http.createServer(async (req, res) => {
    // Pin the target for the whole request, even if another tab switches projects.
    const store = selectedStore;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(req.headers.host ?? '') || (req.headers.origin && !allowedHosts.some(h => req.headers.origin === `http://${h}`))) { json(403, { error: 'Local dashboard origin required' }); return; }
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      if (!workspace && url.pathname === '/api/workspace' && req.method === 'GET') { json(200, { enabled: false }); return; }
      if (workspace && url.pathname === '/api/workspace') {
        if (req.method === 'GET') { json(200, workspaceInfo(store, options.workspaceConfig)); return; }
        if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); json(405, { error: 'Unsupported workspace operation' }); return; }
        if (req.headers['x-research-control'] !== '1' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(403, { error: 'Use the local workspace setup form' }); return; }
        req.setTimeout(10000, () => req.destroy()); const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 128 * 1024) { json(413, { error: '工作区设置过大。' }); return; } chunks.push(Buffer.from(chunk)); }
        try {
          const input = workspaceRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (input.action === 'create-native' || input.action === 'open-native') {
            if (activePicker) throw new WorkspaceError('文件夹选择窗口已打开，请先完成或取消当前选择。');
            const controller = new AbortController(); activePicker = controller;
            const cancel = () => { if (!res.writableEnded) controller.abort(); };
            req.setTimeout(0); res.once('close', cancel);
            try {
              const directory = await (options.pickDirectory ?? pickProjectDirectory)(controller.signal, input.action === 'open-native' ? 'open' : 'create');
              if (controller.signal.aborted || res.destroyed) return;
              if (!directory) { json(200, { cancelled: true }); return; }
              if (selectedStore.file !== store.file) throw new WorkspaceError('当前项目已切换，请重新选择创建位置。');
              if (input.action === 'create-native') { json(200, { directory, record: store.file }); return; }
              const next = workspaceStore(path.join(directory, 'project.json'), launchDirectory);
              let info = workspaceInfo(next, options.workspaceConfig);
              if (info.status === 'invalid') throw new WorkspaceError(info.error!);
              if (info.status === 'new') {
                const config = options.workspaceConfig?.();
                if (!config) throw new WorkspaceError('后端尚未配置模型，请配置服务后重试。', 503);
                await next.init('', config, 'automatic', undefined, prepareInitialization);
                await launchInitialization(next); info = workspaceInfo(next, options.workspaceConfig);
              }
              selectedStore = next; stream.close(); stream = snapshotStream(readSnapshot, next.file); json(200, info);
            } finally { res.removeListener('close', cancel); activePicker = undefined; }
          } else if (input.action === 'create-project') {
            if (input.record !== store.file || selectedStore.file !== store.file) throw new WorkspaceError('当前项目已切换，请重新选择创建位置。');
            const { store: next, info } = await createNamedWorkspace(input.directory, input.name, options.workspaceConfig);
            selectedStore = next; stream.close(); stream = snapshotStream(readSnapshot, next.file); json(200, info);
          } else if (input.action === 'retry-init') {
            if (input.record !== store.file || selectedStore.file !== store.file) throw new WorkspaceError('当前项目已切换，请刷新后重试。');
            const state = store.read();
            if (state.initialization?.id !== input.runId || !initializationView(state)?.canRetry) throw new WorkspaceError('初始化状态已变化，请刷新后重试。');
            await launchInitialization(store); stream.publish(); json(202, { initialization: initializationView(store.read()) });
          } else if (input.action === 'browse') {
            json(200, await browseWorkspace(store.file, launchDirectory, input.directory));
          } else if (input.action === 'open') {
            const next = workspaceStore(input.record, launchDirectory); const info = workspaceInfo(next, options.workspaceConfig);
            if (info.status === 'invalid') throw new WorkspaceError(info.error!);
            if (info.status !== 'ready') throw new WorkspaceError('这个路径没有已创建的项目，请检查路径或选择“创建项目”。');
            selectedStore = next; stream.close(); stream = snapshotStream(readSnapshot, next.file); json(200, info);
          } else if (input.action === 'create') {
            const next = workspaceStore(input.record, launchDirectory);
            const info = await createWorkspace(next, input.goal ?? '', options.workspaceConfig);
            selectedStore = next; stream.close(); stream = snapshotStream(readSnapshot, next.file); json(200, info);
          } else {
            if (selectedStore.file !== store.file) throw new WorkspaceError('当前项目已切换，请重新打开设置。');
            const result = await saveWorkspace(store, input, options.workspaceConfig); stream.publish(); json(200, result);
          }
        } catch (error) { json(error instanceof WorkspaceError ? error.status : 400, { error: error instanceof WorkspaceError ? error.message : '工作区设置无效，请检查字段后重试。' }); }
        return;
      }
      if (workspace && ['POST', 'PUT', 'DELETE'].includes(req.method ?? '') && req.headers['x-research-workspace'] !== encodeURIComponent(store.file)) { json(409, { error: '项目连接已变化，请刷新后重试。' }); return; }
      if (url.pathname === '/api/run/control' && req.method === 'POST') {
        if (req.headers['x-research-control'] !== '1' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(403, { error: 'Use the local run controls with a JSON request' }); return; }
        req.setTimeout(10000, () => req.destroy()); const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) { json(413, { error: '运行控制请求过大。' }); return; } chunks.push(Buffer.from(chunk)); }
        let input;
        try { input = z.object({ action: z.enum(['pause', 'resume', 'terminate']), runId: z.string().min(1).nullable(), revision: z.number().int().nonnegative(), expectedRevision: z.number().int().nonnegative(), topicVersion: z.number().int().nonnegative() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { json(400, { error: '运行控制请求必须包含操作和当前项目运行版本。' }); return; }
        try {
          if (store.read()?.version !== 1) throw new Error('Unsupported project');
          const result = await controlScheduler(store, skillRoot, input); stream.publish(); json(200, result);
        } catch (error) { json(error instanceof StartError ? error.status : 503, { error: error instanceof StartError ? error.message : '无法更新运行状态，请检查项目记录后重试。' }); }
        return;
      }
      if (url.pathname === '/api/run' && req.method === 'POST') {
        if (req.headers['x-research-control'] !== '1' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(403, { error: 'Use the local start button with a JSON request' }); return; }
        req.setTimeout(10000, () => req.destroy());
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) { json(413, { error: '启动请求过大。' }); return; } chunks.push(Buffer.from(chunk)); }
        let input;
        try { input = z.object({ expectedRevision: z.number().int().nonnegative(), topicVersion: z.number().int().nonnegative() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { json(400, { error: '启动请求必须包含当前研究输入版本和选题版本。' }); return; }
        try {
          if (store.read()?.version !== 1) throw new Error('Unsupported project');
          const result = await launchScheduler(store, skillRoot, input.expectedRevision, input.topicVersion);
          stream.publish(); json(result.started ? 202 : 200, result);
        } catch (error) { json(error instanceof StartError ? error.status : 503, { error: error instanceof StartError ? error.message : '无法启动项目，请检查项目记录和 runtime 安装。' }); }
        return;
      }
      if (url.pathname === '/api/research-inputs' && req.method === 'PUT') {
        // A custom header plus JSON requires a browser preflight from foreign origins.
        if (req.headers['x-research-inputs'] !== '1' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(403, { error: 'Use the local research-input editor with a JSON request' }); return; }
        req.setTimeout(10000, () => req.destroy());
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 256 * 1024) { json(413, { error: '研究输入过大，请缩短备注。' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        let payload;
        try { payload = z.object({ expectedRevision: z.number().int().nonnegative(), inputs: researchInputsSchema, edit: z.object({ fields: z.array(z.enum(['paperType', 'seedPapers', 'targetJournal'])).max(3), base: researchInputsSchema }).strict().optional() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { json(400, { error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : '研究输入必须是有效的 JSON。' }); return; }
        try {
          if (store.read()?.version !== 1) throw new Error('Unsupported project');
          const inputs = await updateResearchInputs(store, payload.inputs, payload.expectedRevision, payload.edit);
          stream.publish();
          json(200, { inputs });
        } catch (error) { json(error instanceof InputConflict ? 409 : 503, { error: error instanceof InputConflict ? error.message : '无法保存项目记录，请检查文件后重试。' }); }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', url.pathname === '/api/research-inputs' ? 'PUT' : 'GET, HEAD'); json(405, { error: 'Unsupported dashboard operation' }); return; }
      if (url.pathname === '/api/run' || url.pathname === '/api/run/control') { res.setHeader('Allow', 'POST'); json(405, { error: 'Run controls require an explicit POST request' }); return; }
      if (url.pathname === '/api/venues') { json(200, venueCatalog()); return; }
      if (url.pathname === '/api/paper-reference') {
        if (req.method !== 'GET' || req.headers['x-research-inputs'] !== '1') { json(403, { error: 'Use the paper input field to look up a reference.' }); return; }
        const input = url.searchParams.get('input')?.trim();
        if (!input || input.length > 2048) { json(400, { error: '请输入论文标题、DOI 或链接。' }); return; }
        try { json(200, await resolvePaperReference(input)); }
        catch { json(503, { error: '暂时无法补全论文信息，原始输入已保留，可直接保存或手动补充。' }); }
        return;
      }
      if (url.pathname === '/api/stream') {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); res.end(); }
        else stream.attach(res);
        return;
      }
      const asset = ({ '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/paper-reference.js': ['paper-reference.js', 'text/javascript; charset=utf-8'], '/workspace.js': ['workspace.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/logo.png': ['logo.png', 'image/png'] } as Record<string, string[]>)[url.pathname];
      if (asset) { res.writeHead(200, { 'Content-Type': asset[1] }); res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(assets, asset[0]))); return; }
      if (workspace && url.pathname === '/api/state') { json(200, readSnapshot()); return; }
      if (!['/api/state', '/api/artifact', '/api/trace', '/api/trace/event'].includes(url.pathname)) { json(404, { error: 'Not found' }); return; }
      let state: State;
      try { state = readState(); }
      catch { json(503, { error: '无法读取项目记录。请确认 --record 指向已初始化的 project.json；恢复文件后看板会自动重连。' }); return; }
      if (url.pathname.startsWith('/api/trace')) {
        try {
          const args = z.object({ task: z.string().optional(), category: z.enum(['model', 'tool', 'retrieval', 'check', 'review', 'lifecycle']).optional(), attempt: z.coerce.number().int().nonnegative().optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), seq: z.coerce.number().int().positive().optional() }).strict().parse(Object.fromEntries(url.searchParams));
          if (url.pathname === '/api/trace/event') {
            if (!args.seq) { json(400, { error: 'Trace 步骤序号不能为空。' }); return; }
            json(200, traceDetail(state, args.seq, args.task));
          } else json(200, tracePage(state, args));
        } catch (error) { json(error instanceof TraceNotFound ? 404 : 400, { error: error instanceof TraceNotFound ? error.message : 'Trace 查询参数无效。' }); }
        return;
      }
      if (url.pathname === '/api/state') {
        // Recalculate staleness on the detached in-memory snapshot. Never write or reconcile workers.
        invalidate(store.root, state);
        json(200, readSnapshot()); return;
      }
      const name = url.searchParams.get('path') ?? '';
      if (!artifactPaths(state).has(name)) { json(403, { error: 'Only registered project artifacts can be inspected' }); return; }
      const file = local(store.root, name);
      if (file === store.file || path.basename(file).startsWith('.env')) { json(403, { error: 'Project control and credential files are not exposed' }); return; }
      if (!fs.existsSync(file)) { json(404, { error: '产物尚未生成或已移动。' }); return; }
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd); if (!stat.isFile()) { json(415, { error: 'Only regular text files can be previewed' }); return; }
        const bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024)); fs.readSync(fd, bytes);
        if (bytes.includes(0)) { json(415, { error: '此文件为二进制格式，请在本地应用中查看。' }); return; }
        json(200, { path: name, content: bytes.toString('utf8'), truncated: stat.size > bytes.length });
      } finally { fs.closeSync(fd); }
    } catch { if (!res.headersSent) json(500, { error: '读取看板数据失败，请检查项目文件和访问权限。' }); else res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { activePicker?.abort(); stream.close(); server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}

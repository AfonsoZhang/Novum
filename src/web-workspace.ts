import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { alive, contentHash, event, Store } from './store.js';
import { configSchema, type Config, type State } from './types.js';

export class WorkspaceError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export type BackendConfig = () => Config | undefined;
export const workspaceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-native') }).strict(),
  z.object({ action: z.literal('create-project'), record: z.string().min(1), directory: z.string().min(1), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('open-native') }).strict(),
  z.object({ action: z.literal('retry-init'), record: z.string().min(1), runId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('browse'), directory: z.string().trim().min(1).max(4096).optional() }).strict(),
  z.object({ action: z.literal('open'), record: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('create'), record: z.string().trim().min(1).max(4096), goal: z.string().trim().max(4000).optional() }).strict(),
  z.object({ action: z.literal('save'), record: z.string().min(1), expectedConfig: z.string().nullable(), goal: z.string().trim().max(4000).optional() }).strict(),
]);

/** Only the backend reads model routes and credential environment names. */
export function readBackendConfig(file?: string): Config | undefined {
  const configured = file ?? process.env.RESEARCH_RUNTIME_CONFIG;
  const target = path.resolve(configured ?? 'config/runtime.local.json');
  if (!configured && !fs.existsSync(target)) return undefined;
  try {
    const config = configSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8')));
    for (const route of [config.executor, config.reviewer]) {
      const url = new URL(route.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid backend route');
    }
    return config;
  } catch { throw new WorkspaceError('后端模型配置不可用，请检查服务端配置文件。', 503); }
}
export function workspaceStore(record: string, cwd: string): Store {
  const file = path.resolve(cwd, record);
  if (path.extname(file).toLowerCase() !== '.json') throw new WorkspaceError('请选择项目的 .json 记录文件。', 400);
  return new Store(file);
}
const revision = (state: State) => contentHash(JSON.stringify({ goal: state.goal, config: state.config }));
const editableGoal = (state: State) => state.topic.status === 'UNSELECTED' && Object.values(state.tasks).every(task => task.attempts === 0 && task.execution === 'pending');
const modelStatus = (config?: Config) => ({ configured: !!config, credentialsReady: !!config && !!process.env[config.executor.apiKeyEnv] && !!process.env[config.reviewer.apiKeyEnv] });
export function workspaceInfo(store: Store, backendConfig?: BackendConfig) {
  const fresh = () => {
    try { const config = backendConfig?.(); return { record: store.file, status: 'new' as const, expectedConfig: null, goalEditable: true, backend: modelStatus(config) }; }
    catch { return { record: store.file, status: 'new' as const, expectedConfig: null, goalEditable: true, backend: { ...modelStatus(), error: '后端模型配置不可用，请检查服务端配置文件。' } }; }
  };
  if (!fs.existsSync(store.file)) return fresh();
  let state;
  try { state = store.read(); }
  catch { return { record: store.file, status: 'invalid' as const, expectedConfig: null, error: '项目文件无法解析。请选择其他记录，或修复文件后重新连接。' }; }
  if (!state) return fresh();
  try {
    if (state.version !== 1 || typeof state.goal !== 'string') throw new Error('Unsupported record');
    const config = configSchema.parse(state.config);
    return { record: store.file, status: 'ready' as const, goal: state.goal, goalEditable: editableGoal(state),
      expectedConfig: revision(state), backend: modelStatus(config) };
  } catch { return { record: store.file, status: 'invalid' as const, expectedConfig: null, error: '记录中的 runtime 版本或模型配置无效，请修复后重新连接。' }; }
}

export async function createWorkspace(store: Store, goal: string, backendConfig?: BackendConfig) {
  if (fs.existsSync(store.file)) throw new WorkspaceError('这个路径已有文件，请连接已有项目或选择新的保存路径。');
  const config = backendConfig?.();
  if (!config) throw new WorkspaceError('后端尚未配置模型，请配置服务后重试。', 503);
  try { await store.init(goal, config); }
  catch { throw new WorkspaceError('项目创建失败或已由其他窗口创建，请检查保存路径后重试。'); }
  return workspaceInfo(store, backendConfig);
}

/** Create exactly one new child folder; an existing directory is never reused. */
export async function createNamedWorkspace(parent: string, name: string, backendConfig?: BackendConfig) {
  if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
    throw new WorkspaceError('项目名称不能包含路径、特殊字符、保留名称或以点结尾。', 400);
  }
  const config = backendConfig?.();
  if (!config) throw new WorkspaceError('后端尚未配置模型，请配置服务后重试。', 503);
  let directory: string;
  try { directory = fs.realpathSync(parent); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
  catch { throw new WorkspaceError('保存位置不可用，请重新选择文件夹。', 400); }
  const target = path.join(directory, name);
  try { fs.mkdirSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('同名文件夹已存在，请换一个项目名称，或使用“打开已有项目”。');
    throw new WorkspaceError('无法创建项目文件夹，请检查保存位置的写入权限。', 400);
  }
  const store = new Store(path.join(target, 'project.json'));
  try { const info = await createWorkspace(store, '', () => config); return { store, info }; }
  catch (error) { try { fs.rmdirSync(target); } catch { /* Preserve any files written during initialization. */ } throw error; }
}

export async function saveWorkspace(store: Store, input: Extract<z.infer<typeof workspaceRequest>, { action: 'save' }>, backendConfig?: BackendConfig) {
  if (path.resolve(input.record) !== store.file) throw new WorkspaceError('当前项目已切换，请重新打开设置。');
  const info = workspaceInfo(store, backendConfig);
  if (info.status === 'invalid') throw new WorkspaceError(info.error!);
  if (info.expectedConfig !== input.expectedConfig) throw new WorkspaceError('项目设置已更新，请重新打开设置后合并修改。');
  if (info.status === 'new') {
    const config = backendConfig?.();
    if (!config) throw new WorkspaceError('后端尚未配置模型，请配置服务后重试。', 503);
    try { await store.init(input.goal ?? '', config); }
    catch { throw new WorkspaceError('项目初始化失败或已由其他窗口创建，请重新连接。'); }
  } else {
    await store.update(state => {
      if (revision(state) !== input.expectedConfig) throw new WorkspaceError('项目设置已更新，请重新打开设置后合并修改。');
      if ((state.scheduler && ['starting', 'running'].includes(state.scheduler.status) && alive(state.scheduler.process)) || Object.values(state.tasks).some(task => task.execution === 'running' || alive(task.worker))) throw new WorkspaceError('研究正在运行，请等本轮结束后再修改项目设置。');
      const goal = input.goal ?? state.goal;
      if (goal !== state.goal) {
        if (!editableGoal(state)) throw new WorkspaceError('研究已开始，不能在项目设置中改写研究目标。');
        state.goal = goal; event(state, 'research_goal_updated', { source: 'web', goal });
      }
      event(state, 'workspace_settings_updated', { source: 'web' });
    });
  }
  return workspaceInfo(store, backendConfig);
}

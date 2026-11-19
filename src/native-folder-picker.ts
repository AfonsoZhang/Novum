import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WorkspaceError } from './web-workspace.js';

export type FolderPicker = (signal: AbortSignal, purpose?: 'open' | 'create') => Promise<string | null>;
const execute = promisify(execFile);
let active = false;

/** Launch a Windows GUI executable directly: no shell or console host. */
export async function nativePickerCommand(probe = false, purpose: 'open' | 'create' = 'create'): Promise<{ command: string; args: string[]; wsl: boolean }> {
  const wsl = process.platform === 'linux' && /microsoft/i.test(os.release());
  if (process.platform !== 'win32' && !wsl) throw new WorkspaceError('当前系统未提供 Windows 文件资源管理器选择器。', 503);
  const command = fileURLToPath(new URL('./native-folder-picker.exe', import.meta.url));
  try { await fs.access(command); }
  catch { throw new WorkspaceError('系统文件夹选择器尚未构建，请重新构建并启动本地服务。', 503); }
  return { command, args: [...(probe ? ['--probe'] : []), ...(purpose === 'open' ? ['--open'] : [])], wsl };
}

export const pickProjectDirectory: FolderPicker = async (signal, purpose = 'create') => {
  if (active) throw new WorkspaceError('文件夹选择窗口已打开，请先完成或取消当前选择。');
  active = true;
  let exchange: string | undefined;
  try {
    signal.throwIfAborted();
    const command = await nativePickerCommand(false, purpose);
    exchange = await fs.mkdtemp(path.join(os.tmpdir(), 'research-picker-'));
    const resultFile = path.join(exchange, 'result.json'); const cancelFile = path.join(exchange, 'cancel');
    const nativePath = async (file: string) => command.wsl ? (await execute('wslpath', ['-w', file], { signal })).stdout.trim() : file;
    command.args.push('--result', await nativePath(resultFile), '--cancel', await nativePath(cancelFile));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command.command, command.args, { windowsHide: true, stdio: 'ignore' });
      let timedOut = false; let killTimer: NodeJS.Timeout | undefined;
      // A GUI subsystem process has no console handles under WSL. Exchange results
      // through private files; a background watcher observes cancellation.
      const cancel = () => {
        void fs.writeFile(cancelFile, '').catch(() => {});
        killTimer ??= setTimeout(() => child.kill(), 5000);
      };
      const timeout = setTimeout(() => { timedOut = true; cancel(); }, 300_000);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', cancel); };
      child.once('error', () => { cleanup(); reject(new WorkspaceError('无法打开文件资源管理器，请确认 Windows 桌面会话可用。', 503)); });
      child.once('close', async code => {
        cleanup();
        if (signal.aborted) { reject(new WorkspaceError('已取消位置选择。')); return; }
        if (timedOut) { reject(new WorkspaceError('位置选择已超时，请重新选择。')); return; }
        if (code !== 0) { reject(new WorkspaceError('系统文件夹选择器未能完成，请重新选择。', 503)); return; }
        try {
          if ((await fs.stat(resultFile)).size > 32_768) throw new Error('Oversized result');
          resolve(await fs.readFile(resultFile, 'utf8'));
        } catch { reject(new WorkspaceError('无法读取所选文件夹，请重新选择。', 503)); }
      });
    });
    signal.throwIfAborted();
    let selected: unknown;
    try { selected = JSON.parse(stdout.trim()).directory; }
    catch { throw new WorkspaceError('无法读取所选文件夹，请重新选择。', 503); }
    if (selected === null || selected === '') return null;
    if (typeof selected !== 'string' || !path.win32.isAbsolute(selected) || selected.includes('\0')) throw new WorkspaceError('系统返回的位置无效，请重新选择。', 400);
    const directory = command.wsl ? (await execute('wslpath', ['-u', selected], { timeout: 5000, maxBuffer: 32_768, signal })).stdout.trim() : selected;
    try {
      const resolved = await fs.realpath(directory);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Not a folder');
      return resolved;
    } catch { throw new WorkspaceError('无法访问所选文件夹，请选择本机可写入的位置。', 400); }
  } finally { if (exchange) await fs.rm(exchange, { recursive: true, force: true }); active = false; }
};

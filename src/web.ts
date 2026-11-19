import { spawn } from 'node:child_process';
import { startDashboard } from './dashboard.js';
import { readBackendConfig } from './web-workspace.js';
import type { FolderPicker } from './native-folder-picker.js';

export function browserCommands(url: string, platform = process.platform, wsl = !!process.env.WSL_DISTRO_NAME): string[][] {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Only the local Web service URL may be opened');
  if (platform === 'win32') return [['cmd.exe', '/d', '/c', 'start', '', url]];
  if (platform === 'darwin') return [['open', url]];
  return wsl ? [['wslview', url], ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], ['xdg-open', url]] : [['xdg-open', url], ['gio', 'open', url]];
}
export async function openBrowser(url: string): Promise<boolean> {
  for (const [command, ...args] of browserCommands(url)) {
    const opened = await new Promise<boolean>(resolve => {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
    });
    if (opened) return true;
  }
  return false;
}

/** One local entrypoint; the dashboard and CLI still use the same runtime. */
export async function startWeb(options: { record?: string; configFile?: string; port?: number; skillRoot?: string; noOpen?: boolean; launchBrowser?: (url: string) => Promise<boolean>; pickDirectory?: FolderPicker } = {}) {
  const ports = options.port === undefined ? Array.from({ length: 11 }, (_, i) => 4317 + i) : [options.port];
  for (const [index, port] of ports.entries()) {
    let dashboard;
    try { dashboard = await startDashboard({ ...options, port, workspace: true, workspaceConfig: () => readBackendConfig(options.configFile) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && index < ports.length - 1) continue; throw error; }
    const reason = options.noOpen ? 'disabled' : process.env.SSH_CONNECTION || process.env.SSH_TTY ? 'ssh' : undefined;
    const opened = reason ? false : await (options.launchBrowser ?? openBrowser)(dashboard.url).catch(() => false);
    return { ...dashboard, browser: { opened, reason: reason ?? (opened ? 'opened' : 'open-url-manually') } };
  }
  throw new Error('No available local Web port');
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceError } from './web-workspace.js';

/** The local picker exposes names and locations only; opening it never writes a project. */
export async function browseWorkspace(record: string, cwd: string, directory?: string) {
  let target = directory ? path.resolve(cwd, directory) : path.dirname(record);
  if (!directory) {
    while (!(await fs.stat(target).catch(() => undefined))?.isDirectory()) {
      const parent = path.dirname(target); if (parent === target) break; target = parent;
    }
  }
  try {
    target = await fs.realpath(target);
    const items = await fs.readdir(target, { withFileTypes: true });
    const entries = (await Promise.all(items.filter(item => !item.name.startsWith('.')).map(async item => {
      const file = path.join(target, item.name);
      const directory = item.isDirectory() || (item.isSymbolicLink() && (await fs.stat(file).catch(() => undefined))?.isDirectory());
      if (directory) return { name: item.name, path: file, kind: 'directory' as const };
      if (item.isFile() && path.extname(item.name).toLowerCase() === '.json') return { name: item.name, path: file, kind: 'file' as const };
      return undefined;
    }))).filter(item => item !== undefined).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const locations = [{ name: '主目录', path: os.homedir() }, { name: '工作目录', path: cwd }];
    for (const drive of ['c', 'd', 'e']) {
      const mounted = `/mnt/${drive}`;
      if ((await fs.stat(mounted).catch(() => undefined))?.isDirectory()) locations.push({ name: `Windows ${drive.toUpperCase()}:`, path: mounted });
    }
    return { directory: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries, locations };
  } catch { throw new WorkspaceError('无法打开此文件夹，请选择其他位置。', 400); }
}

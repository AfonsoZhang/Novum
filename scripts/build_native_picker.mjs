import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wsl = process.platform === 'linux' && /microsoft/i.test(os.release());
if (process.platform === 'win32' || wsl) {
  const windows = process.env.WINDIR ?? 'C:\\Windows';
  const compiler = wsl ? '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    : path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is required to build the native folder picker.');
  const nativePath = value => wsl ? execFileSync('wslpath', ['-w', value], { encoding: 'utf8' }).trim() : value;
  mkdirSync(path.join(root, 'dist/src'), { recursive: true });
  // Build once, not on a button click. The GUI subsystem never allocates a console.
  execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll', '/out:' + nativePath(path.join(root, 'dist/src/native-folder-picker.exe')),
    nativePath(path.join(root, 'src/native-folder-picker.cs'))], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  if (wsl) chmodSync(path.join(root, 'dist/src/native-folder-picker.exe'), 0o755);
}

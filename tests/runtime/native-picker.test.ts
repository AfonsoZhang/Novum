import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativePickerCommand, pickProjectDirectory } from '../../src/native-folder-picker.js';

const execute = promisify(execFile);
const supported = process.platform === 'win32' || (process.platform === 'linux' && /microsoft/i.test(os.release()));
test('Windows picker uses the GUI subsystem and both modes return probe results without console handles', { skip: !supported }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picker-probe-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const purpose of ['create', 'open'] as const) {
    const command = await nativePickerCommand(true, purpose);
    const executable = await fs.readFile(command.command);
    const peOffset = executable.readUInt32LE(0x3c);
    assert.equal(executable.readUInt16LE(peOffset + 24 + 68), 2, 'Windows GUI subsystem must not allocate a console');
    const result = path.join(directory, purpose + '.json');
    const nativeResult = command.wsl ? (await execute('wslpath', ['-w', result])).stdout.trim() : result;
    await execute(command.command, [...command.args, '--result', nativeResult], { timeout: 20000, windowsHide: true });
    assert.deepEqual(JSON.parse(await fs.readFile(result, 'utf8')), { available: true });
  }
});

test('both real native dialogs become foreground windows and close promptly on cancellation', {
  skip: !supported || process.env.RESEARCH_NATIVE_UI_TEST !== '1',
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picker-focus-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const wsl = process.platform !== 'win32';
  const native = async (file: string) => wsl ? (await execute('wslpath', ['-w', file])).stdout.trim() : file;
  const compiler = wsl ? '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    : path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const inspector = path.join(directory, 'inspector.exe'); const result = path.join(directory, 'windows.json');
  await execute(compiler, ['/nologo', '/target:winexe', '/reference:System.Web.Extensions.dll', '/out:' + await native(inspector),
    await native(path.resolve('tests/runtime/fixtures/picker-window-inspector.cs'))], { windowsHide: true, timeout: 30000 });
  if (wsl) await fs.chmod(inspector, 0o755);
  for (const purpose of ['create', 'open'] as const) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    const pending = pickProjectDirectory(controller.signal, purpose).then(value => ({ value, error: '' }), error => ({ error: String(error) }));
    try {
      let active = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        await execute(inspector, [await native(result)], { windowsHide: true, timeout: 3000 });
        const windows: { title: string; foreground: boolean; minimized: boolean }[] = JSON.parse(await fs.readFile(result, 'utf8'));
        active = windows.some(window => window.title.startsWith(purpose === 'create' ? '创建研究项目' : '打开已有项目') && window.foreground && !window.minimized);
        if (active) break;
      }
      assert.ok(active, `${purpose} must be visible in the foreground, not merely present in the taskbar`);
    } finally {
      const started = Date.now(); controller.abort(); const completed = await pending; clearTimeout(timeout);
      assert.match(completed.error, /已取消位置选择/);
      assert.ok(Date.now() - started < 3000, 'Cancellation must close the Windows dialog without the kill fallback');
    }
  }
});

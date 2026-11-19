import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { contentHash } from './store.js';
import { paperTypes } from './types.js';

export interface InitDocument { path: string; hash: string; text: string; bytes: number }
const skip = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '__pycache__', 'data', 'datasets', 'results', 'logs', 'coverage']);
const secret = /(?:secret|credential|password|token|private[-_]?key|\.local\.)/i;
const execute = promisify(execFile);

export async function scanProject(root: string, signal: AbortSignal, progress: (count: number) => Promise<void>) {
  const files: string[] = []; let skipped = 0; let visits = 0;
  async function walk(directory: string, depth: number) {
    signal.throwIfAborted();
    if (depth > 5 || visits >= 3000) { skipped++; return; }
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted(); if (++visits > 3000) { skipped++; break; }
      if (entry.name.startsWith('.') || skip.has(entry.name) || secret.test(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
      const name = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && name !== 'project.json') files.push(name);
      if (visits % 100 === 0) await progress(files.length);
    }
  }
  await walk('', 0);
  // Honor repository ignores without executing project code, scripts, or hooks.
  let ignored = new Set<string>();
  if (files.length) {
    try {
      const { stdout } = await execute('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout: 3000, maxBuffer: 1024 * 1024, signal });
      ignored = new Set(stdout.split('\0').filter(Boolean));
    } catch { /* Ordinary research folders need not be Git repositories. */ }
  }
  const kept = files.filter(file => !ignored.has(file)); skipped += files.length - kept.length;
  return { files: kept, skipped };
}
export function documentPaths(files: string[]) {
  return files.filter(file => /\.(md|rst|txt|tex)$/i.test(file) || /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|Makefile)$/i.test(file))
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 12);
}
function score(file: string) { return /^readme\./i.test(file) ? 0 : file === 'AGENTS.md' ? 1 : /(^|\/)(paper|manuscript|research|proposal|problem|plan)[^/]*\.(md|tex)$/i.test(file) ? 2 : file.includes('/') ? 4 : 3; }
export async function readDocument(root: string, file: string, secretValues: string[]): Promise<InitDocument | null> {
  const target = path.join(root, file);
  // Reject replaced/symlinked ancestors as well as symlinked final files.
  if (await fs.realpath(target) !== target) return null;
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const bytes = await handle.readFile(); if (bytes.includes(0)) return null;
    let text = bytes.toString('utf8').replace(/\r\n/g, '\n');
    for (const value of secretValues.filter(Boolean)) text = text.split(value).join('[REDACTED]');
    text = text.split('\n').map(line => /(?:api[ _-]?key|access[_ -]?token|password|authorization|BEGIN.*PRIVATE KEY)\s*[:=]?/i.test(line) ? '[REDACTED]' : line).join('\n').slice(0, 16000);
    return { path: file, hash: contentHash(bytes.toString('utf8')), text, bytes: bytes.length };
  } finally { await handle.close(); }
}
const proof = z.object({ file: z.string().min(1).max(1024), quote: z.string().min(3).max(2000) }).strict();
export const findingSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('seedPapers'), value: z.object({ kind: z.enum(['paper', 'direction', 'engineering_problem']), title: z.string().trim().min(1).max(500) }).strict(), evidence: proof }).strict(),
  z.object({ field: z.literal('paperType'), value: z.enum(paperTypes), evidence: proof }).strict(),
  z.object({ field: z.literal('targetJournal'), value: z.object({ name: z.string().trim().min(1).max(300) }).strict(), evidence: proof }).strict(),
]);
export type InitFinding = z.infer<typeof findingSchema>;
export const extractionSchema = z.object({ findings: z.array(findingSchema).max(12) }).strict();
const typeNames: Record<string, string> = { method: 'method', system: 'system', benchmark: 'benchmark', empirical: 'empirical', replication: 'replication', theory: 'theory', survey: 'survey', position: 'position', 方法: 'method', 系统: 'system', 基准: 'benchmark', 实证: 'empirical', 复现: 'replication', 理论: 'theory', 综述: 'survey', 观点: 'position' };
export function explicitFindings(doc: InitDocument): InitFinding[] {
  const found: InitFinding[] = []; const lines = doc.text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const type = line.match(/^(?:[#*\s-]*)(?:paper type|contribution type|论文类型)\s*[:：]\s*([^\s*]+)[\s*]*$/i);
    if (type && typeNames[type[1].toLowerCase()]) found.push({ field: 'paperType', value: typeNames[type[1].toLowerCase()] as typeof paperTypes[number], evidence: { file: doc.path, quote: line } });
    const venue = line.match(/^(?:[#*\s-]*)(?:target (?:venue|journal|conference)|目标(?:会议|期刊|会议\s*[/／]\s*期刊))\s*[:：]\s*(.+?)\s*$/i);
    if (venue && venue[1].length <= 300 && !/^(?:TBD|unknown|未定|待定|尚未确定)$/i.test(venue[1])) found.push({ field: 'targetJournal', value: { name: venue[1] }, evidence: { file: doc.path, quote: line } });
    const label = /(?:research (?:question|direction|objective)|problem statement|engineering problem|研究问题|研究方向|研究目标|工程问题)/i;
    if (!label.test(line) || !/^(?:#{1,6}\s|(?:research |problem |engineering |研究|工程))/i.test(line)) continue;
    const inline = line.match(/[:：]\s*(.+)$/); let title = inline?.[1]?.trim(); let quote = line;
    if (!title && /^#{1,6}\s/.test(line)) {
      const next = lines.slice(index + 1, index + 4).find(value => value.trim());
      if (next && !/^#|^```/.test(next)) { title = next.trim().replace(/^[-*]\s+/, ''); quote = lines.slice(index, lines.indexOf(next, index + 1) + 1).join('\n'); }
    }
    if (title && title.length <= 500 && !title.includes('[REDACTED]')) found.push({ field: 'seedPapers', value: { kind: /engineering|工程/i.test(line) ? 'engineering_problem' : 'direction', title }, evidence: { file: doc.path, quote } });
  }
  return found.slice(0, 12);
}
export function groundedFinding(doc: InitDocument, finding: InitFinding) {
  if (finding.evidence.file !== doc.path || !doc.text.includes(finding.evidence.quote) || finding.evidence.quote.includes('[REDACTED]')) return false;
  if (finding.field === 'seedPapers') return finding.evidence.quote.includes(finding.value.title);
  // Contribution type and venue are commitments: only explicit labelled declarations qualify.
  return explicitFindings(doc).some(item => item.field === finding.field && JSON.stringify(item.value) === JSON.stringify(finding.value) && item.evidence.quote === finding.evidence.quote);
}

export async function supplementAgents(root: string, files: string[]): Promise<'created' | 'supplemented' | 'preserved'> {
  const marker = '<!-- research-loop:project-orientation -->';
  const body = `\n\n${marker}\n## Project orientation\n\nThis orientation was generated from the local file inventory. Existing human-authored rules remain authoritative.\n\n- Read the project documentation before changing implementation or research claims.\n- Use the persisted research seeds and venue preferences; unresolved metadata is intentionally blank.\n- Opening this folder initializes context only. Start research only on the user's explicit request.\n- Preserve source data, existing instructions and human edits. Do not infer topic approval from initialization.\n\nObserved documentation:\n${documentPaths(files).map(file => '- ' + file.replace(/[\r\n`<>]/g, '')).join('\n') || '- No supported text documentation found; ask for missing context when needed.'}\n\nRuntime records: project.json and .research-loop/. Initialization progress and source provenance are recorded there.\n<!-- /research-loop:project-orientation -->\n`;
  const target = path.join(root, 'AGENTS.md');
  try { await fs.writeFile(target, '# Project instructions\n' + body, { flag: 'wx', mode: 0o600 }); return 'created'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('AGENTS.md must be a regular project file');
  const existing = await fs.readFile(target, 'utf8');
  if (existing.includes(marker)) return 'preserved';
  // Append, never a read/replace write: edits made while initialization runs stay intact.
  const handle = await fs.open(target, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
  try { await handle.write(body); await handle.sync(); } finally { await handle.close(); }
  return 'supplemented';
}

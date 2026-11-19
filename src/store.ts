import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { defaultMode, researchInputsSchema, type Config, type Identity, type State, type ResearchInputValues } from './types.js';

export function hash(file: string): string { return 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function contentHash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function atomic(file: string, data: unknown): void {
  atomicText(file, JSON.stringify(data, null, 2) + '\n');
}
function atomicText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function local(root: string, name: string): string {
  const target = path.resolve(root, name);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  const relative = path.relative(fs.realpathSync(root), actual);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Path outside project: ${name}`);
  return actual;
}
export function identity(pid = process.pid): Identity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    if (stat[0] === 'Z') return undefined;
    return { pid, start: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat[19] };
  } catch { return undefined; }
}
export function alive(w?: Identity): boolean { return !!w && identity(w.pid)?.start === w.start; }
export function event(s: State, type: string, data: Record<string, unknown> = {}): void {
  s.events.push({ seq: s.events.length + 1, time: new Date().toISOString(), type, data });
}
// Share the queue across Store instances so heartbeat writes cannot overtake
// already-waiting model, tool or dashboard updates in the same process.
const transactions = new Map<string, Promise<void>>();
export function isLockContention(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}
export class Store {
  readonly file: string; readonly root: string; readonly runtime: string;
  constructor(file: string) { this.file = path.resolve(file); this.root = path.dirname(this.file); this.runtime = path.join(this.root, '.research-loop'); }
  read(): State { return JSON.parse(fs.readFileSync(this.file, 'utf8')).agentLoop; }
  async transaction<T>(fn: (record: Record<string, unknown>) => T): Promise<T> {
    const previous = transactions.get(this.file) ?? Promise.resolve();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    transactions.set(this.file, pending);
    await previous;
    try { return await this.lockedTransaction(fn); }
    finally {
      finish();
      if (transactions.get(this.file) === pending) transactions.delete(this.file);
    }
  }
  private async lockedTransaction<T>(fn: (record: Record<string, unknown>) => T): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true });
    const release = await lockfile.lock(this.file, { realpath: false, stale: 10000, update: 2000, retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } });
    try {
      const before = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : undefined;
      const record = before === undefined ? {} : JSON.parse(before);
      const result = fn(record);
      const after = JSON.stringify(record, null, 2) + '\n';
      // Reconciliation and blocked dispatch often leave state unchanged. Avoid
      // replacing and fsyncing the entire project for these polling operations.
      if (after !== before) atomicText(this.file, after);
      return result;
    } finally { await release(); }
  }
  update<T>(fn: (state: State) => T): Promise<T> { return this.transaction(r => fn(r.agentLoop as State)); }
  async init(goal: string, config: Config, mode: State['mode'] = defaultMode, inputs?: ResearchInputValues, prepare?: (state: State) => void): Promise<void> {
    const initialInputs = inputs === undefined ? undefined : researchInputsSchema.parse(inputs);
    await this.transaction(record => {
      if (record.agentLoop) throw new Error('Runtime already exists in this project record');
      const state: State = { version: 1, goal, config, mode, topic: { version: 0, status: 'UNSELECTED' }, tasks: {}, sessions: {}, sources: {}, claims: {}, challenges: {}, edges: [], events: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, unknownRequests: 0 } };
      state.researchInputs = initialInputs ? { ...initialInputs, paperType: initialInputs.paperType ?? null, revision: 1, updatedAt: new Date().toISOString() } : { paperType: null, seedPapers: [], targetJournal: null, revision: 0 };
      event(state, 'project_initialized', { goal, mode }); prepare?.(state); record.agentLoop = state;
    });
  }
}

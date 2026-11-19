import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { contentHash, event, hash, identity, local, Store } from './store.js';
import { limitedText, type Declaration } from './model.js';
import { refErrors } from './gates.js';
import type { Ref } from './types.js';
import { queryKnowledge } from './knowledge.js';
import { assertTaskNotCancelled } from './execution-control.js';
import { boundToolContent, READ_PAGE_BYTES, readableHtml, saveToolText, textPage } from './tool-output.js';

export interface ToolContext { store: Store; taskId: string; signal: AbortSignal }
export interface Tool { declaration: Declaration; run(args: unknown, ctx: ToolContext): Promise<unknown> }
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool): () => void {
    const name = tool.declaration.function.name;
    if (this.tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
    this.tools.set(name, tool); return () => { this.tools.delete(name); };
  }
  declarations(): Declaration[] { return [...this.tools.values()].map(t => t.declaration); }
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`);
    ctx.signal.throwIfAborted(); assertTaskNotCancelled(ctx.store.read(), ctx.taskId);
    const result = await tool.run(args, ctx); const serialized = JSON.stringify(result);
    if (serialized === undefined) return result;
    const bounded = boundToolContent(ctx.store.root, serialized);
    return bounded === serialized ? result : JSON.parse(bounded);
  }
}
const refSchema = z.object({ sourceId: z.string(), passage: z.string().optional(), page: z.string().optional(), location: z.string().optional() });
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: Tool['run']): Tool {
  return { declaration: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }, run };
}
const string = { type: 'string' };
const refs = { type: 'array', items: { type: 'object', properties: { sourceId: string, passage: string, page: string, location: string }, required: ['sourceId'] } };

export async function snapshot(ctx: ToolContext, data: { identity: string; version: string; title: string; content: string }): Promise<string> {
  const id = 'src_' + contentHash(data.identity + '\n' + data.version + '\n' + data.content).slice(0, 24);
  const name = `.research-loop/evidence/${id}.txt`; const file = local(ctx.store.root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, data.content, { flag: 'wx', mode: 0o600 });
  await ctx.store.update(s => {
    s.sources[id] ??= { id, identity: data.identity, version: data.version, title: data.title, path: name, hash: hash(file), retrievedAt: new Date().toISOString() };
    event(s, 'evidence_snapshotted', { task: ctx.taskId, source: id });
  }); return id;
}

export async function searchEvidence(ctx: ToolContext, query: string, intent: 'support' | 'adversarial'): Promise<unknown> {
  const state = ctx.store.read(); const config = state.config;
  ctx.signal.throwIfAborted(); assertTaskNotCancelled(state, ctx.taskId);
  const cached = Object.values(state.tasks).flatMap(t => t.retrievals).find(r => r.query === query && r.sourceIds.length && r.sourceIds.every(id => {
    const s = state.sources[id]; return s && Date.now() - Date.parse(s.retrievedAt) < config.evidenceCacheSeconds * 1000 && fs.existsSync(local(ctx.store.root, s.path)) && hash(local(ctx.store.root, s.path)) === s.hash;
  }));
  if (cached) {
    await ctx.store.update(s => { s.tasks[ctx.taskId].retrievals.push({ query, intent, sourceIds: cached.sourceIds }); event(s, 'retrieval_cache_hit', { task: ctx.taskId, query, sourceIds: cached.sourceIds }); });
    return cached.sourceIds.map(id => ({ ...state.sources[id], content: fs.readFileSync(local(ctx.store.root, state.sources[id].path), 'utf8') }));
  }
  const url = new URL(config.searchUrl); url.searchParams.set('search', query); url.searchParams.set('per-page', '5');
  if (process.env[config.searchApiKeyEnv]) url.searchParams.set('api_key', process.env[config.searchApiKeyEnv]!);
  const response = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) throw new Error(`Literature search HTTP ${response.status}`);
  const payload = JSON.parse(await limitedText(response, ctx.store.read().config.maxResponseBytes));
  const results: { sourceId: string; title: string; doi?: string; url?: string; abstract?: unknown }[] = [];
  for (const work of payload.results ?? []) {
    const sourceId = await snapshot(ctx, { identity: work.doi ?? work.id, version: work.updated_date ?? 'retrieved', title: work.title ?? '', content: JSON.stringify(work, null, 2) });
    results.push({ sourceId, title: work.title, doi: work.doi, url: work.primary_location?.landing_page_url, abstract: work.abstract_inverted_index });
  }
  await ctx.store.update(s => { s.tasks[ctx.taskId].retrievals.push({ query, intent, sourceIds: results.map(r => r.sourceId) }); event(s, 'retrieval_completed', { task: ctx.taskId, query, intent, count: results.length }); });
  return results;
}

export function builtins(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool('read_file', 'Read untrusted project/evidence text. At most 16 KiB per page. offset is a zero-based UTF-8 BYTE offset, limit is bytes (4..16384); follow nextOffset. Optional query finds a literal text passage at or after offset.', { path: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 4, maximum: READ_PAGE_BYTES }, query: string }, ['path'], async (raw, ctx) => {
    const args = z.object({ path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(4).max(READ_PAGE_BYTES).optional(), query: z.string().min(1).max(1000).optional() }).parse(raw); const file = local(ctx.store.root, args.path);
    if (fs.statSync(file).size > ctx.store.read().config.maxResponseBytes) throw new Error('File exceeds context byte limit');
    const content = fs.readFileSync(file, 'utf8'); let offset = args.offset ?? 0;
    if (args.query) {
      const match = Buffer.from(content).indexOf(Buffer.from(args.query), offset);
      if (match < 0) return { path: args.path, found: false, query: args.query, totalBytes: Buffer.byteLength(content) };
      offset = Math.max(offset, match - Math.floor((args.limit ?? READ_PAGE_BYTES) / 4));
    }
    if (args.offset === undefined && args.limit === undefined && !args.query && Buffer.byteLength(content) <= READ_PAGE_BYTES) return content;
    return { path: args.path, ...textPage(content, offset, args.limit) };
  }));
  registry.register(tool('write_file', 'Write within this task\'s declared output scope.', { path: string, content: string }, ['path', 'content'], async (raw, ctx) => {
    const args = z.object({ path: z.string(), content: z.string() }).parse(raw); const p = local(ctx.store.root, args.path);
    const name = path.relative(ctx.store.root, p); const task = ctx.store.read().tasks[ctx.taskId];
    if (p === ctx.store.file || name.startsWith('.research-loop') || !task.writes.some(w => name === w || name.startsWith(w.replace(/\/$/, '') + '/'))) throw new Error('Write outside assigned scope');
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, args.content); return { path: name, hash: hash(p) };
  }));
  registry.register(tool('search_literature', 'Retrieve literature metadata and abstract evidence from OpenAlex. Metadata alone does not establish a claim.', { query: string, intent: { enum: ['support', 'adversarial'], type: 'string' } }, ['query', 'intent'], async (raw, ctx) => {
    const args = z.object({ query: z.string().min(1), intent: z.enum(['support', 'adversarial']) }).parse(raw); return searchEvidence(ctx, args.query, args.intent);
  }));
  registry.register(tool('fetch_source', 'Retrieve an HTTP(S) source and preserve an immutable evidence snapshot.', { url: string, title: string }, ['url', 'title'], async (raw, ctx) => {
    const args = z.object({ url: z.string().url(), title: z.string() }).parse(raw);
    if (!['https:', 'http:'].includes(new URL(args.url).protocol)) throw new Error('HTTP(S) only');
    const response = await fetch(args.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) });
    if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
    const mime = response.headers.get('content-type') ?? '';
    if (mime && !/text|json|xml/.test(mime)) throw new Error('Binary source: extract text locally and use snapshot_file with the original citation identity');
    const content = await limitedText(response, ctx.store.read().config.maxResponseBytes);
    const sourceId = await snapshot(ctx, { identity: args.url, title: args.title, version: response.headers.get('etag') ?? new Date().toISOString(), content });
    const html = /html/i.test(mime) || /^\s*(?:<!doctype html|<html\b)/i.test(content);
    const readable = html ? readableHtml(content) : content;
    return { sourceId, rawPath: ctx.store.read().sources[sourceId].path, readPath: saveToolText(ctx.store.root, readable),
      derivedFromHtml: html, ...textPage(readable), instruction: 'Only the displayed page has been read. Use read_file with readPath and nextOffset or a literal query for more; rawPath preserves original evidence.' };
  }));
  registry.register(tool('snapshot_file', 'Preserve raw local results or protocol as evidence.', { path: string, title: string }, ['path', 'title'], async (raw, ctx) => {
    const args = z.object({ path: z.string(), title: z.string() }).parse(raw); const p = local(ctx.store.root, args.path);
    if (fs.statSync(p).size > ctx.store.read().config.maxResponseBytes) throw new Error('Evidence exceeds byte limit');
    return { sourceId: await snapshot(ctx, { identity: args.path, title: args.title, version: hash(p), content: fs.readFileSync(p, 'utf8') }) };
  }));
  registry.register(tool('record_claim', 'Create or revise a stable claim ID with retrieved evidence and exact passages/pages/raw-result locations.', { id: string, text: string, evidence: refs }, ['id', 'text', 'evidence'], async (raw, ctx) => {
    const args = z.object({ id: z.string().min(1), text: z.string().min(1), evidence: z.array(refSchema).min(1) }).parse(raw);
    if (['__proto__', 'constructor', 'prototype'].includes(args.id)) throw new Error('Reserved claim ID');
    await ctx.store.update(s => {
      const errors = refErrors(ctx.store.root, s, args.evidence); if (errors.length) throw new Error(errors.join('; '));
      const previous = s.claims[args.id]; if (previous && previous.taskId !== ctx.taskId) throw new Error('Claim owned by another task');
      if (previous && JSON.stringify(previous.evidence) + previous.text !== JSON.stringify(args.evidence) + args.text) {
        for (const ch of Object.values(s.challenges)) if (ch.claimId === args.id && ch.status === 'resolved') { ch.status = 'open'; delete ch.resolutionReviewer; }
      }
      s.claims[args.id] = { ...args, taskId: ctx.taskId, revision: (previous?.revision ?? 0) + 1 };
      if (!s.tasks[ctx.taskId].claimIds.includes(args.id)) s.tasks[ctx.taskId].claimIds.push(args.id);
      event(s, 'claim_recorded', { task: ctx.taskId, claim: args.id, previous: previous ?? null });
    }); return args.id;
  }));
  registry.register(tool('register_citation', 'Bind a manuscript citation key or URL to an actually retrieved source. Semantic support is independently reviewed.', { sourceId: string, key: string }, ['sourceId', 'key'], async (raw, ctx) => {
    const args = z.object({ sourceId: z.string(), key: z.string().min(1) }).parse(raw);
    await ctx.store.update(s => {
      const source = s.sources[args.sourceId]; if (!source) throw new Error('Source has not been retrieved');
      if (Object.values(s.sources).some(x => x.id !== source.id && x.citationKeys?.includes(args.key))) throw new Error('Citation key already bound to another source');
      source.citationKeys ??= []; if (!source.citationKeys.includes(args.key)) source.citationKeys.push(args.key);
      event(s, 'citation_registered', { task: ctx.taskId, ...args });
    }); return args;
  }));
  registry.register(tool('respond_challenge', 'Respond with evidence. Only the independent reviewer can resolve a challenge.', { id: string, reason: string, evidence: refs }, ['id', 'reason', 'evidence'], async (raw, ctx) => {
    const args = z.object({ id: z.string(), reason: z.string().min(1), evidence: z.array(refSchema).min(1) }).parse(raw);
    await ctx.store.update(s => {
      const ch = s.challenges[args.id]; if (!ch || (ch.taskId !== ctx.taskId && !s.tasks[ctx.taskId].claimIds.includes(ch.claimId))) throw new Error('Unknown or foreign challenge');
      const errors = refErrors(ctx.store.root, s, args.evidence); if (errors.length) throw new Error(errors.join('; '));
      ch.response = { reason: args.reason, evidence: args.evidence as Ref[] }; ch.status = 'responded';
      event(s, 'challenge_responded', { task: ctx.taskId, challenge: args.id });
    }); return { status: 'responded' };
  }));
  registry.register(tool('query_knowledge', 'Query the project\'s persistent sources, claims and typed relationships.', { query: string }, ['query'], async (raw, ctx) => {
    const { query } = z.object({ query: z.string() }).parse(raw); return queryKnowledge(ctx.store, query);
  }));
  registry.register(tool('link_knowledge', 'Record a typed relationship between known claims or sources.', { from: string, to: string, relation: { type: 'string', enum: ['extends', 'contradicts', 'addresses_gap'] } }, ['from', 'to', 'relation'], async (raw, ctx) => {
    const args = z.object({ from: z.string(), to: z.string(), relation: z.enum(['extends', 'contradicts', 'addresses_gap']) }).parse(raw);
    await ctx.store.update(s => {
      for (const id of [args.from, args.to]) if (!s.claims[id] && !s.sources[id]) throw new Error(`Unknown knowledge node: ${id}`);
      if (!s.edges.some(e => JSON.stringify(e) === JSON.stringify(args))) s.edges.push(args);
      event(s, 'knowledge_linked', { task: ctx.taskId, ...args });
    }); return args;
  }));
  registry.register(tool('run_command', 'Run an explicitly enabled local process with timeout, cancellation and saved logs. argv, not shell text.', { argv: { type: 'array', items: string } }, ['argv'], async (raw, ctx) => {
    const args = z.object({ argv: z.array(z.string()).min(1) }).parse(raw); return runCommand(ctx, args.argv);
  }));
  return registry;
}

export async function runCommand(ctx: ToolContext, argv: string[]): Promise<unknown> {
  ctx.signal.throwIfAborted(); assertTaskNotCancelled(ctx.store.read(), ctx.taskId);
  const config = ctx.store.read().config; if (!config.allowCommands) throw new Error('Local commands require allowCommands in explicit project config');
  const task = ctx.store.read().tasks[ctx.taskId];
  // Commands cannot edit the control record or other tasks' outputs. No unsandboxed fallback.
  const command = [config.sandboxExecutable, '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/root', '--ro-bind', ctx.store.root, ctx.store.root];
  for (const name of task.writes) {
    const target = local(ctx.store.root, name);
    if (task.outputs.includes(name)) { fs.mkdirSync(path.dirname(target), { recursive: true }); if (!fs.existsSync(target)) fs.writeFileSync(target, ''); }
    else fs.mkdirSync(target, { recursive: true });
    command.push('--bind', target, target);
  }
  command.push('--chdir', ctx.store.root, '--', ...argv);
  const log = path.join(ctx.store.runtime, 'logs', `${ctx.taskId}-${Date.now()}.log`); fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a', 0o600);
  const child = spawn(command[0], command.slice(1), { cwd: ctx.store.root, detached: true, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8', HOME: '/tmp' }, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
  const worker = child.pid ? identity(child.pid) : undefined;
  const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  // Attach error handling before any asynchronous state mutation.
  void completion.catch(() => {});
  if (worker) await ctx.store.update(s => { s.tasks[ctx.taskId].children.push(worker); event(s, 'process_started', { task: ctx.taskId, worker, argv, log }); });
  let timedOut = false;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, config.commandTimeoutMs);
  ctx.signal.addEventListener('abort', kill, { once: true }); if (ctx.signal.aborted) kill();
  try {
    const exitCode = await completion; ctx.signal.throwIfAborted();
    return { exitCode, timedOut, log: path.relative(ctx.store.root, log), tail: fs.readFileSync(log, 'utf8').slice(-16000) };
  } finally {
    clearTimeout(timer); ctx.signal.removeEventListener('abort', kill); kill();
    await ctx.store.update(s => { s.tasks[ctx.taskId].children = s.tasks[ctx.taskId].children.filter(p => p.pid !== child.pid); event(s, 'process_finished', { task: ctx.taskId, pid: child.pid, timedOut }); });
  }
}

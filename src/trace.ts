import type { Message, RuntimeEvent, State } from './types.js';
import type { TraceCategory, TraceDetail, TraceEntry, TracePage } from '../web/types.js';

export class TraceNotFound extends Error {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
interface IndexedEvent { event: RuntimeEvent; task?: string; session?: string; attempt?: number; start?: IndexedEvent }

function category(type: string): TraceCategory {
  if (type.startsWith('model_')) return 'model';
  if (/^(tool_|process_)/.test(type)) return 'tool';
  if (/retrieval|research_input_lookup|evidence_snapshotted|citation_registered/.test(type)) return 'retrieval';
  if (/^independent_review/.test(type)) return 'review';
  if (/check|acceptance_blocked|validation_feedback|claim_recorded|challenge_responded/.test(type)) return 'check';
  return 'lifecycle';
}

function operation(event: RuntimeEvent, task?: string, attempt?: number): string | undefined {
  const d = event.data; const prefix = `${task ?? ''}:${attempt ?? ''}:`;
  if (event.type.startsWith('model_request_') && string(d.requestId)) return `model:${d.requestId}`;
  if (event.type.startsWith('tool_')) return `${prefix}tool:${object(d.call).id ?? d.id}`;
  if (event.type.startsWith('research_input_lookup_')) return `${prefix}lookup:${d.key}`;
  if (event.type.startsWith('deterministic_check_')) return `${prefix}check:${d.check}`;
  if (event.type.startsWith('independent_review_')) return `${prefix}review:${d.session}`;
  if (event.type.startsWith('process_')) return `${prefix}process:${object(d.worker).pid ?? d.pid}`;
  return undefined;
}

/** Follow event-time ownership; a shared session's latest task is not its entire history. */
function indexEvents(state: State): IndexedEvent[] {
  const active = new Map<string, string>(); const attempts = new Map<string, number>(); const operations = new Map<string, IndexedEvent>();
  const owners = new Map<string, string[]>();
  for (const task of Object.values(state.tasks)) {
    owners.set(task.session, [...(owners.get(task.session) ?? []), task.id]);
    if (task.reviewSession) owners.set(task.reviewSession, [task.id]);
  }
  return state.events.map(event => {
    const d = event.data; let session = string(d.sessionId) ?? string(d.session);
    const direct = string(d.task); let task = direct && Object.hasOwn(state.tasks, direct) ? direct : undefined;
    const requestStart = string(d.requestId) ? operations.get(`model:${d.requestId}`) : undefined;
    session ??= requestStart?.session;
    task ??= requestStart?.task ?? (session ? active.get(session) ?? (owners.get(session)?.length === 1 ? owners.get(session)![0] : undefined) : undefined);
    if (task && event.type === 'task_dispatched') attempts.set(task, integer(d.attempt) ?? (attempts.get(task) ?? 0) + 1);
    const attempt = integer(d.attempt) ?? requestStart?.attempt ?? (task ? attempts.get(task) : undefined);
    if (task && ['task_dispatched', 'worker_started', 'skills_loaded'].includes(event.type)) active.set(session ?? state.tasks[task].session, task);
    if (task && event.type === 'independent_review_started' && session) active.set(session, task);
    const key = operation(event, task, attempt);
    const item: IndexedEvent = { event, task, session, attempt };
    if (key && event.type.endsWith('_started')) operations.set(key, item);
    else if (key) item.start = operations.get(key);
    if (task && event.type === 'worker_finished') {
      const sessionId = state.tasks[task].session; if (active.get(sessionId) === task) active.delete(sessionId);
    }
    return item;
  });
}

/** Redact configured credentials and conventional credential fields before returning text. */
function redactor(state: State) {
  const secrets = [state.config.executor.apiKeyEnv, state.config.reviewer.apiKeyEnv, state.config.searchApiKeyEnv].map(name => process.env[name]).filter((value): value is string => !!value);
  return (text: string): string => {
    for (const secret of secrets) for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join('[REDACTED]');
    return text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:api[_-]?key|access_token|token|secret|password)=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
      .replace(/((?:"|')?(?:api[_-]?key|access_token|password|secret|authorization)(?:"|')?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, '$1[REDACTED]');
  };
}
function projectEntry(item: IndexedEvent, redact: (text: string) => string): TraceEntry {
  const { event, task, session, attempt, start } = item; const d = event.data; const first = start?.event.data ?? d;
  const toolName = string(object(object(first.call).function).name);
  const failures = Array.isArray(d.errors) ? d.errors.filter(x => typeof x === 'string') : [];
  const resultError = object(d.result).error;
  let status: TraceEntry['status'] = 'info';
  if (event.type.endsWith('_started') || event.type === 'task_dispatched') status = 'started';
  if (event.type.endsWith('_completed') || event.type === 'task_accepted' || event.type === 'worker_finished') status = 'completed';
  if (event.type.endsWith('_failed') || d.passed === false || resultError || d.error || d.timedOut || ['ERROR', 'FAIL'].includes(String(d.verdict))) status = 'failed';
  if (event.type === 'acceptance_blocked' || d.verdict === 'BLOCKED') status = 'blocked';
  if (d.uncertain === true || event.type === 'worker_interrupted') status = 'uncertain';
  const fragments = [toolName, d.query, d.key, d.check, d.verdict, d.message, d.reason, d.error, resultError, ...failures.slice(0, 2)].filter(x => typeof x === 'string');
  const summary = redact(fragments.join(' · ')).slice(0, 600);
  const elapsed = start && /_(completed|failed|finished)$/.test(event.type) ? Date.parse(event.time) - Date.parse(start.event.time) : undefined;
  const usage = object(d.usage);
  return {
    seq: event.seq, time: event.time, type: event.type, task, session, attempt, category: category(event.type), status, summary,
    ...(elapsed !== undefined && Number.isFinite(elapsed) ? { durationMs: Math.max(0, elapsed) } : {}),
    model: string(first.model) === undefined ? undefined : redact(String(first.model)), phase: string(first.phase),
    ...(Object.keys(usage).length ? { tokens: { input: integer(usage.prompt_tokens) ?? 0, output: integer(usage.completion_tokens) ?? 0 } } : {}),
  };
}

export function traceEntries(state: State): TraceEntry[] {
  const redact = redactor(state); return indexEvents(state).map(item => projectEntry(item, redact));
}

export function tracePage(state: State, options: { task?: string; category?: TraceCategory; attempt?: number; before?: number; limit?: number } = {}): TracePage {
  if (options.task && !Object.hasOwn(state.tasks, options.task)) throw new TraceNotFound('任务不存在。');
  const entries = indexEvents(state).filter(e => (!options.task || e.task === options.task) && (options.attempt === undefined || e.attempt === options.attempt) && (!options.category || category(e.event.type) === options.category));
  const eligible = entries.filter(e => options.before === undefined || e.event.seq < options.before);
  const limit = Math.min(100, Math.max(1, options.limit ?? 80)); const page = eligible.slice(-limit); const redact = redactor(state);
  return { entries: page.map(e => projectEntry(e, redact)), total: entries.length, nextBefore: eligible.length > page.length ? page[0].event.seq : null, latestSeq: state.events.at(-1)?.seq ?? 0 };
}

export function traceDetail(state: State, seq: number, task?: string): TraceDetail {
  const index = indexEvents(state); const item = index.find(e => e.event.seq === seq);
  if (!item || (task && item.task !== task)) throw new TraceNotFound('此任务中没有对应的 Trace 步骤。');
  const start = item.start ?? item;
  const end = item.start ? item : index.find(e => e.start === item);
  const redact = redactor(state); const notes: string[] = []; const sections: TraceDetail['sections'] = [];
  const section = (title: string, value: unknown) => {
    let clipped = false;
    const clean = (value: unknown, depth = 0): unknown => {
      if (typeof value === 'string') {
        const safe = redact(value); if (safe.length > 40000) clipped = true; return safe.slice(0, 40000);
      }
      if (depth > 10) { clipped = true; return '[nested content omitted]'; }
      if (Array.isArray(value)) { if (value.length > 100) clipped = true; return value.slice(0, 100).map(v => clean(v, depth + 1)); }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value); if (entries.length > 100) clipped = true;
        return Object.fromEntries(entries.slice(0, 100).map(([key, v]) => [key, /^(?:authorization|api[_-]?key|apiKeyEnv|access_token|token|password|secret|reasoning_content|reasoning|thinking)$/i.test(key) ? '[REDACTED]' : clean(v, depth + 1)]));
      }
      return value;
    };
    const content = clean(value); const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2) ?? '';
    const bytes = Buffer.from(raw); const max = 32 * 1024;
    sections.push({ title, text: bytes.subarray(0, max).toString('utf8'), truncated: clipped || bytes.length > max });
  };
  section('事件记录', item.event.data);
  if (category(item.event.type) === 'model') {
    const messages = start.session ? state.sessions[start.session]?.messages : undefined;
    const count = integer(start.event.data.messageCount); const responseIndex = integer(end?.event.data.responseIndex);
    const message = (m: Message) => ({ role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) });
    if (messages && count !== undefined && count <= messages.length) {
      const overrides = new Map<number, string>();
      if (Array.isArray(start.event.data.messageOverrides)) for (const override of start.event.data.messageOverrides) {
        if (override && Number.isInteger(override.index) && typeof override.content === 'string') overrides.set(override.index, override.content);
      }
      const first = Math.max(0, count - 100);
      section('发送给模型的消息', messages.slice(first, count).map((m, index) => message(overrides.has(first + index) ? { ...m, content: overrides.get(first + index)! } : m)));
      if (count > 100) notes.push(`此请求包含 ${count} 条消息，仅展示最后 100 条。`);
    } else notes.push('此记录未保存有效的请求消息边界，无法还原当时的完整输入。');
    if (messages && responseIndex !== undefined && messages[responseIndex]?.role === 'assistant') section('模型返回', message(messages[responseIndex]));
    else notes.push(end?.event.type === 'model_request_failed' ? '模型请求失败，未记录可用的返回内容。' : '此步骤尚无可定位的模型返回内容。');
  } else if (item.event.type.startsWith('tool_')) {
    if (start.event.data.call) section('工具调用与参数', start.event.data.call);
    if (end && Object.hasOwn(end.event.data, 'result')) section('工具结果', end.event.data.result);
  } else if (start !== item) section('对应的开始记录', start.event.data);
  return { entry: projectEntry(item, redact), sections, notes };
}

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { event, Store } from './store.js';
import type { Message, Route, State } from './types.js';
import { assertTaskNotCancelled } from './execution-control.js';
import { computeContextBudget, compactSession, maybeCompactProactively } from './context-budget.js';
import { taskTimeLimit } from './resource-budgets.js';

export class Limited extends Error {}
export class UncertainDispatch extends Error {}

export type ModelErrorCategory =
  | 'rate_limit'
  | 'provider_outage'
  | 'authentication'
  | 'invalid_request'
  | 'context_overflow'
  | 'uncertain_transport'
  | 'unknown_http';

export interface TypedErrorDetails {
  category: ModelErrorCategory;
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  requestId?: string;
  code?: string;
  param?: string;
}

export class TypedModelError extends Error {
  readonly category: ModelErrorCategory;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly code?: string;
  readonly param?: string;

  constructor(message: string, details: TypedErrorDetails) {
    super(message);
    this.name = 'TypedModelError';
    this.category = details.category;
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
    this.requestId = details.requestId;
    this.code = details.code;
    this.param = details.param;
  }
}

export interface Declaration { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelReply { message: Message; usage?: { prompt_tokens?: number; completion_tokens?: number } }
export interface Model { complete(route: Route, messages: Message[], tools: Declaration[], signal: AbortSignal): Promise<ModelReply> }

export function redactSecrets(value: string, secrets: string[] = []): string {
  let out = value;
  for (const secret of new Set(secrets.filter(Boolean).flatMap(s => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]))) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&<>]+)/gi, '$1[REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 2000);
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  return undefined;
}

const CONTEXT_OVERFLOW_RE = /(?:context[_ ]length[_ ]exceeded|maximum context length|too many tokens|token limit|prompt is too long|input length.*exceed|exceeds.*context|context window)/i;

export function classifyHttpFailure(
  status: number,
  options: { retryAfterMs?: number; requestId?: string; code?: string; param?: string; message?: string } = {},
): TypedErrorDetails {
  const signalText = [options.code, options.message].filter(Boolean).join(' ');
  let category: ModelErrorCategory = 'unknown_http';
  let retryable = false;

  if (status === 401 || status === 403) {
    category = 'authentication';
  } else if (status === 429) {
    category = 'rate_limit';
    retryable = true;
  } else if ([500, 502, 503, 504, 529].includes(status)) {
    category = 'provider_outage';
    retryable = true;
  } else if ([400, 413, 422].includes(status) && CONTEXT_OVERFLOW_RE.test(signalText)) {
    category = 'context_overflow';
    retryable = false;
  } else if (status >= 400 && status < 500) {
    category = 'invalid_request';
  }

  return {
    category,
    status,
    retryable,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.code ? { code: options.code } : {}),
    ...(options.param ? { param: options.param } : {}),
  };
}

export async function limitedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('Response exceeds configured byte limit'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Keep provider diagnostics useful without persisting credentials or echoed request objects. */
async function httpFailure(response: Response, key: string, maxBytes: number): Promise<TypedModelError> {
  const safe = (value: string) => redactSecrets(value, [key]);
  const details: string[] = [];
  const rawRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
  const requestId = rawRequestId ? safe(rawRequestId).slice(0, 256) : undefined;
  if (requestId) details.push(`request_id=${requestId}`);
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  if (retryAfterMs !== undefined) details.push(`retry_after_ms=${retryAfterMs}`);

  let code: string | undefined;
  let param: string | undefined;
  let extractedMessage: string | undefined;
  try {
    const body = await limitedText(response, Math.min(maxBytes, 16 * 1024));
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { payload = body; }
    if (typeof payload === 'string') {
      if (payload.trim()) {
        extractedMessage = payload.trimStart().startsWith('<') ? 'HTML error response omitted' : safe(payload);
        details.push(extractedMessage);
      }
    } else if (payload && typeof payload === 'object') {
      const root = payload as Record<string, unknown>;
      const error = root.error ?? root;
      if (typeof error === 'string') {
        extractedMessage = safe(error);
        details.push(extractedMessage);
      } else if (error && typeof error === 'object') {
        const rec = error as Record<string, unknown>;
        for (const field of ['message', 'type', 'code', 'param']) {
          const value = rec[field];
          if (typeof value === 'string' || typeof value === 'number') {
            const sanitized = safe(String(value));
            details.push(`${field}=${sanitized}`);
            if (field === 'message') extractedMessage = sanitized;
            if (field === 'code') code = sanitized;
            if (field === 'param') param = sanitized;
          }
        }
      }
    }
  } catch { details.push('Error response unavailable or exceeds diagnostic byte limit'); }

  const classified = classifyHttpFailure(response.status, { retryAfterMs, requestId, code, param, message: extractedMessage });
  const text = `Model HTTP ${response.status}; no automatic retry${details.length ? '; ' + details.join('; ').slice(0, 3000) : ''}`;
  return new TypedModelError(text, classified);
}

export class HttpModel implements Model {
  constructor(private maxBytes = 4 * 1024 * 1024) {}
  async complete(route: Route, messages: Message[], tools: Declaration[], signal: AbortSignal): Promise<ModelReply> {
    const key = process.env[route.apiKeyEnv];
    if (!key) throw new Error(`Missing credential environment variable: ${route.apiKeyEnv}`);
    const url = new URL(route.baseUrl.replace(/\/$/, '') + '/chat/completions');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw new Error('Model endpoint requires HTTPS outside localhost');
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: route.model, messages, max_tokens: route.maxOutputTokens, ...(tools.length ? { tools } : {}) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(route.requestTimeoutMs)]), redirect: 'error' });
    } catch { throw new UncertainDispatch('Model request transport failed after possible dispatch; no automatic retry or fallback'); }
    if (!response.ok) throw await httpFailure(response, key, this.maxBytes);
    let payload;
    try { payload = JSON.parse(await limitedText(response, this.maxBytes)); }
    catch { throw new UncertainDispatch('Model response incomplete or invalid; dispatch may have been billed'); }
    const choice = payload.choices?.[0]; const message = choice?.message;
    if (choice?.finish_reason === 'length') throw new Error('Model output truncated; increase the explicit output budget');
    if (!message || message.role !== 'assistant' || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) throw new Error('Invalid model response');
    return { message, usage: payload.usage };
  }
}

function remainingTaskBudgetMs(state: State, context?: { task: string; phase: 'executor' | 'reviewer' }): number | undefined {
  if (!context) return undefined;
  const task = state.tasks[context.task];
  if (!task) return undefined;
  if (taskTimeLimit(state, task)) return 0;
  const wallUsed = Object.values(state.tasks).reduce((sum, t) => sum + t.elapsedSeconds + (t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0), 0);
  const wallRemainingMs = (state.config.maxWallSeconds - wallUsed) * 1000;
  const taskUsed = task.elapsedSeconds + (task.startedAt ? (Date.now() - task.startedAt) / 1000 : 0);
  const taskRemainingMs = (state.config.maxTaskSeconds - taskUsed) * 1000;
  if (context.phase === 'reviewer') {
    const revUsed = (task.reviewElapsedSeconds ?? 0) + (task.reviewStartedAt ? (Date.now() - task.reviewStartedAt) / 1000 : 0);
    const revRemainingMs = ((state.config.maxReviewSeconds ?? 900) - revUsed) * 1000;
    return Math.min(wallRemainingMs, taskRemainingMs, revRemainingMs);
  }
  return Math.min(wallRemainingMs, taskRemainingMs);
}

/**
 * Reserve the call durably before network IO. A dangling reservation is uncertain, never replayed.
 * Handles proactive model-aware compaction, one bounded context-overflow compaction recovery,
 * and typed retry for confirmed rate-limit / provider-outage rejections within configured budgets.
 */
export async function request(
  store: Store,
  sessionId: string,
  route: Route,
  model: Model,
  declarations: Declaration[],
  signal: AbortSignal,
  context?: { task: string; phase: 'executor' | 'reviewer' },
): Promise<Message> {
  let overflowRecovered = false;
  let transientAttempt = 0;

  for (;;) {
    const requestId = randomUUID();
    const trace = { ...context, ...(context ? { attempt: store.read().tasks[context.task]?.attempts } : {}), sessionId };
    const messages = await store.update(state => {
      signal.throwIfAborted();
      assertTaskNotCancelled(state, context?.task);
      if (state.usage.requests >= state.config.maxRequests) throw new Limited('Model request budget exhausted');
      const session = state.sessions[sessionId];
      if (session.pending) throw new UncertainDispatch(`Unreconciled ${session.pending.kind}: ${session.pending.id}`);

      const { projection } = maybeCompactProactively(store.root, state, sessionId, route, declarations);
      if (Buffer.byteLength(JSON.stringify(projection.messages)) > state.config.maxResponseBytes) {
        throw new Limited('Session context exceeds the configured byte limit; save a handoff and start a scoped session');
      }

      session.pending = { kind: 'model', id: requestId };
      state.usage.requests++;
      event(state, 'model_request_started', {
        ...trace,
        requestId,
        model: route.model,
        family: route.family,
        messageCount: projection.messages.length,
        rawMessageCount: session.messages.length,
        estimatedInputTokens: projection.estimatedInputTokens,
        compacted: !!session.compaction,
        toolNames: declarations.map(d => d.function.name),
        ...(projection.messageOverrides.length ? { messageOverrides: projection.messageOverrides } : {}),
      });
      return structuredClone(projection.messages);
    });

    try {
      const reply = await model.complete(route, messages, declarations, signal);
      await store.update(state => {
        const session = state.sessions[sessionId];
        session.messages.push(reply.message);
        delete session.pending;
        state.usage.inputTokens += reply.usage?.prompt_tokens ?? 0;
        state.usage.outputTokens += reply.usage?.completion_tokens ?? 0;
        event(state, 'model_request_completed', { ...trace, requestId, responseIndex: session.messages.length - 1, usage: reply.usage ?? null });
      });
      return reply.message;
    } catch (error) {
      const decision = await store.update(state => {
        const uncertain = error instanceof UncertainDispatch;
        const typed = error instanceof TypedModelError ? error : undefined;
        if (uncertain) state.usage.unknownRequests++;
        else delete state.sessions[sessionId].pending;

        event(state, 'model_request_failed', {
          ...trace,
          requestId,
          uncertain,
          category: uncertain ? 'uncertain_transport' : typed?.category ?? 'error',
          ...(typed ? { status: typed.status, retryable: typed.retryable, retryAfterMs: typed.retryAfterMs } : {}),
          message: String(error),
        });

        if (uncertain || signal.aborted || !typed) return { action: 'rethrow' as const };
        if (state.executionControl?.status === 'terminated' || (context && state.tasks[context.task]?.cancel)) return { action: 'rethrow' as const };
        if (state.usage.requests >= state.config.maxRequests) return { action: 'rethrow' as const };

        if (typed.category === 'context_overflow' && !overflowRecovered) {
          const budget = computeContextBudget(route, declarations);
          const compacted = compactSession(store.root, state, sessionId, 'context_overflow', budget, true);
          if (compacted) {
            event(state, 'model_retry_scheduled', { ...trace, requestId, reason: 'context_overflow_compaction', keptFromIndex: compacted.keptFromIndex });
            return { action: 'retry_overflow' as const };
          }
          return { action: 'rethrow' as const };
        }

        const maxRetries = state.config.maxErrorRetries ?? 2;
        if ((typed.category === 'rate_limit' || typed.category === 'provider_outage') && transientAttempt < maxRetries) {
          const baseDelay = state.config.retryBaseDelayMs ?? 1000;
          const maxDelay = state.config.maxRetryDelayMs ?? 30000;
          const computed = typed.retryAfterMs ?? Math.min(maxDelay, baseDelay * (2 ** transientAttempt));
          const remainingMs = remainingTaskBudgetMs(state, context);
          if (computed > maxDelay || (remainingMs !== undefined && computed >= remainingMs)) {
            return { action: 'limit' as const, reason: `Retry delay (${computed}ms) exceeds configured retry or time budget` };
          }
          event(state, 'model_retry_scheduled', { ...trace, requestId, category: typed.category, attempt: transientAttempt + 1, delayMs: computed });
          return { action: 'retry_delay' as const, delayMs: computed };
        }

        return { action: 'rethrow' as const };
      });

      if (decision.action === 'rethrow') throw error;
      if (decision.action === 'limit') throw new Limited(decision.reason);
      if (decision.action === 'retry_overflow') {
        overflowRecovered = true;
        continue;
      }
      transientAttempt++;
      if (decision.delayMs > 0) await sleep(decision.delayMs, undefined, { signal });
    }
  }
}

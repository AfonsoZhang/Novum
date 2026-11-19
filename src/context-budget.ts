import { event } from './store.js';
import { boundToolContent } from './tool-output.js';
import type { Message, Route, Session, SessionCompaction, State } from './types.js';

export interface ToolSchemaLike {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ContextBudget {
  contextWindowTokens: number;
  reserveOutputTokens: number;
  reserveToolTokens: number;
  proactiveInputLimit: number;
  hardInputLimit: number;
}

export interface ProjectedMessages {
  messages: Message[];
  messageOverrides: { index: number; content: string }[];
  estimatedInputTokens: number;
}

const KNOWN_WINDOWS: [RegExp, number][] = [
  [/gemini[-_]?2|gemini[-_]?3|gemini[-_]?4|gemini[-_]?1\.5/i, 1_000_000],
  [/claude[-_]?(3|4|sonnet|opus|haiku)/i, 200_000],
  [/gpt[-_]?5|o[134](?:[-_]|$)/i, 200_000],
  [/gpt[-_]?4\.1|gpt[-_]?4o/i, 128_000],
  [/deepseek/i, 64_000],
  [/qwen/i, 128_000],
];

/** Resolve model context window from explicit config or conservative model-name heuristics. */
export function resolveContextWindow(route: Route): number {
  if (route.contextWindowTokens && route.contextWindowTokens > 0) return route.contextWindowTokens;
  for (const [pattern, tokens] of KNOWN_WINDOWS) if (pattern.test(route.model)) return tokens;
  return 128_000;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

export function estimateMessageTokens(message: Message): number {
  let tokens = 6;
  if (typeof message.content === 'string') tokens += estimateTextTokens(message.content);
  if (message.tool_calls?.length) tokens += estimateTextTokens(JSON.stringify(message.tool_calls));
  if (message.tool_call_id) tokens += 4;
  return tokens;
}

export function estimateToolsTokens(declarations: ToolSchemaLike[], explicitReserve?: number): number {
  if (explicitReserve !== undefined) return explicitReserve;
  if (!declarations.length) return 0;
  return estimateTextTokens(JSON.stringify(declarations)) + 32;
}

export function computeContextBudget(route: Route, declarations: ToolSchemaLike[]): ContextBudget {
  const contextWindowTokens = resolveContextWindow(route);
  const reserveOutputTokens = Math.min(route.maxOutputTokens, Math.max(256, Math.floor(contextWindowTokens * 0.5)));
  const reserveToolTokens = estimateToolsTokens(declarations, route.reserveToolTokens);
  const ratio = route.compactThresholdRatio ?? 0.8;
  const hardInputLimit = Math.max(512, contextWindowTokens - reserveOutputTokens - reserveToolTokens);
  const proactiveInputLimit = Math.max(256, Math.min(hardInputLimit, Math.floor(contextWindowTokens * ratio) - reserveOutputTokens - reserveToolTokens));
  return { contextWindowTokens, reserveOutputTokens, reserveToolTokens, proactiveInputLimit, hardInputLimit };
}

/**
 * Project outgoing messages from immutable raw session history + persisted compaction boundary.
 * Never mutates `session.messages`.
 */
export function projectMessagesForModel(root: string, session: Session): ProjectedMessages {
  const raw = session.messages;
  const messageOverrides: { index: number; content: string }[] = [];
  const projectOne = (message: Message, rawIndex: number): Message => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    const content = boundToolContent(root, message.content);
    if (content === message.content) return message;
    messageOverrides.push({ index: rawIndex, content });
    return { ...message, content };
  };

  const projected: Message[] = [];
  const startRaw = session.compaction?.keptFromIndex ?? 0;
  const hasLeadingSystem = raw.length > 0 && raw[0].role === 'system';

  if (session.compaction && startRaw > (hasLeadingSystem ? 1 : 0)) {
    if (hasLeadingSystem) projected.push(projectOne(raw[0], 0));
    projected.push({ role: 'user', content: session.compaction.summary });
    for (let i = startRaw; i < raw.length; i++) projected.push(projectOne(raw[i], i));
  } else {
    for (let i = 0; i < raw.length; i++) projected.push(projectOne(raw[i], i));
  }

  const estimatedInputTokens = projected.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return { messages: projected, messageOverrides, estimatedInputTokens };
}

/**
 * Return legal split indices strictly inside `messages` that keep system[0] separate and never
 * split an assistant `tool_calls` message from its trailing `tool` result messages.
 */
export function safeSplitBoundaries(messages: Message[], minStart: number): number[] {
  const boundaries: number[] = [];
  let i = minStart;
  while (i < messages.length) {
    const current = messages[i];
    if (current.role === 'tool') {
      // Cannot start kept suffix on an orphan tool response.
      i++;
      continue;
    }
    boundaries.push(i);
    if (current.role === 'assistant' && current.tool_calls?.length) {
      i++;
      while (i < messages.length && messages[i].role === 'tool') i++;
      continue;
    }
    i++;
  }
  return boundaries;
}

function extractPinnedIds(state: State, sessionId: string, compacted: Message[]): string[] {
  const pinned = new Set<string>();
  if (state.topic.version > 0) pinned.add(`topic:v${state.topic.version}:${state.topic.status}`);
  if (state.researchInputs?.revision) pinned.add(`inputs:rev${state.researchInputs.revision}`);
  for (const task of Object.values(state.tasks)) {
    if (task.session !== sessionId && task.reviewSession !== sessionId) continue;
    pinned.add(`task:${task.id}:${task.stage}`);
    for (const id of task.claimIds) pinned.add(`claim:${id}`);
    for (const r of task.retrievals) for (const s of r.sourceIds) pinned.add(`source:${s}`);
  }
  for (const c of Object.values(state.challenges)) {
    if (c.status !== 'resolved') pinned.add(`challenge:${c.id}:${c.severity}:${c.status}`);
  }
  const text = compacted.map(m => m.content ?? '').join('\n');
  for (const match of text.matchAll(/\b(?:CLM|SRC|EVD|GAP|DEC|SCN|RET|CHG)-[A-Za-z0-9_.-]+\b/g)) {
    pinned.add(match[0]);
    if (pinned.size >= 40) break;
  }
  return [...pinned].slice(0, 40);
}

function buildDeterministicSummary(state: State, sessionId: string, compacted: Message[], pinnedIds: string[], reason: SessionCompaction['reason']): string {
  const tasks = Object.values(state.tasks).filter(t => t.session === sessionId || t.reviewSession === sessionId);
  const userDecisions: string[] = [];
  if (state.topic.approval) userDecisions.push(`Topic approval (v${state.topic.version}): ${state.topic.approval.slice(0, 200)}`);
  for (const task of tasks) {
    if (task.diagnosis) userDecisions.push(`Diagnosis (${task.id}): ${task.diagnosis.slice(0, 200)}`);
  }
  const recentSteps: string[] = [];
  for (const msg of compacted) {
    if (msg.role === 'user' && msg.content) {
      const line = msg.content.replace(/\s+/g, ' ').trim().slice(0, 180);
      if (line) recentSteps.push(`- [user] ${line}`);
    } else if (msg.role === 'assistant') {
      const tools = msg.tool_calls?.map(tc => tc.function.name).join(', ');
      const text = (msg.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (tools || text) recentSteps.push(`- [assistant${tools ? ` tools=${tools}` : ''}] ${text}`);
    } else if (msg.role === 'tool' && msg.content) {
      const snippet = msg.content.replace(/\s+/g, ' ').trim().slice(0, 140);
      recentSteps.push(`- [tool] ${snippet}`);
    }
  }
  const keptDigest = recentSteps.slice(-16).join('\n');
  const lines = [
    `[Compacted context summary (${reason}); raw history preserved on disk]`,
    `Goal: ${state.goal.slice(0, 300) || '(from pinned seeds)'}`,
    ...(tasks.length ? [`Tasks: ${tasks.map(t => `${t.id}(${t.stage}, outputs=${t.outputs.join(',')})`).join('; ')}`] : []),
    ...(pinnedIds.length ? [`Pinned IDs: ${pinnedIds.join(', ')}`] : []),
    ...(userDecisions.length ? [`User decisions & steering:\n${userDecisions.map(d => `- ${d}`).join('\n')}`] : []),
    ...(keptDigest ? [`Compacted turn digest (${compacted.length} messages):\n${keptDigest}`] : []),
  ];
  return lines.join('\n').slice(0, 6000);
}

/**
 * Compact `session` into `session.compaction` while retaining raw `session.messages` untouched.
 * Returns null if no safe split reduces context.
 */
export function compactSession(
  root: string,
  state: State,
  sessionId: string,
  reason: 'proactive_budget' | 'context_overflow',
  budget: ContextBudget,
  aggressive = false,
): SessionCompaction | null {
  const session = state.sessions[sessionId];
  if (!session || session.messages.length < 3) return null;

  const hasSystem = session.messages[0]?.role === 'system';
  const prevBoundary = session.compaction?.keptFromIndex ?? (hasSystem ? 1 : 0);
  const minCandidate = Math.max(hasSystem ? 1 : 0, prevBoundary);
  const boundaries = safeSplitBoundaries(session.messages, minCandidate);
  if (boundaries.length < 2) return null;

  const beforeProjection = projectMessagesForModel(root, session);
  const targetSuffixTokens = aggressive
    ? Math.max(256, Math.floor(budget.proactiveInputLimit * 0.25))
    : Math.max(512, Math.floor(budget.proactiveInputLimit * 0.45));

  // Walk backward from the latest safe boundary until suffix reaches targetSuffixTokens.
  let chosenIndex = boundaries[boundaries.length - 1];
  let suffixTokens = 0;
  for (let b = boundaries.length - 1; b >= 1; b--) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : session.messages.length;
    let groupTokens = 0;
    for (let k = start; k < end; k++) {
      const msg = session.messages[k];
      const content = msg.role === 'tool' && typeof msg.content === 'string' ? boundToolContent(root, msg.content) : msg.content;
      groupTokens += estimateMessageTokens({ ...msg, content });
    }
    if (b < boundaries.length - 1 && suffixTokens + groupTokens > targetSuffixTokens) break;
    suffixTokens += groupTokens;
    chosenIndex = start;
    if (aggressive && b === boundaries.length - 1) break;
  }

  if (chosenIndex <= prevBoundary && reason === 'proactive_budget') {
    // Try compacting at least one safe group if nothing changed yet and we are still over budget.
    if (boundaries.length >= 2 && boundaries[1] > prevBoundary) chosenIndex = boundaries[1];
    else return null;
  }
  if (chosenIndex <= (hasSystem ? 1 : 0)) return null;

  const compactedSlice = session.messages.slice(hasSystem ? 1 : 0, chosenIndex);
  if (!compactedSlice.length) return null;

  const pinnedIds = extractPinnedIds(state, sessionId, compactedSlice);
  const summary = buildDeterministicSummary(state, sessionId, compactedSlice, pinnedIds, reason);
  const candidate: SessionCompaction = {
    summary,
    keptFromIndex: chosenIndex,
    compactedAt: new Date().toISOString(),
    reason,
    pinnedIds,
    originalMessageCount: session.messages.length,
    estimatedTokensBefore: beforeProjection.estimatedInputTokens,
    estimatedTokensAfter: 0,
  };
  const previousCompaction = session.compaction;
  session.compaction = candidate;
  const afterProjection = projectMessagesForModel(root, session);
  candidate.estimatedTokensAfter = afterProjection.estimatedInputTokens;

  if (afterProjection.estimatedInputTokens >= beforeProjection.estimatedInputTokens && previousCompaction && reason === 'proactive_budget') {
    session.compaction = previousCompaction;
    return null;
  }

  session.compactions ??= [];
  session.compactions.push(candidate);
  event(state, 'context_compacted', {
    sessionId,
    reason,
    keptFromIndex: chosenIndex,
    originalMessageCount: session.messages.length,
    estimatedTokensBefore: candidate.estimatedTokensBefore,
    estimatedTokensAfter: candidate.estimatedTokensAfter,
    pinnedCount: pinnedIds.length,
  });
  return candidate;
}

export function maybeCompactProactively(
  root: string,
  state: State,
  sessionId: string,
  route: Route,
  declarations: ToolSchemaLike[],
): { projection: ProjectedMessages; budget: ContextBudget; compacted: SessionCompaction | null } {
  const session = state.sessions[sessionId];
  const budget = computeContextBudget(route, declarations);
  let projection = projectMessagesForModel(root, session);
  let compacted: SessionCompaction | null = null;
  if (projection.estimatedInputTokens > budget.proactiveInputLimit) {
    compacted = compactSession(root, state, sessionId, 'proactive_budget', budget, false);
    if (compacted) projection = projectMessagesForModel(root, session);
  }
  return { projection, budget, compacted };
}

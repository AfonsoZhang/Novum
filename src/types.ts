import { z } from 'zod';

export const routeSchema = z.object({
  baseUrl: z.string().url(), model: z.string().min(1), family: z.string().min(1),
  apiKeyEnv: z.string().min(1), maxOutputTokens: z.number().int().positive().default(4096),
  requestTimeoutMs: z.number().int().positive().default(120000),
  contextWindowTokens: z.number().int().positive().optional(),
  compactThresholdRatio: z.number().min(0.5).max(0.95).optional(),
  reserveToolTokens: z.number().int().nonnegative().optional(),
});
export const configSchema = z.object({
  executor: routeSchema, reviewer: routeSchema.optional(),
  reportLanguage: z.string().trim().min(1).max(120).optional(),
  maxParallel: z.number().int().positive().default(4),
  maxWallSeconds: z.number().positive().default(3600),
  maxRequests: z.number().int().positive().default(100),
  maxTaskSeconds: z.number().positive().default(900),
  maxReviewSeconds: z.number().positive().default(900),
  maxReviewInputBytes: z.number().int().min(4096).default(64 * 1024),
  maxNoProgress: z.number().int().positive().default(3),
  maxWorkflowRevisions: z.number().int().nonnegative().default(3),
  maxErrorRetries: z.number().int().nonnegative().optional(),
  retryBaseDelayMs: z.number().int().positive().optional(),
  maxRetryDelayMs: z.number().int().positive().optional(),
  commandTimeoutMs: z.number().int().positive().default(60000),
  allowCommands: z.boolean().default(false),
  sandboxExecutable: z.string().default('bwrap'),
  maxMemoryMb: z.number().positive().default(4096),
  heartbeatTimeoutMs: z.number().int().positive().default(30000),
  researchKind: z.enum(['empirical', 'theory', 'survey']).default('empirical'),
  maxResponseBytes: z.number().int().positive().default(4 * 1024 * 1024),
  searchUrl: z.string().url().default('https://api.openalex.org/works'),
  searchApiKeyEnv: z.string().default('OPENALEX_API_KEY'),
  evidenceCacheSeconds: z.number().nonnegative().default(3600),
}).transform(config => ({ ...config, reviewer: config.reviewer ?? { ...config.executor } }));
export type Config = z.infer<typeof configSchema>;
export type Route = z.infer<typeof routeSchema>;
const optionalText = (max: number) => z.string().trim().max(max).optional();
const referenceUrl = z.string().trim().url().max(2048).refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an HTTP(S) URL');
export const paperTypes = ['method', 'system', 'benchmark', 'empirical', 'replication', 'theory', 'survey', 'position'] as const;
export type PaperType = typeof paperTypes[number];
export const researchInputsSchema = z.object({
  paperType: z.enum(paperTypes).nullable().optional(),
  // Accepted for old input files only; ignored by the runtime and removed on changed saves.
  selectedDirectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).nullable().optional(),
  // The persisted field name is retained for existing projects and CLI input files.
  seedPapers: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().trim().max(500).default(''),
    kind: z.enum(['paper', 'direction', 'engineering_problem']).optional(),
    referenceInput: optionalText(2048),
    doi: z.string().trim().transform(value => value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')).pipe(z.string().regex(/^10\.\d{4,9}\/\S+$/i, 'Use a DOI such as 10.1234/example')).optional(),
    url: referenceUrl.optional(), notes: optionalText(2000),
  }).strict()).max(50),
  targetJournal: z.object({ name: z.string().trim().min(1).max(300), url: referenceUrl.optional(), notes: optionalText(4000) }).strict().nullable(),
}).strict().superRefine((inputs, ctx) => {
  const ids = new Set<string>(); const references = new Set<string>();
  inputs.seedPapers.forEach((seed, index) => {
    const kind = seed.kind ?? 'paper';
    if (ids.has(seed.id)) ctx.addIssue({ code: 'custom', path: ['seedPapers', index, 'id'], message: 'Duplicate research seed ID' });
    if (kind === 'paper') {
      if (!seed.title) ctx.addIssue({ code: 'custom', path: ['seedPapers', index, 'title'], message: 'Enter a paper title, DOI or link' });
      const key = (seed.doi ?? seed.url ?? seed.title).toLowerCase();
      if (references.has(key)) ctx.addIssue({ code: 'custom', path: ['seedPapers', index], message: 'Duplicate reference paper' });
      references.add(key);
    }
    if (kind !== 'paper' && seed.doi) ctx.addIssue({ code: 'custom', path: ['seedPapers', index, 'doi'], message: 'DOI belongs to a reference paper; add that paper as a separate seed' });
    ids.add(seed.id);
  });
});
export type ResearchInputValues = z.infer<typeof researchInputsSchema>;
export type ResearchSeed = ResearchInputValues['seedPapers'][number];
export type ResearchInputs = ResearchInputValues & { revision: number; updatedAt?: string };
export const stages = ['topic', 'literature', 'plan', 'experiment', 'analysis', 'writing', 'review', 'delivery'] as const;
export type Stage = typeof stages[number];
export const defaultMode = 'automatic' as const;
export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), prompt: z.string().min(1),
  stage: z.enum(stages), session: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('main'),
  dependencies: z.array(z.string()).default([]), inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).min(1), writes: z.array(z.string()).min(1),
  skills: z.array(z.string()).default([]), expectedSeconds: z.number().positive().default(300),
  requiresTopic: z.boolean().default(true),
});
export type TaskSpec = z.infer<typeof taskSchema>;
export type Execution = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'limited' | 'interrupted';
export type Acceptance = 'pending' | 'accepted' | 'blocked' | 'stale';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string;
}
export interface Identity { pid: number; start: string }
export interface Task extends TaskSpec {
  paperType?: PaperType | null;
  pipeline?: true;
  pipelineStep?: { label: string; checkRuns: boolean; checkpoint?: { criteria: string[]; reworkTargets: string[] } };
  pendingRework?: { target: string; reason: string; reviewSession: string; inputRevision: number };
  reworkBaseline?: Record<string, string>;
  researchInputs?: ResearchInputs;
  inputLookups?: { revision: number; completedAt: string; results: { key: string; sourceIds: string[] }[] };
  execution: Execution; acceptance: Acceptance; attempts: number; topicVersion: number;
  inputHashes: Record<string, string>; outputHashes: Record<string, string>;
  reasons: string[]; claimIds: string[]; retrievals: { query: string; intent: 'support' | 'adversarial'; sourceIds: string[] }[];
  lease?: string; worker?: Identity; children: Identity[]; heartbeat?: number; startedAt?: number;
  elapsedSeconds: number; cancel?: boolean; review?: Review; reviewSession?: string;
  noProgress: number; fingerprint?: string; diagnosis?: string; outcome?: string;
  executionCompletedAt?: string;
  reviewStartedAt?: number; reviewElapsedSeconds?: number; reviewOnly?: boolean;
  peakMemoryMb?: number;
  checks?: Record<string, { inputHashes: Record<string, string>; passed: boolean; report: string }>;
  reviewFingerprint?: string; reviewErrors?: string[];
}
export interface Ref { sourceId: string; passage?: string; page?: string; location?: string }
export interface Source { id: string; identity: string; version: string; title: string; path: string; hash: string; retrievedAt: string; citationKeys?: string[] }
export interface Claim { id: string; taskId: string; text: string; evidence: Ref[]; revision: number }
export interface Challenge {
  id: string; claimId: string; severity: 'critical' | 'major' | 'minor'; reason: string;
  taskId?: string;
  status: 'open' | 'responded' | 'resolved' | 'limitation';
  response?: { reason: string; evidence: Ref[] }; resolutionReviewer?: string;
}
export const verdicts = ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'] as const;
export const reviewSchema = z.object({
  transition: z.object({ action: z.enum(['advance', 'revise', 'stop']), target: z.string().optional(), reason: z.string().trim().min(1) }).optional(),
  paperType: z.object({ type: z.enum(paperTypes), reason: z.string().trim().min(1) }).optional(),
  verdict: z.enum(verdicts), summary: z.string().min(1),
  challenges: z.array(z.object({
    id: z.string().min(1), claimId: z.string(), severity: z.enum(['critical', 'major', 'minor']), reason: z.string().min(1),
  })),
  resolvedChallengeIds: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type Review = z.infer<typeof reviewSchema> & {
  session: string; family: string; model: string; inputHashes: Record<string, string>; time: string;
  // Optional for existing records; this describes configured labels, not verified provenance.
  independence?: 'cross_family' | 'same_family';
};
export interface SessionCompaction {
  summary: string;
  keptFromIndex: number;
  compactedAt: string;
  reason: 'proactive_budget' | 'context_overflow';
  pinnedIds: string[];
  originalMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}
export interface Session {
  messages: Message[];
  pending?: { kind: 'model' | 'tool'; id: string };
  inbox: Message[];
  compaction?: SessionCompaction;
  compactions?: SessionCompaction[];
}
export interface RuntimeEvent { seq: number; time: string; type: string; data: Record<string, unknown> }
export type InputField = 'paperType' | 'seedPapers' | 'targetJournal';
export type InitStage = 'scan' | 'read' | 'extract' | 'agents' | 'save';
export interface ProjectInitialization {
  id: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; stage: InitStage;
  startedAt: string; updatedAt: string; endedAt?: string; process?: Identity; error?: string;
  steps: { id: InitStage; status: 'pending' | 'running' | 'completed' | 'failed'; startedAt?: string; endedAt?: string }[];
  files: string[]; documents: { path: string; hash: string; bytes: number; extracted?: boolean }[];
  protectedFields: InputField[];
  findings: { field: InputField; source: string; quote: string; line: number; applied: boolean; reason?: string; value?: unknown }[];
  conflictedFields?: InputField[];
  skipped: number; warnings: string[]; agents?: 'created' | 'supplemented' | 'preserved';
}
export interface State {
  version: 1; goal: string; config: Config; mode: 'on_demand' | 'automatic' | 'autopilot';
  researchInputs?: ResearchInputs;
  initialization?: ProjectInitialization;
  pipelineGraph?: { version: 1; type: PaperType | null; taskIds: string[]; revisions: number };
  paperTypeResolution?: { type: PaperType; reason: string; taskId: string; session: string; inputRevision: number; topicVersion: number; time: string };
  topic: { version: number; status: 'UNSELECTED' | 'AWAITING_TOPIC_APPROVAL' | 'APPROVED'; proposal?: string; approval?: string };
  tasks: Record<string, Task>; sessions: Record<string, Session>;
  sources: Record<string, Source>; claims: Record<string, Claim>; challenges: Record<string, Challenge>;
  edges: { from: string; to: string; relation: 'extends' | 'contradicts' | 'addresses_gap' }[];
  events: RuntimeEvent[]; usage: { requests: number; inputTokens: number; outputTokens: number; unknownRequests: number };
  startedAt?: number;
  executionControl?: { status: 'running' | 'paused' | 'terminated'; revision: number; updatedAt: string };
  scheduler?: { id: string; process: Identity; status: 'starting' | 'running' | 'stopped' | 'failed'; startedAt: string; heartbeat?: string; endedAt?: string; reason?: string };
}

export type Lane = 'queued' | 'active' | 'attention' | 'done';
export type SeedKind = 'paper' | 'direction' | 'engineering_problem';
export type PaperType = 'method' | 'system' | 'benchmark' | 'empirical' | 'replication' | 'theory' | 'survey' | 'position';
export interface ResearchSeed { id: string; kind?: SeedKind; title: string; doi?: string; url?: string; notes?: string; referenceInput?: string }
export interface TargetJournal { name: string; url?: string; notes?: string }
export interface Venue { id: string; kind: 'conference' | 'journal'; shortName: string; name: string; url: string }
export interface VenueCatalog { version: 1; updatedAt: string; venues: Venue[] }
export interface ResearchInputs { revision: number; updatedAt?: string; paperType?: PaperType | null; seedPapers: ResearchSeed[]; targetJournal: TargetJournal | null }
export interface DashboardTask {
  nodeLabel?: string;
  progress: TaskProgress;
  id: string; stage: string; prompt: string; session: string; lane: Lane;
  execution: string; acceptance: string; attempts: number;
  dependencies: string[]; outputs: string[]; inputs: string[]; reasons: string[];
  elapsedSeconds: number; expectedSeconds: number; workerAlive: boolean;
  heartbeat?: number; executionCompletedAt?: string;
  review?: { verdict: string; summary: string; family: string; model: string; limitations: string[]; time: string };
  checks: { name: string; passed: boolean; report: string }[];
  claimIds: string[];
  inputRevision: number;
  paperType: PaperType | null;
}
export interface DashboardSnapshot {
  initialization?: InitializationView;
  workspace?: { record: string };
  runControl: RunControl;
  project: string; goal: string; mode: string; updatedAt: string;
  researchInputs: ResearchInputs;
  paperType: PaperType | null;
  paperTypePreference: PaperType | null;
  paperTypeReason?: string;
  paperTypes: { type: PaperType; label: string; description: string; empirical: boolean; nodes: string[] }[];
  pipelineGraph?: { type: PaperType | null; revisions: number; nodes: { id: string; label: string; dependencies: string[]; reworkTargets: string[] }[] };
  stageLabels: Record<string, string>;
  topic: { status: string; version: number; proposal?: string };
  tasks: DashboardTask[];
  workflow: WorkflowProgress;
  agents: AgentInvocation[];
  claims: { id: string; taskId: string; text: string; evidence: { sourceId: string; passage?: string; page?: string; location?: string }[] }[];
  sources: { id: string; title: string; identity: string; version: string; path: string; retrievedAt: string }[];
  challenges: { id: string; claimId: string; taskId?: string; severity: string; status: string; reason: string; response?: string }[];
  events: { seq: number; time: string; type: string; task?: string; summary: string }[];
  totalEvents: number;
}
export interface InitializationView {
  id: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; stage: string;
  steps: { id: string; status: string; startedAt?: string; endedAt?: string }[];
  startedAt: string; endedAt?: string; elapsedSeconds: number; files: number; skipped: number;
  documents: { path: string; extracted: boolean }[];
  findings: { field: string; source: string; quote: string; line: number; applied: boolean; reason?: string }[];
  warnings: string[]; agents?: string; error?: string; canRetry: boolean;
}
export interface RunControl {
  status: 'ready' | 'running' | 'pausing' | 'paused' | 'terminating' | 'terminated' | 'waiting_approval' | 'completed' | 'blocked' | 'unavailable';
  canPause: boolean; canResume: boolean; canTerminate: boolean; revision: number; runId: string | null;
  canStart: boolean; label: string; reason: string; startedAt?: string; endedAt?: string;
}
export type TaskPhase = 'waiting' | 'ready' | 'preparing' | 'retrieval' | 'model' | 'tool' | 'checking' | 'reviewing' | 'completed' | 'attention' | 'offline' | 'stalled';
export type WorkerHealth = 'healthy' | 'late' | 'offline' | 'none';
export interface TaskProgress { phase: TaskPhase; detail: string; since?: string; waitReasons: string[]; health: WorkerHealth; lastEventSeq?: number }
export interface WorkflowCounts { total: number; executed: number; accepted: number; active: number; blocked: number; ready: number; waiting: number }
export interface WorkflowProgress extends WorkflowCounts {
  status: 'empty' | 'running' | 'attention' | 'waiting_approval' | 'ready' | 'waiting' | 'completed';
  stages: (WorkflowCounts & { stage: string })[];
  activeTaskIds: string[];
  activeExecutors: number; activeReviewers: number;
}
export interface AgentInvocation {
  id: string; parentId: string; task: string; attempt: number; role: 'executor' | 'reviewer'; mode: 'process' | 'session'; session: string;
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'limited' | 'interrupted' | 'uncertain' | 'offline';
  model?: string; pid?: number; phase: TaskPhase; detail: string; startedAt?: string; finishedAt?: string; elapsedSeconds: number;
  heartbeat?: number; health: WorkerHealth; verdict?: string; lastEventSeq?: number; processCount: number;
  calls: { model: number; tools: number; inputTokens: number; outputTokens: number; unknown: number; reusedReviews: number };
}
export type TraceCategory = 'model' | 'tool' | 'retrieval' | 'check' | 'review' | 'lifecycle';
export interface TraceEntry {
  seq: number; time: string; type: string; task?: string; session?: string; attempt?: number;
  category: TraceCategory; status: 'info' | 'started' | 'completed' | 'failed' | 'blocked' | 'uncertain';
  summary: string; durationMs?: number; model?: string; phase?: string;
  tokens?: { input: number; output: number };
}
export interface TracePage { entries: TraceEntry[]; total: number; nextBefore: number | null; latestSeq: number }
export interface TraceDetail {
  entry: TraceEntry; sections: { title: string; text: string; truncated: boolean }[];
  notes: string[];
}

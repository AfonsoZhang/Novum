#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema, defaultMode, type State } from './types.js';
import { event, Store } from './store.js';
import { addTask, approveTopic, pipeline } from './workflow.js';
import { cancel, reconcile, retry, tick } from './scheduler.js';
import { auditFreshness } from './gates.js';
import { pack, replay, validate } from './delivery.js';
import { importKnowledge, queryKnowledge } from './knowledge.js';
import { startDashboard } from './dashboard.js';
import { researchInputs, updateResearchInputs } from './research-inputs.js';
import { defaultSkillRoot, runScheduler } from './run-control.js';
import { startWeb } from './web.js';
import { preflightProvider } from './preflight.js';

const help = `Standalone TypeScript research runtime (Linux, Node >=22)
  web [--record project.json] [--config runtime.json] [--port 4317] [--no-open]  Start the real Web workspace and open the browser
  init --record project.json --config runtime.json --goal "..." [--mode on_demand|automatic|autopilot] [--inputs research-inputs.json]
  inputs --record project.json                  Inspect selected direction, research seeds and target journal
  inputs --record project.json --file inputs.json --version N   Replace inputs at revision N
  pipeline --record project.json                  Add the contribution-specific workflow graph
  task --record project.json --file task.json     Add a scoped task
  run --record project.json [--skills PATH]       Run ready tasks; stop at human/resource gates
  tick --record project.json                     Dispatch ready work once
  status|validate|events|recover --record project.json
  approve-topic --record project.json --version N --response "actual user decision"
  cancel --record project.json --task ID
  retry --record project.json --task ID --diagnosis "changed approach" [--review-only] [--reconciliation "observed outcome"]
  steer --record project.json --session ID --message "..."
  resource --record project.json --file limits.json --response "user authorization"
  audit --file PAPER_CLAIM_AUDIT.json
  doctor --record project.json [--probe]          Check configuration, credential presence, and optional read-only provider probe
  pack --record project.json --output delivery.json
  replay --file delivery.json                     Verify offline; never dispatch models or tools
  knowledge --record project.json --query "..."   Compact reusable evidence query pack
  import-knowledge --record project.json --file delivery.json
  dashboard --record project.json [--port 4317] [--skills PATH]   Local dashboard with one-click start
Model credentials are read only from named environment variables. No host CLI adapters.
New projects default to automatic mode; --mode on_demand limits the project to one scoped task.
run is a foreground scheduler; workers survive scheduler exit. Run again to reconcile and continue.
Topic approval and resource authorization have no timeout or automatic default.`;
async function main(): Promise<void> {
  const { values: parsedValues, positionals } = parseArgs({ allowPositionals: true, options: { ...Object.fromEntries([
    'record', 'config', 'goal', 'mode', 'file', 'skills', 'version', 'response', 'task', 'diagnosis', 'reconciliation', 'session', 'message', 'output', 'query', 'port', 'inputs',
  ].map(name => [name, { type: 'string' as const }])), 'no-open': { type: 'boolean' }, 'review-only': { type: 'boolean' }, probe: { type: 'boolean' } } });
  const values = parsedValues as Record<string, string | boolean | undefined>;
  const option = (key: string, fallback?: string): string => { const value = values[key]; if (typeof value === 'string') return value; if (fallback !== undefined) return fallback; throw new Error(`--${key} is required`); };
  const readJSON = (name: string) => JSON.parse(fs.readFileSync(name, 'utf8'));
  const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const command = positionals[0]; if (!command || command === 'help') { console.log(help); return; }
  if (command === 'audit') { const report = auditFreshness(option('file')); emit(report); if (report.stale || ['FAIL', 'BLOCKED', 'ERROR'].includes(report.verdict)) process.exitCode = 1; return; }
  if (command === 'replay') { const report = replay(option('file')); emit(report); if (!report.passed) process.exitCode = 1; return; }
  const store = new Store(option('record', 'project.json'));
  const skillRoot = path.resolve(option('skills', defaultSkillRoot));
  switch (command) {
    case 'web': {
      const web = await startWeb({ record: store.file, configFile: values.config === undefined ? undefined : option('config'), port: values.port === undefined ? undefined : Number(option('port')), noOpen: values['no-open'] === true, skillRoot });
      emit({ web: web.url, record: store.file, browser: web.browser });
      const stop = () => { void web.close().catch(error => { console.error(String(error)); process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); break;
    }
    case 'dashboard': {
      const dashboard = await startDashboard({ record: store.file, port: Number(option('port', '4317')), skillRoot });
      emit({ dashboard: dashboard.url, editable: ['paperType', 'seedPapers', 'targetJournal'] });
      const stop = () => { void dashboard.close().catch(error => { console.error(String(error)); process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); break;
    }
    case 'init': {
      const mode = option('mode', defaultMode); if (!['on_demand', 'automatic', 'autopilot'].includes(mode)) throw new Error('Invalid mode');
      await store.init(option('goal'), configSchema.parse(readJSON(option('config'))), mode as State['mode'], values.inputs ? readJSON(option('inputs')) : undefined); emit({ record: store.file, mode }); break;
    }
    case 'inputs': emit(values.file ? await updateResearchInputs(store, readJSON(option('file')), Number(option('version'))) : researchInputs(store.read())); break;
    case 'pipeline': await pipeline(store); emit({ tasks: Object.keys(store.read().tasks) }); break;
    case 'task': await addTask(store, readJSON(option('file'))); emit({ added: true }); break;
    case 'approve-topic': await approveTopic(store, Number(option('version')), option('response')); emit(store.read().topic); break;
    case 'tick': emit({ dispatched: await tick(store, skillRoot) }); break;
    case 'run': {
      const controller = new AbortController(); const handler = () => controller.abort(); process.once('SIGINT', handler); process.once('SIGTERM', handler);
      try {
        const run = await runScheduler(store, skillRoot, { signal: controller.signal, onDispatch: dispatched => emit({ dispatched }) });
        if (run.alreadyRunning) { emit(run); break; }
      } finally { process.removeListener('SIGINT', handler); process.removeListener('SIGTERM', handler); }
      const result = validate(store); emit(result);
      if (!result.passed && store.read().topic.status !== 'AWAITING_TOPIC_APPROVAL') process.exitCode = 1;
      break;
    }
    case 'recover': await reconcile(store); emit(validate(store)); break;
    case 'status': emit(validate(store)); break;
    case 'events': for (const e of store.read().events) console.log(JSON.stringify(e)); break;
    case 'validate': { await reconcile(store); const report = validate(store); emit(report); if (!report.passed) process.exitCode = 1; break; }
    case 'cancel': await cancel(store, option('task')); emit({ cancellationRequested: true }); break;
    case 'retry': await retry(store, option('task'), option('diagnosis'), values.reconciliation as string | undefined, values['review-only'] === true); emit({ queued: true }); break;
    case 'steer': await store.update(s => { const id = option('session'); if (!s.sessions[id]) throw new Error('Unknown session'); s.sessions[id].inbox.push({ role: 'user', content: option('message') }); event(s, 'steering_queued', { session: id }); }); emit({ queued: true }); break;
    case 'resource': {
      const response = option('response'); if (!response.trim()) throw new Error('Explicit resource authorization required');
      const limits = readJSON(option('file')); const allowed = ['maxRequests', 'maxWallSeconds', 'maxTaskSeconds', 'maxReviewSeconds', 'maxReviewInputBytes', 'maxParallel', 'maxWorkflowRevisions'];
      if (Object.keys(limits).some(k => !allowed.includes(k))) throw new Error('Only explicit resource limits may be updated here');
      await store.update(s => { s.config = configSchema.parse({ ...s.config, ...limits }); event(s, 'resources_authorized', { limits, response }); }); emit({ updated: true }); break;
    }
    case 'doctor': {
      const state = store.read(); const config = configSchema.parse(state.config);
      const base = { platform: process.platform, node: process.version, skillsAvailable: fs.existsSync(skillRoot), executorCredentialPresent: !!process.env[config.executor.apiKeyEnv], reviewerCredentialPresent: !!process.env[config.reviewer.apiKeyEnv], executorCredential: !!process.env[config.executor.apiKeyEnv], reviewerCredential: !!process.env[config.reviewer.apiKeyEnv], searchCredential: !!process.env[config.searchApiKeyEnv], networkTested: false, commandsEnabled: config.allowCommands, isolation: config.sandboxExecutable };
      if (values.probe === true) {
        const providerPreflight = await preflightProvider(config);
        emit({ ...base, networkTested: true, providerPreflight });
        if (!providerPreflight.passed) process.exitCode = 1;
      } else {
        emit({ ...base, credentialValidity: 'unverified (pass --probe for read-only /models capability check)' });
      }
      break;
    }
    case 'pack': pack(store, option('output')); emit({ bundle: option('output') }); break;
    case 'knowledge': emit(queryKnowledge(store, option('query', ''))); break;
    case 'import-knowledge': await importKnowledge(store, option('file')); emit({ imported: true }); break;
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
}
main().catch(error => { console.error(JSON.stringify({ error: String(error) })); process.exitCode = 1; });

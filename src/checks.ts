import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashes, refErrors } from './gates.js';
import { contentHash, event, local, Store } from './store.js';
import { paperProfile, taskPaperType } from './paper-types.js';
import { z } from 'zod';
import { assertTaskNotCancelled } from './execution-control.js';

const execute = promisify(execFile);
/** Version-bound calls to existing validators, invoked by the loop, not by model choice. */
export async function runChecks(store: Store, taskId: string, skillRoot: string, signal: AbortSignal): Promise<string[]> {
  const state = store.read(); const task = state.tasks[taskId]; const errors: string[] = [];
  signal.throwIfAborted(); assertTaskNotCancelled(state, taskId);
  const checks: { name: string; script: string; inputs: string[]; args: string[] }[] = [];
  const type = taskPaperType(state, task);
  if (task.pipelineStep ? task.pipelineStep.checkRuns : paperProfile(type).empirical && ['experiment', 'analysis', 'review', 'delivery'].includes(task.stage)) {
    const inputs = ['research/planned-runs.json', 'research/observed-runs.json'];
    checks.push({ name: 'run-records', script: 'experiment-bridge/scripts/check_run_records.py', inputs, args: ['--planned', local(store.root, inputs[0]), '--observed', local(store.root, inputs[1])] });
  }
  const latex = [...new Set([...task.inputs, ...task.outputs].filter(n => n.endsWith('.tex')))];
  if (latex.length && ['writing', 'review', 'delivery'].includes(task.stage)) checks.push({ name: 'integrity-precheck', script: 'paper-claim-audit/scripts/integrity/precheck.py', inputs: latex, args: ['--latex', ...latex.map(n => local(store.root, n)), '--out-dir', path.join(store.runtime, 'checks', taskId, 'integrity')] });
  for (const name of [...task.inputs, ...task.outputs].filter(n => /(?:fig|plot).*\.(py|r)$/i.test(n))) checks.push({ name: `figure-${contentHash(name).slice(0, 8)}`, script: 'nature-figure/scripts/validate_figure.py', inputs: [name], args: [local(store.root, name), '--json'] });
  for (const check of checks) {
    if (check.inputs.some(n => !fs.existsSync(local(store.root, n)))) { errors.push(`Missing required ${check.name} inputs: ${check.inputs.join(', ')}`); continue; }
    const script = local(skillRoot, check.script); if (!fs.existsSync(script)) { errors.push(`Missing validator: ${check.script}`); continue; }
    const inputHashes = { ...hashes(store.root, check.inputs), ['validator:' + check.script]: hashes(skillRoot, [check.script])[check.script] };
    const cached = task.checks?.[check.name];
    if (cached?.passed && JSON.stringify(cached.inputHashes) === JSON.stringify(inputHashes) && fs.existsSync(local(store.root, cached.report))) continue;
    const report = `.research-loop/checks/${taskId}/${check.name}.log`; fs.mkdirSync(path.dirname(local(store.root, report)), { recursive: true });
    await store.update(s => { signal.throwIfAborted(); assertTaskNotCancelled(s, taskId); event(s, 'deterministic_check_started', { task: taskId, check: check.name, inputHashes }); });
    let passed = false; let output = '';
    try {
      const result = await execute('python3', [script, ...check.args], { cwd: store.root, signal, timeout: state.config.commandTimeoutMs, maxBuffer: state.config.maxResponseBytes });
      passed = true; output = result.stdout + result.stderr;
      if (check.name === 'run-records') {
        const report = JSON.parse(result.stdout);
        if (report.attempt_status_counts?.running || report.attempt_status_counts?.pending || report.attempt_status_counts?.planned) { passed = false; output += '\nUnfinished experiment attempts cannot establish execution completion.'; }
      }
    } catch (error) { signal.throwIfAborted(); output = String(error); }
    fs.writeFileSync(local(store.root, report), output);
    await store.update(s => { const t = s.tasks[taskId]; t.checks ??= {}; t.checks[check.name] = { inputHashes, passed, report }; event(s, 'deterministic_check_completed', { task: taskId, check: check.name, passed, report }); });
    if (!passed) errors.push(`Deterministic check failed: ${check.name}; inspect ${report}`);
  }
  const selection = 'research/source-selection.json';
  const checkSelection = type === 'survey' && [...task.inputs, ...task.outputs].includes(selection);
  if (checkSelection) {
    const report = `.research-loop/checks/${taskId}/source-selection.log`; const findings: string[] = [];
    await store.update(s => event(s, 'deterministic_check_started', { task: taskId, check: 'source-selection', paperType: type }));
    let inputHashes: Record<string, string> = {};
    try {
      const entries = z.array(z.object({ sourceId: z.string().min(1), decision: z.enum(['include', 'exclude']), reason: z.string().trim().min(1) }).strict()).min(1).parse(JSON.parse(fs.readFileSync(local(store.root, selection), 'utf8')));
      if (!entries.some(entry => entry.decision === 'include')) findings.push('Survey selection contains no included source');
      if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) findings.push('Duplicate survey source selection');
      findings.push(...refErrors(store.root, state, entries.map(entry => ({ sourceId: entry.sourceId, location: 'Survey selection record' }))));
      inputHashes = hashes(store.root, [selection, ...entries.flatMap(entry => state.sources[entry.sourceId] ? [state.sources[entry.sourceId].path] : [])].filter(name => fs.existsSync(local(store.root, name))));
    } catch (error) { findings.push(`Invalid survey selection: ${String(error)}`); }
    fs.mkdirSync(path.dirname(local(store.root, report)), { recursive: true });
    fs.writeFileSync(local(store.root, report), findings.join('\n') || 'Source selection structure and registered snapshots verified; coverage and synthesis require independent review.');
    const passed = findings.length === 0;
    await store.update(s => { s.tasks[taskId].checks ??= {}; s.tasks[taskId].checks!['source-selection'] = { passed, report, inputHashes }; event(s, 'deterministic_check_completed', { task: taskId, check: 'source-selection', passed, report }); });
    if (!passed) errors.push(`Deterministic check failed: source-selection; inspect ${report}`);
  }
  if (!checks.length && !checkSelection) await store.update(s => event(s, 'deterministic_checks_not_applicable', { task: taskId, stage: task.stage, paperType: type, backfill: 'retry with declared applicable artifacts' }));
  return errors;
}

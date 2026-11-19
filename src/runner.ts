import { Store } from './store.js';
import { runScheduler } from './run-control.js';
const [record, runId, skillRoot] = process.argv.slice(2);
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
runScheduler(new Store(record), skillRoot, { runId, signal: controller.signal }).catch(error => { console.error(String(error)); process.exitCode = 1; });

import { Store } from './store.js';
import { initializeProject } from './project-initialization.js';
const [record, runId] = process.argv.slice(2);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
initializeProject(new Store(record), { runId, signal: controller.signal }).catch(() => { process.exitCode = 1; });

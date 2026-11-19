import { Store } from './store.js';
import { worker } from './scheduler.js';
const [record, task, lease, skillRoot] = process.argv.slice(2);
worker(new Store(record), task, lease, skillRoot).catch(error => { console.error(String(error)); process.exitCode = 1; });

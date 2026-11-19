import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
mkdirSync(new URL('dist/dashboard/', root), { recursive: true });
for (const name of ['index.html', 'styles.css']) copyFileSync(new URL(`web/${name}`, root), new URL(`dist/dashboard/${name}`, root));
copyFileSync(new URL('dist/dashboard/dashboard.js', root), new URL('dist/dashboard/app.js', root));
mkdirSync(new URL('dist/config/', root), { recursive: true });
copyFileSync(new URL('config/venues.json', root), new URL('dist/config/venues.json', root));
await import('./build_native_picker.mjs');

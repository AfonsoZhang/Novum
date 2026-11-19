import { rmSync } from 'node:fs';

// Removed source modules must not survive in the installed runtime.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });

import { fileURLToPath } from 'node:url';

// Retain existing launch commands while all implementation and state live in app/.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await import('../scripts/serve-tasks.mjs');

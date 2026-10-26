import { resolve } from 'node:path';
import { TaskStore } from '../dist/tasks/store.js';
import { localTaskIdentity } from '../dist/tasks/runtime.js';
import { acquireRuntimeOwner } from '../dist/tasks/runtime-owner.js';
import { migrateDashboardState } from '../dist/world/migrate-dashboard.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args.some((arg) => arg.startsWith('--')))
  throw new Error(
    'Usage: node scripts/migrate-dashboard-state.mjs SOURCE_DIRECTORY TARGET_DIRECTORY',
  );
const source = resolve(args[0]);
const target = resolve(args[1]);
if (source === target)
  throw new Error('Source and target directories must be separate.');
const release = acquireRuntimeOwner(target);
let store;
try {
  store = new TaskStore(target, { recover: false });
  const result = migrateDashboardState(
    store,
    source,
    localTaskIdentity,
    'live',
  );
  console.log(JSON.stringify({ ...result, source, target }, null, 2));
} finally {
  store?.close();
  release();
}

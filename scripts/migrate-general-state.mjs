import { migrateGeneralState } from '../dist/tasks/migrate.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--target')
  throw new Error(
    'Usage: node scripts/migrate-general-state.mjs --source <closed-v1-state-directory> --target <new-v2-directory>',
  );
const report = await migrateGeneralState({
  sourceDirectory: args[1],
  targetDirectory: args[3],
});
console.log(JSON.stringify(report, null, 2));

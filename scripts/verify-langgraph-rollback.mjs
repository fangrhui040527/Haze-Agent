import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { migrateGeneralState } from '../dist/tasks/migrate.js';

const [flag, legacyPath, ...rest] = process.argv.slice(2);
if (flag !== '--legacy-executable' || !legacyPath || rest.length)
  throw new Error(
    'Usage: verify-langgraph-rollback.mjs --legacy-executable /absolute/retained-dist',
  );
const legacyExecutable = resolve(legacyPath);
const root = resolve('tmp', 'langgraph-rollback-verification', randomUUID());
const source = join(root, 'old-source');
const target = join(root, 'new-copy');
const archive = join(root, 'post-cutover-archive');
const restored = join(root, 'restored-old-snapshot');
const newExecutable = join(root, 'new-executable');
await mkdir(root, { recursive: true });
await cp(resolve('dist'), newExecutable, {
  recursive: true,
  errorOnExist: true,
});
await cp(resolve('package-lock.json'), join(root, 'package-lock.json'));
async function worker(executable, directory, action, taskId) {
  const child = fork(
    new URL('./langgraph-rollback-worker.mjs', import.meta.url),
    [executable, directory, action, ...(taskId ? [taskId] : [])],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  let result;
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  child.on('message', (message) => (result = message));
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Rollback worker timed out: ${stderr}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 && result
        ? done()
        : reject(new Error(`Rollback worker exited ${code}: ${stderr}`));
    });
  });
  return result;
}
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const before = await worker(legacyExecutable, source, 'create');
const sourceHash = await hash(join(source, 'tasks.sqlite'));
const migration = await migrateGeneralState({
  sourceDirectory: source,
  targetDirectory: target,
});
assert.equal(await hash(join(source, 'tasks.sqlite')), sourceHash);
assert.equal(
  await hash(join(migration.rollback_snapshot, 'tasks.sqlite')),
  sourceHash,
);
const migratedReadback = await worker(
  newExecutable,
  target,
  'read',
  before.task.id,
);
assert.deepEqual(migratedReadback.task.result, before.task.result);
assert.deepEqual(migratedReadback.artifacts, before.artifacts);

// A new admission proves post-cutover work stays with the archived new reader.
const postCutover = await worker(newExecutable, target, 'create');
assert.notEqual(postCutover.task.id, before.task.id);
await rename(target, archive);
await cp(join(archive, 'legacy-archive'), restored, {
  recursive: true,
  errorOnExist: true,
});
const oldReadback = await worker(
  legacyExecutable,
  restored,
  'read',
  before.task.id,
);
assert.deepEqual(oldReadback, before);
const archivedReadback = await worker(
  newExecutable,
  archive,
  'read',
  postCutover.task.id,
);
assert.deepEqual(archivedReadback, postCutover);
assert.equal(await hash(join(source, 'tasks.sqlite')), sourceHash);
const report = {
  checked_at: new Date().toISOString(),
  passed: true,
  node: process.version,
  legacy_executable: legacyExecutable,
  new_executable: newExecutable,
  source_directory: source,
  source_sha256: sourceHash,
  new_state_archive: archive,
  restored_old_snapshot: restored,
  original_task_id: before.task.id,
  post_cutover_task_id: postCutover.task.id,
  old_reader_exact_readback: true,
  new_reader_exact_readback: true,
  source_unchanged: true,
  migration,
};
const path = join(root, 'report.json');
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: path, passed: true }, null, 2));

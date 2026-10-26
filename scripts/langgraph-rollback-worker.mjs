import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const [executable, directory, action, taskId] = process.argv.slice(2);
if (
  !process.send ||
  !executable ||
  !directory ||
  !['create', 'read'].includes(action)
)
  throw new Error(
    'This worker must be started by verify-langgraph-rollback.mjs.',
  );
const { TaskRuntime, localTaskIdentity } = await import(
  pathToFileURL(resolve(executable, 'tasks/runtime.js')).href
);
const { createExecutionRegistry } = await import(
  pathToFileURL(resolve(executable, 'composition.js')).href
);
const runtime = new TaskRuntime({
  stateDirectory: directory,
  registry: createExecutionRegistry({ mode: 'fixture' }),
  mode: 'fixture',
});
try {
  let id = taskId;
  if (action === 'create') {
    const admissionKey = randomUUID();
    const imported = runtime.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'rollback-source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'Retain immutable evidence and preserve historical results.',
        ).toString('base64'),
      },
      `rollback-source-${admissionKey}`,
    );
    const ref = imported.artifact ?? imported;
    id = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Explain the supplied source about retained evidence.',
        context_refs: [
          { id: ref.id, version: ref.version, sha256: ref.sha256 },
        ],
      },
      `rollback-admission-${admissionKey}`,
    ).task_id;
  }
  const deadline = Date.now() + 20_000;
  let task;
  for (;;) {
    task = runtime.store.read(id, localTaskIdentity);
    if (!['queued', 'running'].includes(task.status)) break;
    if (Date.now() > deadline)
      throw new Error(
        `Rollback fixture did not settle: ${JSON.stringify(task)}`,
      );
    await new Promise((done) => setTimeout(done, 20));
  }
  if (task.status !== 'completed')
    throw new Error(`Rollback fixture failed: ${JSON.stringify(task)}`);
  const artifacts = task.artifacts.map((item) =>
    runtime.store.artifact(item.artifact.id, localTaskIdentity, item.artifact),
  );
  await runtime.close();
  process.send({ task, artifacts }, () => process.exit(0));
} catch (error) {
  await runtime.close();
  throw error;
}

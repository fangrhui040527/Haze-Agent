import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTaskHandler } from '../dist/tasks/http.js';
import { localTaskIdentity } from '../dist/tasks/runtime.js';

/** Verification-only process: crash after durable phase admission and before dispatch. */
const handler = createTaskHandler({
  stateDirectory: resolve(process.env.STATE_DIR),
  mode: 'fixture',
  env: process.env,
  dispatchTask: (taskId) => {
    const task = handler.runtime.store.read(taskId, localTaskIdentity);
    writeFileSync(
      resolve(process.env.STATE_DIR, 'committed-before-dispatch.json'),
      JSON.stringify({
        kind: 'committed-before-dispatch',
        task_id: taskId,
        run_id: task.current_run_id,
        generation: task.generation,
        status: task.status,
        usage: task.usage,
      }),
    );
    process.exit(0);
  },
});
const server = createServer(handler);
server.listen(0, '127.0.0.1', () =>
  process.send?.({ kind: 'listening', port: server.address().port }),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    server.close();
    void handler.close().then(() => process.exit(0));
  });

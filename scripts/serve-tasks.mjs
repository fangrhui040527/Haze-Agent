import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createTaskHandler } from '../dist/tasks/http.js';

const fixture =
  process.argv.includes('--orchestration-fixture') ||
  process.argv.includes('--hybrid-fixture');
const orchestrationPorts = fixture
  ? (await import('../dist/orchestration/example.js')).createPm25FixturePorts()
  : undefined;

const handler = createTaskHandler({
  stateDirectory: resolve(process.env.STATE_DIR || '.state', 'tasks'),
  env: process.env,
  ...(orchestrationPorts ? { orchestrationPorts } : {}),
});
const server = createServer(handler);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.HAZE_TASK_PORT || 8787), '127.0.0.1', () => {
  console.log(
    `Local read-only task API${fixture ? ' (EXPLICIT ORCHESTRATION FIXTURES)' : ''}: http://127.0.0.1:${server.address().port}/api/tasks`,
  );
  process.send?.({ port: server.address().port });
});
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => {
    server.close();
    void handler.close().then(() => process.exit(0));
  });

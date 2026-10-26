import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createTaskHandler } from '../dist/tasks/http.js';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--fixture'))
  throw new Error(
    'Usage: serve-tasks.mjs [--fixture]. Retired v1/v2 switches are unavailable.',
  );
const fixture = flags.includes('--fixture');
const handler = createTaskHandler({
  stateDirectory: resolve(process.env.STATE_DIR || '.state/general-v1'),
  env: process.env,
  mode: fixture ? 'fixture' : 'live',
  acceptancePolicy: process.env.HAZE_WORLD_ACCEPTANCE_POLICY,
});
const server = createServer(handler);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.HAZE_TASK_PORT || 8787), '127.0.0.1', () => {
  console.log(
    `Local general task API (${fixture ? 'EXPLICIT FIXTURE' : 'configured live'}): http://127.0.0.1:${server.address().port}/api/tasks`,
  );
  process.send?.({ port: server.address().port });
});
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => {
    server.close();
    void handler.close().then(() => process.exit(0));
  });

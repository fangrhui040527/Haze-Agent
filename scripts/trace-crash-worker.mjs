import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskStore } from '../dist/tasks/store.js';
import { TraceProjectionService } from '../dist/tasks/trace-projection.js';
import { taskRequestSchema } from '../dist/contracts/tasks.js';

const [directory, stage] = process.argv.slice(2);
if (
  !directory ||
  !['before-projection', 'after-append', 'torn-tail'].includes(stage)
)
  throw new Error('Expected a temporary state directory and crash stage.');
const store = new TaskStore(join(directory, 'state'));
store.admit(
  taskRequestSchema.parse({
    schema_version: 'haze.task.request.v3',
    objective: 'Verify committed traces survive a process crash.',
  }),
  { principal: 'trace-crash', workspace: 'trace-crash' },
  randomUUID(),
  { mode: 'fixture', tools: [] },
);
if (stage === 'before-projection') process.exit(91);
const projection = new TraceProjectionService(store, {
  directory: join(directory, 'logs'),
  env: { HAZE_TRACE_FILES: 'on', HAZE_TRACE_STDOUT: 'off' },
});
// The test-only boundary is after JSONL append and before manifest projection.
projection.writeMetadata = async (progress) => {
  if (stage === 'torn-tail')
    await appendFile(
      join(progress.directory, 'events.jsonl'),
      '{"event_id":"partial',
    );
  process.exit(92);
};
await projection.flush();
throw new Error('Expected the worker to exit at the projection boundary.');

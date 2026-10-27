import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const base = resolve(process.argv[2]);
const load = (name) => import(pathToFileURL(resolve(base, 'dist', name)));
const [
  { createExecutionRegistry, createModelRouteRegistry },
  { createTaskHandler },
] = await Promise.all([load('composition.js'), load('tasks/http.js')]);
const tools = new Set([
  'reduction.pin-selection',
  'reduction.imported-residual-comparison.v1',
  'reduction.independent-check.v1',
  'reduction.conditional-plan.v1',
  'reduction.conditional-plan-check.v1',
]);
const definitions = new Set([
  'core.manager.coordinator',
  'reduction.select',
  'reduction.assess',
  'reduction.check',
  'reduction.plan',
  'reduction.plan-check',
]);
const registry = createExecutionRegistry({ mode: 'live', env: process.env });
const routes = createModelRouteRegistry(process.env);
let lastModelStarted = 0;
async function pace(signal) {
  await delay(Math.max(0, 2500 - (Date.now() - lastModelStarted)), undefined, {
    signal,
  });
  signal.throwIfAborted();
  lastModelStarted = Date.now();
}
function paced(model) {
  return {
    selection: model.selection,
    complete: async (input, signal) => {
      await pace(signal);
      return model.complete(input, signal);
    },
    ...(model.completeWithReceipt
      ? {
          completeWithReceipt: async (input, signal) => {
            await pace(signal);
            return model.completeWithReceipt(input, signal);
          },
        }
      : {}),
  };
}
const handler = createTaskHandler({
  registry,
  stateDirectory: process.env.HAZE_TASK_STATE_DIR,
  env: process.env,
  mode: 'live',
  limits: { max_model_input_bytes: 24576 },
  modelRoutes: {
    snapshot: () => routes.snapshot(),
    readiness: () => routes.readiness(),
    resolve: (route) => paced(routes.resolve(route)),
    prepare: async (route, signal) =>
      paced(await routes.prepare(route, signal)),
  },
});
// Runtime composition installs store-backed methods. Narrow only this benchmark
// registry after installation and before the first admission; production is unchanged.
for (const id of registry.tools.keys())
  if (!tools.has(id)) registry.tools.delete(id);
for (const id of tools)
  assert.ok(registry.tools.has(id), `Missing benchmark method ${id}`);
for (const [id, definition] of registry.definitions) {
  if (!definitions.has(id)) registry.definitions.delete(id);
  else definition.tools = definition.tools.filter((tool) => tools.has(tool));
}
for (const [id, capability] of registry.capabilities) {
  if (!['core.manager', 'damage-reduction-planning'].includes(id))
    registry.capabilities.delete(id);
  else
    registry.capabilities.set(id, {
      ...capability,
      card: {
        ...capability.card,
        required_tools: capability.card.required_tools.filter((tool) =>
          tools.has(tool),
        ),
      },
      prerequisites: capability.prerequisites?.filter((item) =>
        definitions.has(item.definition_id),
      ),
      review_requirements: capability.review_requirements?.filter((item) =>
        definitions.has(item.review_definition_id),
      ),
      peer_requirements: capability.peer_requirements?.filter((item) =>
        item.definitions.every((value) => definitions.has(value)),
      ),
    });
}
const server = createServer(handler);
server.listen(0, '127.0.0.1', () =>
  process.send?.({
    port: server.address().port,
    tool_ids: [...registry.tools.keys()],
    max_model_input_bytes: 24576,
  }),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    server.close();
    void handler.close().then(() => process.exit(0));
  });

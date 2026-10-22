import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './engine-sources.mjs';

// Exercise the pinned upstream conformance against the same compiled references
// loaded by Haze. No upstream dependency installation or network access occurs.
for (const [runner, environment] of [
  [
    'vendor/meterless/engines/hmem/conformance/runner.js',
    {
      HMEM_IMPL: fileURLToPath(
        new URL(
          '../vendor/meterless/templates/agentathon-starter/vendor/hmem/src/index.js',
          import.meta.url,
        ),
      ),
    },
  ],
  [
    'vendor/meterless/engines/world-model/conformance/runner.js',
    {
      WORLD_MODEL_IMPL: fileURLToPath(
        new URL(
          '../vendor/meterless/engines/world-model/reference/src/index.js',
          import.meta.url,
        ),
      ),
    },
  ],
]) {
  const result = spawnSync(process.execPath, [runner], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

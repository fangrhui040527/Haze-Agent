import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteCheckpointer } from '../checkpoints/sqlite.js';
import { openHazeEngines } from './meterless/index.js';
import versions from '../workflow_versions.json' with { type: 'json' };
import {
  createCompatibilityGraph,
  initialCompatibilityState,
  type CompatibilityState,
} from './graph.js';
import { resolveProbeProvider } from '../adapters/provider.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function installedVersions() {
  const runtime = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { engines: { node: string; npm: string } };
  const dependencies: Record<string, string> = {};
  for (const name of [
    ...Object.keys(versions.dependencies),
    'better-sqlite3',
  ]) {
    const manifest = JSON.parse(
      await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version: string };
    dependencies[name] = manifest.version;
    const pinned =
      versions.dependencies[name as keyof typeof versions.dependencies];
    if (pinned)
      assert.equal(manifest.version, pinned, `Installed pin differs: ${name}`);
  }
  return {
    node: process.versions.node,
    pinnedRuntime: runtime.engines,
    dependencies,
  };
}

export async function runCompatibilityPhase(
  phase: 'start' | 'resume',
  stateDir: string,
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  initialCompatibilityState(threadId); // Validate before using this ID in a path.
  const directory = join(resolve(stateDir), 'compatibility', threadId);
  const handle = await openSqliteCheckpointer(stateDir);
  try {
    const engines = await openHazeEngines({
      memoryDirectory: join(directory, 'hmem'),
      worldDirectory: join(directory, 'world-model'),
      namespace: 'compatibility',
    });
    const graph = createCompatibilityGraph(
      handle.checkpointer,
      engines,
      resolveProbeProvider(env),
    );
    const config = {
      configurable: { thread_id: threadId },
      durability: 'sync' as const,
    };
    const before = await graph.getState(config);
    if (phase === 'start') {
      assert.deepEqual(
        before.values,
        {},
        'A probe must start with an unused thread',
      );
      await graph.invoke(initialCompatibilityState(threadId), config);
    } else {
      assert.deepEqual(
        before.next,
        ['recall_after_restart'],
        'Resume needs the saved paused thread',
      );
      await graph.invoke(null, config);
    }
    const after = await graph.getState(config);
    assert.deepEqual(
      after.next,
      phase === 'start' ? ['recall_after_restart'] : [],
    );
    const values = after.values as CompatibilityState;
    if (phase === 'resume') assert.equal(values.recordsVerified, true);
    const tuple = await handle.checkpointer.getTuple(config);
    assert(tuple?.config.configurable?.checkpoint_id);
    return {
      phase,
      pid: process.pid,
      threadId,
      checkpointBefore:
        (before.config.configurable?.checkpoint_id as string | undefined) ??
        null,
      checkpointAfter: tuple.config.configurable.checkpoint_id as string,
      nextBefore: before.next,
      nextAfter: after.next,
      state: values,
      checkpointChannels: Object.keys(tuple.checkpoint.channel_values).sort(),
      checkpointCount: handle.checkpointer.db
        .prepare(
          'SELECT count(*) AS count FROM checkpoints WHERE thread_id = ?',
        )
        .get(threadId),
      databasePath: handle.databasePath,
      durability: { ...handle.durability, graph: 'sync' },
      stores: {
        memory: join(directory, 'hmem'),
        world: join(directory, 'world-model'),
      },
      engineProvenance: engines.provenance,
      versions: await installedVersions(),
    };
  } finally {
    handle.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const phase = process.argv[2];
    assert(
      phase === 'start' || phase === 'resume',
      'Expected start or resume phase',
    );
    const threadId = process.argv[3];
    assert(threadId, 'Thread ID is required');
    const stateDir = process.env.STATE_DIR;
    assert(stateDir, 'STATE_DIR is required');
    console.log(
      JSON.stringify(await runCompatibilityPhase(phase, stateDir, threadId)),
    );
  } catch {
    // Never print arbitrary engine/provider configuration or upstream error bodies.
    console.error(
      'Compatibility phase failed. Check local configuration, engine build and saved thread versions.',
    );
    process.exitCode = 1;
  }
}

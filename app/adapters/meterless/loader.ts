import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  EngineProvenance,
  MemoryEngine,
  WorldEngine,
  WorldUtilities,
} from './ports.js';

// Both app/adapters/meterless and dist/adapters/meterless are three levels below the repository root.
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
type Component = 'starter' | 'hmem' | 'world_model';
type Constructor<T> = new (options: Record<string, unknown>) => T;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid pinned engine ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireMethods(
  value: unknown,
  methods: string[],
  label: string,
): void {
  const exports = record(value, label);
  for (const method of methods) {
    if (typeof exports[method] !== 'function') {
      throw new Error(`Pinned engine ${label} is missing ${method}`);
    }
  }
}

function engineConstructor<T>(
  value: unknown,
  methods: string[],
  label: string,
): Constructor<T> {
  if (typeof value !== 'function') {
    throw new Error(`Pinned engine ${label} has no constructor`);
  }
  const prototype: unknown = (value as { prototype: unknown }).prototype;
  requireMethods(prototype, methods, label);
  return value as Constructor<T>;
}

async function provenance(
  sources: Record<string, unknown>,
  implementations: Record<string, unknown>,
  component: Component,
  rootDirectory: string,
): Promise<EngineProvenance> {
  const source = record(sources[component], component);
  for (const key of ['repository', 'revision', 'sha256', 'entrypoint']) {
    if (typeof source[key] !== 'string' || !source[key]) {
      throw new Error(`Invalid pinned engine ${component}.${key}`);
    }
  }
  if (
    !/^[a-f0-9]{40}$/.test(source.revision as string) ||
    !/^[a-f0-9]{64}$/.test(source.sha256 as string)
  ) {
    throw new Error(
      `Pinned engine ${component} requires a full revision and SHA-256`,
    );
  }
  const built = record(implementations[component], `${component} build`);
  if (
    built.revision !== source.revision ||
    built.source_sha256 !== source.sha256 ||
    built.entrypoint !== source.entrypoint ||
    typeof built.entrypoint_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(built.entrypoint_sha256)
  ) {
    throw new Error(
      `Pinned engine ${component} build is stale; run npm run build`,
    );
  }
  const entrypoint = source.entrypoint as string;
  const vendorRoot = await realpath(resolve(rootDirectory, 'vendor'));
  const localPath = await realpath(resolve(rootDirectory, entrypoint));
  const withinVendor = relative(vendorRoot, localPath);
  if (
    isAbsolute(entrypoint) ||
    isAbsolute(withinVendor) ||
    withinVendor === '..' ||
    withinVendor.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `Pinned engine ${component} must load from the local vendor directory`,
    );
  }
  const actualHash = createHash('sha256')
    .update(await readFile(localPath))
    .digest('hex');
  if (actualHash !== built.entrypoint_sha256) {
    throw new Error(
      `Pinned engine ${component} compiled entrypoint checksum mismatch`,
    );
  }
  return {
    repository: source.repository as string,
    revision: source.revision as string,
    sha256: source.sha256 as string,
    entrypoint: localPath,
    entrypointSha256: actualHash,
    loadedSource:
      component === 'world_model' ? 'world-model/reference' : 'vendor/hmem',
  };
}

export async function loadPinnedEngines(rootDirectory = repositoryRoot) {
  const manifest: unknown = JSON.parse(
    await readFile(resolve(rootDirectory, 'engine_sources.json'), 'utf8'),
  );
  const sources = record(record(manifest, 'manifest').sources, 'sources');
  let buildManifest: unknown;
  try {
    buildManifest = JSON.parse(
      await readFile(
        resolve(rootDirectory, 'vendor/engine_sources.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Pinned engines are not built; run npm run build', {
        cause: error,
      });
    }
    throw error;
  }
  const build = record(record(buildManifest, 'vendor manifest').build, 'build');
  const implementations = record(
    build.loaded_implementations,
    'loaded implementations',
  );
  const [starter, hmem, world_model] = await Promise.all([
    provenance(sources, implementations, 'starter', rootDirectory),
    provenance(sources, implementations, 'hmem', rootDirectory),
    provenance(sources, implementations, 'world_model', rootDirectory),
  ]);
  const starterMemoryPath = await realpath(
    resolve(dirname(starter.entrypoint), '../vendor/hmem/src/index.js'),
  );
  if (starterMemoryPath !== hmem.entrypoint) {
    throw new Error(
      'Starter H-MEM entrypoint does not match its pinned vendor source',
    );
  }

  const [starterValue, worldValue] = await Promise.all([
    import(pathToFileURL(starter.entrypoint).href) as Promise<unknown>,
    import(pathToFileURL(world_model.entrypoint).href) as Promise<unknown>,
  ]);
  const starterModule = record(starterValue, 'starter module');
  requireMethods(starterModule, ['loadHMEM'], 'starter module');
  const loadHMEM = starterModule.loadHMEM as () => Promise<unknown>;
  const loaded = record(await loadHMEM(), 'loaded H-MEM');
  if (loaded.source !== 'vendor/hmem') {
    throw new Error(
      'Starter must load pinned vendor/hmem; engine fallback is forbidden',
    );
  }
  const HMEM = engineConstructor<MemoryEngine>(
    loaded.HMEM,
    ['mine', 'query', 'feedback'],
    'H-MEM',
  );
  const worldModule = record(worldValue, 'World Model module');
  requireMethods(
    worldModule,
    ['entityIdFromName', 'externalId', 'nameSimilarity', 'decide'],
    'World Model utilities',
  );
  const WorldModel = engineConstructor<WorldEngine>(
    worldModule.WorldModel,
    [
      'upsertEntity',
      'ingest',
      'view',
      'events',
      'audit',
      'stateShapeCanonical',
    ],
    'World Model',
  );
  return {
    HMEM,
    WorldModel,
    utilities: worldModule as unknown as WorldUtilities,
    provenance: {
      starter: { ...starter, loadedSource: 'starter/loadHMEM' },
      hmem,
      world_model,
    },
  };
}

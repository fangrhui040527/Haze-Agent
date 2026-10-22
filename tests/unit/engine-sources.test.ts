import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const verifierUrl = new URL('../../scripts/engine-sources.mjs', import.meta.url)
  .href;

interface SourceManifest {
  workflow_versions: string;
  sources: Record<string, { source_path: string }>;
}

async function withFixture(
  run: (root: string, manifest: SourceManifest) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'haze-engine-sources-'));
  try {
    for (const relative of [
      'engine_sources.json',
      'package.json',
      'package-lock.json',
      'third_party',
    ]) {
      await cp(path.join(repositoryRoot, relative), path.join(root, relative), {
        recursive: true,
      });
    }
    const manifest = JSON.parse(
      await readFile(path.join(root, 'engine_sources.json'), 'utf8'),
    ) as SourceManifest;
    await cp(
      path.join(repositoryRoot, manifest.workflow_versions),
      path.join(root, manifest.workflow_versions),
      { recursive: true },
    );
    await run(root, manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function verify(root: string, method: 'verifySources' | 'verifyWorkflowPins') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { ${method} } = await import(${JSON.stringify(verifierUrl)}); await ${method}(process.argv[1]);`,
      root,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}

describe('engine provenance enforcement', () => {
  it('rejects modified upstream source and preserved lockfiles', async () => {
    await withFixture(async (root, manifest) => {
      const mutations = [
        ['starter', 'src/engine.ts'],
        ['hmem', 'reference/package-lock.json'],
      ] as const;
      for (const [source, relative] of mutations) {
        const file = path.join(
          root,
          manifest.sources[source]!.source_path,
          relative,
        );
        const original = await readFile(file);
        try {
          await appendFile(file, '\n');
          const result = verify(root, 'verifySources');
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            `Source checksum differs: ${source}/${relative}`,
          );
        } finally {
          await writeFile(file, original);
        }
      }
    });
  });

  it('rejects unexpected files inside a pinned source tree', async () => {
    await withFixture(async (root, manifest) => {
      await writeFile(
        path.join(
          root,
          manifest.sources.world_model!.source_path,
          'reference/src/untracked.ts',
        ),
        'export const untracked = true;\n',
      );
      const result = verify(root, 'verifySources');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Source file inventory differs: world_model',
      );
    });
  });

  it('rejects workflow dependency drift in package and lock manifests', async () => {
    await withFixture(async (root) => {
      for (const relative of ['package.json', 'package-lock.json']) {
        const file = path.join(root, relative);
        const original = await readFile(file, 'utf8');
        const manifest = JSON.parse(original) as {
          dependencies?: Record<string, string>;
          packages?: Record<string, { version?: string }>;
        };
        if (manifest.dependencies) {
          manifest.dependencies['@langchain/langgraph'] = '0.0.0';
        } else {
          manifest.packages!['node_modules/@langchain/langgraph']!.version =
            '0.0.0';
        }
        try {
          await writeFile(file, JSON.stringify(manifest));
          const result = verify(root, 'verifyWorkflowPins');
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'Workflow dependency pin differs: @langchain/langgraph',
          );
        } finally {
          await writeFile(file, original);
        }
      }
    });
  });
});

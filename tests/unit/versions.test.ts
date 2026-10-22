import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import workflowVersions from '../../app/workflow_versions.json' with { type: 'json' };

interface DependencyManifest {
  dependencies: Record<string, string>;
}

interface LockManifest {
  packages: Record<
    string,
    {
      version?: string;
      integrity?: string;
      dependencies?: Record<string, string>;
    }
  >;
}

describe('workflow dependency pins', () => {
  it('pins the complete LangGraph and saver dependency set', () => {
    expect(Object.keys(workflowVersions.dependencies).sort()).toEqual([
      '@langchain/core',
      '@langchain/langgraph',
      '@langchain/langgraph-checkpoint',
      '@langchain/langgraph-checkpoint-postgres',
      '@langchain/langgraph-checkpoint-sqlite',
      'zod',
    ]);
  });

  it('matches exact package and integrity-locked dependency versions', async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as DependencyManifest;
    const lockManifest = JSON.parse(
      await readFile(
        new URL('../../package-lock.json', import.meta.url),
        'utf8',
      ),
    ) as LockManifest;

    for (const [name, version] of Object.entries(
      workflowVersions.dependencies,
    )) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(packageManifest.dependencies[name], name).toBe(version);
      expect(lockManifest.packages['']?.dependencies?.[name], name).toBe(
        version,
      );
      expect(lockManifest.packages[`node_modules/${name}`]?.version, name).toBe(
        version,
      );
      expect(
        lockManifest.packages[`node_modules/${name}`]?.integrity,
        name,
      ).toMatch(/^sha512-/);
    }
  });
});

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openHazeEngines,
  type Observation,
} from '../../app/adapters/meterless/index.js';
import { loadPinnedEngines } from '../../app/adapters/meterless/loader.js';

describe('pinned engine adapters', () => {
  it('uses starter-vendored H-MEM for mining, ranked recall, feedback and durable audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-engines-'));
    const options = {
      memoryDirectory: join(directory, 'memory'),
      worldDirectory: join(directory, 'world'),
      namespace: 'haze-test',
      clock: () => Date.parse('2026-10-22T10:00:00Z'),
    };
    try {
      const engines = await openHazeEngines(options);
      expect(engines.provenance.hmem.loadedSource).toBe('vendor/hmem');
      expect(normalize(engines.provenance.hmem.entrypoint)).toContain(
        normalize('templates/agentathon-starter/vendor/hmem/src/index.js'),
      );
      for (const pin of Object.values(engines.provenance)) {
        expect(pin.revision).toMatch(/^[a-f0-9]{40}$/);
        expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(pin.entrypointSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(await readFile(pin.entrypoint, 'utf8')).not.toHaveLength(0);
      }

      const [mined] = await engines.memory.mine(
        'user_correction',
        'Always use SQLite for local checkpoint persistence.',
        { chatId: 'chat-1' },
      );
      expect(mined).toBeDefined();
      if (!mined)
        throw new Error('Upstream mining did not capture the correction');
      expect(mined.provenance.origin).toBe('user_correction');
      await engines.memory.mine(
        'chat_message',
        'Always review calendar appointments before the weekly planning meeting.',
      );
      const confidence = mined.confidence;
      engines.memory.feedback(mined.id, 'helpful');
      const recalled = engines.memory.query(mined.content, { threshold: 0 });
      expect(recalled.memories).toHaveLength(2);
      expect(recalled.memories[0]?.memory.id).toBe(mined.id);
      expect(recalled.memories[0]?.memory.confidence).toBeCloseTo(
        confidence + 0.05,
      );
      expect(recalled.trace.scores[mined.id]).toBeGreaterThan(0);
      expect(recalled.context).toContain(mined.content);

      const restarted = await openHazeEngines(options);
      const persisted = restarted.memory.query(mined.content, { threshold: 0 });
      expect(persisted.memories[0]?.memory.id).toBe(mined.id);
      expect(persisted.memories[0]?.memory.confidence).toBeCloseTo(
        confidence + 0.05,
      );
      expect(
        restarted.memory.history(mined.id).map((entry) => entry.action),
      ).toEqual(expect.arrayContaining(['create', 'feedback', 'read']));
      expect(
        restarted.memory.audit().find((entry) => entry.action === 'feedback'),
      ).toMatchObject({
        memoryId: mined.id,
        actor: 'haze',
        details: { kind: 'helpful', delta: 0.05 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delegates stable IDs, resolution, events and projection rebuilds to the separate World Model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-world-'));
    const options = {
      memoryDirectory: join(directory, 'memory'),
      worldDirectory: join(directory, 'world'),
      namespace: 'haze-test',
    };
    const observation: Observation = {
      externalId: 'document-1',
      title: 'Haze adopts SQLite',
      at: '2026-10-22T10:00:00.000Z',
      source: { kind: 'file', at: '2026-10-22T10:00:00.000Z', runId: 'run-1' },
      entities: [{ type: 'project', name: 'Haze Agent' }],
    };
    try {
      const engines = await openHazeEngines(options);
      expect(normalize(engines.provenance.world_model.entrypoint)).toContain(
        normalize('engines/world-model/reference/src/index.js'),
      );
      const id = engines.world.entityId('project', 'Haze Agent');
      expect(engines.world.entityId('project', '  HAZE   Agent ')).toBe(id);
      expect(engines.world.nameSimilarity('Haze Agent', 'haze agent')).toBe(1);
      expect(engines.world.resolutionDecision(0.85)).toBe('auto-merge');
      expect(engines.world.resolutionDecision(0.82)).toBe('review');
      await engines.world.upsertEntity({
        type: 'project',
        name: 'Haze Agent',
        source: observation.source,
      });
      const resolved = await engines.world.upsertEntity({
        type: 'project',
        name: 'Haze Agents',
        source: observation.source,
      });
      const aliasId = engines.world.entityId('project', 'Haze Agents');
      expect(resolved.id).toBe(id);
      expect(engines.world.entity(aliasId)?.id).toBe(id);
      expect(
        engines.world.events().some((event) => event.kind === 'alias'),
      ).toBe(true);
      const initial = await engines.world.ingest([observation]);
      expect(initial.processed).toBe(1);
      expect(initial.eventsAppended).toBeGreaterThan(0);
      const projection = engines.world.projectionCanonical();
      const events = [...engines.world.events()];
      expect(engines.world.entity(id)?.name).toBe('Haze Agent');

      const restarted = await openHazeEngines(options);
      expect(restarted.world.entity(id)?.name).toBe('Haze Agent');
      expect(restarted.world.entity(aliasId)?.id).toBe(id);
      expect(restarted.world.events()).toEqual(events);
      // Upstream rebuilds derived aggregates during ingest, including replayed batches.
      const replay = await restarted.world.ingest([observation]);
      expect(replay).toMatchObject({
        processed: 0,
        skippedUnchanged: 1,
        eventsAppended: 0,
      });
      expect(restarted.world.projectionCanonical()).toBe(projection);
      expect(
        restarted.world.audit().some((entry) => entry.kind === 'ingest'),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit persistence directories and a file-safe namespace', async () => {
    await expect(
      openHazeEngines({
        memoryDirectory: '',
        worldDirectory: 'state',
        namespace: 'haze',
      }),
    ).rejects.toThrow('explicit');
    await expect(
      openHazeEngines({
        memoryDirectory: 'state',
        worldDirectory: ' ',
        namespace: 'haze',
      }),
    ).rejects.toThrow('explicit');
    await expect(
      openHazeEngines({
        memoryDirectory: 'state',
        worldDirectory: 'state',
        namespace: '../escape',
      }),
    ).rejects.toThrow('namespace');
  });

  it('fails clearly when the pinned source has not been build-vendored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-unbuilt-engines-'));
    try {
      await copyFile(
        new URL('../../engine_sources.json', import.meta.url),
        join(directory, 'engine_sources.json'),
      );
      await expect(loadPinnedEngines(directory)).rejects.toThrow(
        'npm run build',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a changed compiled entrypoint before executing engine code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-modified-engines-'));
    try {
      const sourceText = await readFile(
        new URL('../../engine_sources.json', import.meta.url),
        'utf8',
      );
      const manifest = JSON.parse(sourceText) as {
        sources: Record<string, { entrypoint: string }>;
      };
      await writeFile(join(directory, 'engine_sources.json'), sourceText);
      await mkdir(join(directory, 'vendor'));
      await copyFile(
        new URL('../../vendor/engine_sources.json', import.meta.url),
        join(directory, 'vendor/engine_sources.json'),
      );
      for (const source of Object.values(manifest.sources)) {
        const entrypoint = join(directory, source.entrypoint);
        await mkdir(dirname(entrypoint), { recursive: true });
        await writeFile(
          entrypoint,
          'throw new Error("Unverified engine was executed");',
        );
      }
      await expect(loadPinnedEngines(directory)).rejects.toThrow(
        'compiled entrypoint checksum mismatch',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

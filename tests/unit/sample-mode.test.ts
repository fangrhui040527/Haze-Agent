import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sampleModeEnabled,
  sampleStateDirectory,
} from '../../app/adapters/sample-mode.js';
import { createSamplePm25Source } from '../../app/sample-data/pm25-source.js';
import { loadSampleScenario } from '../../app/sample-data/index.js';
import { createExecutionRegistry } from '../../app/composition.js';
import { PM25_SOURCE_ID } from '../../app/capabilities/pm25/evidence.js';
import { loadDashboardConfig } from '../../app/dashboard/config.js';
import {
  analyzePm25,
  independentlyCheckPm25,
} from '../../app/capabilities/pm25/methods.js';

describe('sample evidence with genuine model execution', () => {
  it('isolates the default sample store from an existing live .env', () => {
    const env = { SAMPLE_MODE: 'true', STATE_DIR: '.state/general-v2' };
    expect(sampleModeEnabled(env)).toBe(true);
    expect(loadDashboardConfig({ SAMPLE_MODE: 'TRUE' }).sampleMode).toBe(true);
    expect(sampleStateDirectory(env)).toBe('.state/sample-mode');
    expect(
      sampleStateDirectory({ ...env, HAZE_TASK_STATE_DIR: '.state/custom' }),
    ).toBe('.state/custom');
    expect(sampleStateDirectory({ ...env, SAMPLE_MODE: 'false' })).toBe(
      '.state/general-v2',
    );
  });

  it('reads raw local rows and runs the ordinary calculation and independent check', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No external data requests are permitted.'));
    try {
      const sample = await loadSampleScenario('evidence-investigation');
      if (!('capture' in sample)) throw new Error('Expected PM2.5 data.');
      const capture = await createSamplePm25Source().retrieve(
        sample.manifest.scope,
        new AbortController().signal,
      );
      expect(capture.mode).toBe('live');
      expect(capture.evidence_origin).toBe('synthetic_fixture');
      expect(capture.selection.backend).toBe('sample-file');
      expect(capture.raw).toBe(sample.capture.raw);
      const analysis = analyzePm25(capture, sample.manifest.scope);
      expect(analysis.coverage.status).toBe('partial');
      expect(analysis.coverage.usable_row_count).toBe(4);
      expect(
        independentlyCheckPm25(capture, analysis, sample.manifest.scope).valid,
      ).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('reports unsupported scope instead of silently inventing or fetching data', async () => {
    const sample = await loadSampleScenario('evidence-investigation');
    if (!('capture' in sample)) throw new Error('Expected PM2.5 data.');
    await expect(
      createSamplePm25Source().retrieve(
        { ...sample.manifest.scope, location: 'Unsupported town' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', outcome: 'failed' });
  });

  it('filters previously unshipped periods from the cached rows', async () => {
    const sample = await loadSampleScenario('evidence-investigation');
    if (!('capture' in sample)) throw new Error('Expected PM2.5 data.');
    const scope = {
      ...sample.manifest.scope,
      period: {
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-01T02:00:00Z',
      },
    };
    const capture = await createSamplePm25Source().retrieve(
      scope,
      new AbortController().signal,
    );
    const analysis = analyzePm25(capture, scope);
    expect(analysis.coverage.usable_row_count).toBe(2);
    expect(analysis.coverage.status).toBe('available');
    expect(analysis.range).toEqual({ min: 22, max: 28 });
  });

  it('recomputes changed values from an arbitrary local input file', async () => {
    const sample = await loadSampleScenario('evidence-investigation');
    if (!('capture' in sample)) throw new Error('Expected PM2.5 data.');
    const directory = await mkdtemp(join(tmpdir(), 'haze-sample-input-'));
    const filename = join(directory, 'changed-input.json');
    try {
      const edited = structuredClone(sample.capture);
      const raw = JSON.parse(edited.raw) as { data: { pm25: number | null }[] };
      edited.rows[0]!.value = 7;
      raw.data[0]!.pm25 = 7;
      edited.raw = JSON.stringify(raw);
      await writeFile(filename, JSON.stringify(edited));
      const capture = await createSamplePm25Source({
        HAZE_SAMPLE_PM25_FILE: filename,
      }).retrieve(sample.manifest.scope, new AbortController().signal);
      const original = analyzePm25(sample.capture, sample.manifest.scope);
      const changed = analyzePm25(capture, sample.manifest.scope);
      expect(changed.range).toEqual({ min: 7, max: 64 });
      expect(changed.range).not.toEqual(original.range);
      expect(
        independentlyCheckPm25(capture, changed, sample.manifest.scope).valid,
      ).toBe(true);
    } finally {
      await unlink(filename);
      await rmdir(directory);
    }
  });

  it('registers ordinary agents and live tools rather than fixture execution', () => {
    const registry = createExecutionRegistry({
      mode: 'live',
      env: { SAMPLE_MODE: 'true' },
    });
    expect(registry.tools.get(PM25_SOURCE_ID)?.mode).toBe('live');
    expect([...registry.agents.keys()]).toEqual([
      'Manager',
      'HazeOps',
      'WorkerShield',
      'EvidenceCritic',
      'DamageAccountant',
    ]);
  });
});

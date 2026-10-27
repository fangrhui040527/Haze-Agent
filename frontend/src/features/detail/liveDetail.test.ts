import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../mock/generator/generate.ts';
import type { HazeItem, ItemDetail } from '../../shared/types/domain.ts';
import { latestLiveItem, refreshLiveDetail } from './liveDetail.ts';

const dataset = generateDataset({
  seed: 4,
  itemCount: 10,
  now: new Date('2026-10-25T00:00:00Z'),
});
const item: HazeItem = { ...dataset.items[0], revision: 2 };
const detail: ItemDetail = {
  item,
  location: dataset.locations[0],
  sources: dataset.sources,
  related: [],
};

describe('detail page live evidence updates', () => {
  it('finds a newer queued revision even while its old table row remains visible', () => {
    const queued = { ...item, revision: 3 };
    const latest = latestLiveItem(item.id, [item], [queued]);
    expect(latest).toBe(queued);
    // New observations retain the detail page's explicit Load it interaction.
    expect(refreshLiveDetail(detail, latest)).toBe(detail);
  });

  it('updates same-revision freshness, checks and agent receipts from the stream', () => {
    const stale: HazeItem = {
      ...item,
      status: 'stale',
      checks: [
        {
          id: 'coverage.freshness',
          label: 'Fresh',
          result: 'fail',
          detail: 'Newest value exceeds the freshness limit.',
        },
      ],
      agentResults: [
        {
          agent: 'hazeops',
          outcome: 'warning',
          summary: 'The retained observation is stale.',
          durationMs: 0,
        },
      ],
    };
    const next = refreshLiveDetail(
      detail,
      latestLiveItem(item.id, [item], [stale]),
    );
    expect(next.item).toBe(stale);
    expect(next.sources).toBe(detail.sources);
    expect(next.location).toBe(detail.location);
    expect(next.related).toBe(detail.related);
  });

  it('does not downgrade the detail or hide a newer visible row behind an old queue', () => {
    const older = { ...item, revision: 1 };
    expect(latestLiveItem(item.id, [item], [older])).toBe(item);
    expect(refreshLiveDetail(detail, older)).toBe(detail);
  });

  it('ignores updates for a different route and missing rows', () => {
    const elsewhere = { ...item, id: 'another-item' };
    expect(latestLiveItem(item.id, [elsewhere], [])).toBeNull();
    expect(refreshLiveDetail(detail, elsewhere)).toBe(detail);
    expect(refreshLiveDetail(detail, null)).toBe(detail);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { HttpAgentService } from './HttpAgentService.ts';
import { previewView } from '../../features/damage-reduction/preview-test-fixtures.ts';
import { taskId } from './testFixtures.ts';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
describe('governed planning preview browser read', () => {
  it('reads current server-owned eligibility with same-origin no-store requests', async () => {
    const view = previewView();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    const result = await new HttpAgentService('', fetcher).readReductionPreview(
      taskId,
    );
    expect(result).toEqual(view);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/tasks/${taskId}/views/reduction-preview`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });
  it('rejects another task response and forged achieved-effect or qualification flags', async () => {
    const wrong = previewView();
    wrong.task_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(
      new HttpAgentService(
        '',
        vi.fn<typeof fetch>().mockResolvedValue(json(wrong)),
      ).readReductionPreview(taskId),
    ).rejects.toThrow('another saved task');
    const forged = previewView();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ...forged,
        claims: {
          ...forged.claims,
          achieved_reduction: true,
          scientific_qualification: 'qualified',
        },
      }),
    );
    await expect(
      new HttpAgentService('', fetcher).readReductionPreview(taskId),
    ).rejects.toThrow();
  });
  it('surfaces inaccessible product reads instead of reusing a historical label', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(
          { error: { message: 'The selected evidence is inaccessible.' } },
          403,
        ),
      );
    await expect(
      new HttpAgentService('', fetcher).readReductionPreview(taskId),
    ).rejects.toThrow('inaccessible');
  });
});

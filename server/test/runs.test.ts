import { describe, expect, it } from 'vitest';
import { detectTaskKind, Manager } from '../src/manager/manager.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import {
  composeAnswer,
  detectIntent,
  findLocations,
} from '../src/runs/answer.ts';
import { KLANG } from './helpers.ts';

const SHAH_ALAM = {
  ...KLANG,
  id: 'shah-alam',
  name: 'Shah Alam',
  lat: 3.0733,
  lon: 101.5185,
};

describe('question parsing', () => {
  it('finds places in the order they are named', () => {
    expect(
      findLocations('Compare Shah Alam and Klang', [KLANG, SHAH_ALAM]).map(
        (l) => l.id,
      ),
    ).toEqual(['shah-alam', 'klang']);
  });

  it('detects intents', () => {
    expect(detectIntent('Will it get worse tomorrow?', 1)).toBe('forecast');
    expect(detectIntent('Is it safe to work outside?', 1)).toBe('health');
    expect(detectIntent('Klang vs Shah Alam', 2)).toBe('compare');
    expect(detectIntent('How is it?', 1)).toBe('overview');
  });
});

describe('answers', () => {
  it('declines health advice and says no AI model wrote the answer', () => {
    const answer = composeAnswer({
      question: 'Is it safe to work outside in Klang?',
      intent: 'health',
      places: [KLANG],
      defaulted: false,
      items: [],
      nearby: new Map(),
      recalled: [],
      refreshNote: null,
    });
    const text = answer.paragraphs.join(' ');
    expect(text).toContain('does not give health or safety advice');
    expect(text).toContain('not written by an AI model');
  });
});

describe('manager', () => {
  it('keeps the request word for word and frames it', () => {
    const framing = new Manager().frame(
      { question: 'How bad is it in Shah Alam?', focusItemId: null },
      [KLANG, SHAH_ALAM],
    );
    expect(framing.objective.text).toBe('How bad is it in Shah Alam?');
    expect(framing.places.map((p) => p.id)).toEqual(['shah-alam']);
    expect(framing.kind).toBe('general');
  });

  it('recognises the two task kinds', () => {
    expect(detectTaskKind('Plan the crew schedule for Klang tomorrow')).toBe(
      'scheduling',
    );
    expect(
      detectTaskKind('How do we recover the revenue we lost to the haze?'),
    ).toBe('revenue_recovery');
    expect(detectTaskKind('Will it get worse tomorrow?')).toBe('general');
  });

  it('records assignments', () => {
    const manager = new Manager();
    const question = 'Is the Klang data fresh?';
    const framing = manager.frame({ question, focusItemId: null }, [KLANG]);
    const brief = manager.assign(framing, 'run_1', 'hazeops', 'Fresh records');
    expect(brief.objective.text).toBe(question);
    expect(brief.placeIds).toEqual(['klang']);
    manager.finish(brief.assignmentId, 'completed', 'ok');
    expect(manager.assignments()[0]).toMatchObject({
      agent: 'hazeops',
      state: 'completed',
    });
  });
});

describe('runtime', () => {
  it('coalesces a job requested twice', async () => {
    const runtime = new Runtime();
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return runs;
    };
    const a = runtime.admit('watcher:x', 'x', 1000, work);
    const b = runtime.admit('watcher:x', 'x', 1000, work);
    expect(b.coalesced).toBe(true);
    expect(await a.promise).toBe(1);
    expect(await b.promise).toBe(1);
  });

  it('records a failed job', async () => {
    const runtime = new Runtime();
    const job = runtime.admit('k', 'boom', 1000, () =>
      Promise.reject(new Error('boom')),
    );
    await expect(job.promise).rejects.toThrow('boom');
    expect(runtime.jobs()[0]).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('times a job out at its own deadline', async () => {
    const runtime = new Runtime();
    const job = runtime.admit(
      'slow',
      'slow',
      20,
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stopped'))),
        ),
    );
    await expect(job.promise).rejects.toThrow('stopped');
    expect(runtime.jobs()[0]).toMatchObject({ state: 'timed_out' });
  });
});

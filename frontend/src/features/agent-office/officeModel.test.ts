import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/types/agents.ts';
import {
  DIVIDER_COL,
  DOOR_ROWS,
  findPath,
  isWalkable,
  MEETING_SPOT,
  pointToTile,
  STATIONS,
} from './officeLayout.ts';
import { deriveAgentStatuses, OfficeModel } from './officeModel.ts';

const base = { runId: 'r1', at: '2026-10-23T12:00:00Z', message: '' };

describe('deriveAgentStatuses', () => {
  it('follows a run step by step', () => {
    const events: AgentEvent[] = [
      { ...base, type: 'run_started' },
      {
        ...base,
        type: 'handoff',
        from: 'manager',
        to: ['hazeops'],
        payloadLabel: 'task',
      },
      {
        ...base,
        type: 'agent_working',
        agent: 'hazeops',
        message: 'HazeOps is gathering data…',
      },
    ];
    const s = deriveAgentStatuses(events);
    expect(s.hazeops).toEqual({
      state: 'working',
      text: 'HazeOps is gathering data',
    });
    expect(s.manager.text).toContain('Handed task to HazeOps');
    expect(s.evidencecritic.state).toBe('idle');
  });

  it('never invents per-agent steps when only run state is known (level B)', () => {
    const s = deriveAgentStatuses([
      { ...base, type: 'run_started' },
      { ...base, type: 'run_state', state: 'running' },
    ]);
    expect(s.evidencecritic.text).toBe('Working (step details unavailable)');
  });

  it('marks the failing agent', () => {
    const s = deriveAgentStatuses([
      { ...base, type: 'run_started' },
      {
        ...base,
        type: 'run_failed',
        agent: 'evidencecritic',
        error: 'timeout',
        retryable: true,
      },
    ]);
    expect(s.evidencecritic.state).toBe('error');
    expect(s.manager.state).toBe('error');
  });
});

describe('OfficeModel', () => {
  it('walks the Manager to the office and back', () => {
    const model = new OfficeModel();
    model.apply(
      { ...base, type: 'agent_moving', agent: 'manager', to: 'office' },
      0,
      false,
    );
    expect(model.actors.get('manager')?.pose).toBe('walking');
    for (let t = 0; t < 5000; t += 50) model.update(50, t);
    const m = model.actors.get('manager')!;
    expect(m.pose).toBe('idle');
    expect(m.pos.x).toBeGreaterThan(STATIONS.manager.seat.x + 100);

    model.apply({ ...base, type: 'run_completed' }, 5000, true);
    expect(model.actors.get('manager')?.pos).toEqual(STATIONS.manager.seat);
  });

  it('uses desk highlights instead of moving packets when motion is reduced', () => {
    const model = new OfficeModel();
    model.apply(
      {
        ...base,
        type: 'handoff',
        from: 'manager',
        to: ['hazeops'],
        payloadLabel: 'task',
      },
      0,
      true,
    );
    expect(model.packets).toHaveLength(0);
    expect(model.highlights.has('hazeops')).toBe(true);
  });
});

describe('office layout', () => {
  it('routes the Manager through the door, never through walls or furniture', () => {
    const path = findPath(STATIONS.manager.seat, MEETING_SPOT);
    const tiles = path.map(pointToTile);
    expect(tiles.at(-1)).toEqual(pointToTile(MEETING_SPOT));
    for (const t of tiles.slice(0, -1))
      expect(isWalkable(t), JSON.stringify(t)).toBe(true);
    const crossing = tiles.find((t) => t.col === DIVIDER_COL);
    expect((DOOR_ROWS as readonly number[]).includes(crossing!.row)).toBe(true);
    // Each step moves exactly one tile.
    let prev = pointToTile(STATIONS.manager.seat);
    for (const t of tiles) {
      expect(Math.abs(t.col - prev.col) + Math.abs(t.row - prev.row)).toBe(1);
      prev = t;
    }
  });

  it('can reach every desk from the meeting spot', () => {
    for (const s of Object.values(STATIONS)) {
      expect(pointToTile(findPath(MEETING_SPOT, s.seat).at(-1)!)).toEqual(
        s.seatTile,
      );
      expect(findPath(MEETING_SPOT, s.seat).length).toBeGreaterThan(1);
    }
  });
});

describe('ambient behaviour', () => {
  const run = (model: OfficeModel, from: number, to: number) => {
    for (let t = from; t < to; t += 50) model.update(50, t);
  };

  it('lets idle agents wander between runs and sends them back when a run starts', () => {
    const model = new OfficeModel({ ambient: true, random: () => 0 });
    run(model, 0, 10_000);
    const wanderers = [...model.actors.values()].filter(
      (a) =>
        a.pos.x !== STATIONS[a.id].seat.x || a.pos.y !== STATIONS[a.id].seat.y,
    );
    expect(wanderers.length).toBeGreaterThan(0);
    expect(wanderers.some((a) => a.id === 'manager')).toBe(false);

    model.apply({ ...base, type: 'run_started' }, 10_000, false);
    run(model, 10_000, 20_000);
    for (const a of model.actors.values())
      expect(a.pos).toEqual(STATIONS[a.id].seat);
  });

  it('takes the pose on arrival when an event reaches an agent that is away', () => {
    const model = new OfficeModel({ ambient: true, random: () => 0 });
    run(model, 0, 10_000);
    const away = [...model.actors.values()].find(
      (a) => a.wander.state !== 'home',
    )!;
    model.apply(
      { ...base, type: 'agent_working', agent: away.id, message: '' },
      10_000,
      false,
    );
    run(model, 10_000, 20_000);
    expect(away.pose).toBe('working');
    expect(away.pos).toEqual(STATIONS[away.id].seat);
  });

  it('does nothing ambient unless asked (reduced motion)', () => {
    const model = new OfficeModel();
    run(model, 0, 60_000);
    for (const a of model.actors.values())
      expect(a.pos).toEqual(STATIONS[a.id].seat);
  });
});

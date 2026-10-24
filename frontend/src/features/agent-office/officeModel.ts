import {
  AGENT_IDS,
  AGENT_INFO,
  type AgentEvent,
  type AgentId,
} from '../../shared/types/agents.ts';
import {
  findPath,
  HANGOUTS,
  MEETING_SPOT,
  STATIONS,
  tileToPoint,
  WALK_SPEED_PX_PER_S,
  WALKABLE_TILES,
  type Facing,
  type Point,
} from './officeLayout.ts';

export type Pose =
  'idle' | 'thinking' | 'walking' | 'working' | 'done' | 'error';

/** Idle wandering between runs (decoration only, never driven by events). */
type Wander =
  | { state: 'home'; nextAt: number | null }
  | { state: 'going' | 'returning'; facing: Facing }
  | { state: 'there'; until: number; facing: Facing };

export interface Actor {
  id: AgentId;
  pos: Point;
  path: Point[];
  pose: Pose;
  facing: Facing;
  /** Pose to take when the current walk ends. */
  arrivalPose: Pose;
  /** A 'done' pose reverts to idle at this time (ms). */
  poseUntil: number | null;
  wander: Wander;
}

export interface Pet {
  pos: Point;
  path: Point[];
  facing: 'left' | 'right';
  /** Sitting until this time (ms); walks somewhere new afterwards. */
  restUntil: number;
}

export interface Packet {
  from: Point;
  to: Point;
  start: number;
  duration: number;
  label: string;
  /** Who receives it (picks the icon). */
  toAgent: AgentId;
}

export interface OfficeOptions {
  /** Idle agents wander and the cat walks around between runs. Off for reduced motion. */
  ambient?: boolean;
  /** Random source for the ambient behaviour (tests pass a fixed one). */
  random?: () => number;
}

const DONE_MS = 1500;
const PACKET_MS = 700;
const HIGHLIGHT_MS = 1200;
const WANDER_DELAY_MS: [number, number] = [8_000, 25_000];
const WANDER_STAY_MS: [number, number] = [2_500, 6_000];
const PET_REST_MS: [number, number] = [3_000, 9_000];

const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= 1;

/**
 * The office's state, driven ONLY by AgentEvents (so a real backend can drive it too).
 * `instant` applies an event without animation (reduced motion, or catching up after remount).
 * The optional ambient behaviour (wandering, the cat) only runs while no run is in progress.
 */
export class OfficeModel {
  actors = new Map<AgentId, Actor>();
  packets: Packet[] = [];
  /** Desk highlights (used instead of moving packets when motion is reduced). */
  highlights = new Map<AgentId, number>();
  pet: Pet = {
    pos: tileToPoint({ col: 3, row: 8 }),
    path: [],
    facing: 'right',
    restUntil: 0,
  };
  /** True between run_started and the end of the run. */
  runActive = false;

  /** Wandering and the cat; can be switched off at any time (reduced motion). */
  ambient: boolean;
  private readonly random: () => number;

  constructor(options: OfficeOptions = {}) {
    this.ambient = options.ambient ?? false;
    this.random = options.random ?? Math.random;
    this.reset();
  }

  reset(): void {
    this.packets = [];
    this.highlights.clear();
    this.runActive = false;
    for (const id of AGENT_IDS) {
      this.actors.set(id, {
        id,
        pos: { ...STATIONS[id].seat },
        path: [],
        pose: 'idle',
        facing: 'down',
        arrivalPose: 'idle',
        poseUntil: null,
        wander: { state: 'home', nextAt: null },
      });
    }
  }

  private actor(id: AgentId): Actor {
    const a = this.actors.get(id);
    if (!a) throw new Error(`Unknown agent ${id}`);
    return a;
  }

  private between([min, max]: [number, number]): number {
    return min + this.random() * (max - min);
  }

  private walk(
    id: AgentId,
    to: Point,
    arrivalPose: Pose,
    instant: boolean,
  ): void {
    const a = this.actor(id);
    a.arrivalPose = arrivalPose;
    a.poseUntil = null;
    if (instant || near(a.pos, to)) {
      a.pos = { ...to };
      a.path = [];
      a.pose = arrivalPose;
      a.facing = 'down';
    } else {
      a.path = findPath(a.pos, to);
      a.pose = 'walking';
    }
  }

  private isHome(a: Actor): boolean {
    return a.path.length === 0 && near(a.pos, STATIONS[a.id].seat);
  }

  private setPose(id: AgentId, pose: Pose, now: number, instant = false): void {
    const a = this.actor(id);
    // A wandering agent goes back to its desk first, then takes the pose.
    if (id !== 'manager' && !this.isHome(a) && a.wander.state !== 'home') {
      a.wander = { state: 'home', nextAt: null };
      this.walk(id, STATIONS[id].seat, pose, instant);
      return;
    }
    if (a.path.length > 0) {
      a.arrivalPose = pose; // still walking: take this pose on arrival
      return;
    }
    a.pose = pose;
    a.poseUntil = pose === 'done' ? now + DONE_MS : null;
  }

  private managerIsAway(): boolean {
    return !this.isHome(this.actor('manager'));
  }

  private sendEveryoneHome(instant: boolean): void {
    for (const a of this.actors.values()) {
      if (a.id === 'manager' || a.wander.state === 'home') continue;
      a.wander = { state: 'home', nextAt: null };
      this.walk(a.id, STATIONS[a.id].seat, 'idle', instant);
    }
  }

  private endRun(managerPose: Pose, instant: boolean, now: number): void {
    this.runActive = false;
    for (const a of this.actors.values())
      a.wander = { state: 'home', nextAt: null };
    if (this.managerIsAway())
      this.walk('manager', STATIONS.manager.seat, managerPose, instant);
    else this.setPose('manager', managerPose, now);
  }

  apply(event: AgentEvent, now: number, instant: boolean): void {
    switch (event.type) {
      case 'run_started':
        this.packets = [];
        this.highlights.clear();
        for (const a of this.actors.values()) {
          a.pose = a.path.length > 0 ? 'walking' : 'idle';
          a.arrivalPose = 'idle';
          a.poseUntil = null;
        }
        this.sendEveryoneHome(instant);
        if (this.managerIsAway())
          this.walk('manager', STATIONS.manager.seat, 'idle', instant);
        this.runActive = true;
        break;
      case 'run_state':
        this.runActive = true;
        if (event.state === 'queued') this.setPose('manager', 'thinking', now);
        else {
          this.walk('manager', MEETING_SPOT, 'idle', instant);
          for (const id of AGENT_IDS)
            if (id !== 'manager') this.setPose(id, 'working', now, instant);
        }
        break;
      case 'agent_thinking':
        this.setPose(event.agent, 'thinking', now, instant);
        break;
      case 'agent_moving':
        this.walk(
          event.agent,
          event.to === 'office' ? MEETING_SPOT : STATIONS[event.agent].seat,
          'idle',
          instant,
        );
        break;
      case 'handoff': {
        const from = this.actor(event.from);
        if (from.path.length === 0 && from.pose !== 'done')
          this.setPose(event.from, 'idle', now, instant);
        for (const to of event.to) {
          const target = this.actor(to);
          if (instant) this.highlights.set(to, now + HIGHLIGHT_MS);
          else {
            this.packets.push({
              from: { ...from.pos },
              // Aim at where the receiver will be (its desk), even if it is still walking back.
              to: { ...(target.path.at(-1) ?? target.pos) },
              start: now,
              duration: PACKET_MS,
              label: event.payloadLabel,
              toAgent: to,
            });
          }
        }
        break;
      }
      case 'agent_working':
        this.setPose(event.agent, 'working', now, instant);
        break;
      case 'agent_completed':
        this.setPose(event.agent, 'done', now, instant);
        break;
      case 'run_completed':
        for (const id of AGENT_IDS)
          if (id !== 'manager') this.setPose(id, 'idle', now, instant);
        this.endRun('done', instant, now);
        break;
      case 'run_failed':
        if (event.agent && event.agent !== 'manager')
          this.setPose(event.agent, 'error', now, instant);
        this.endRun('error', instant, now);
        break;
      case 'run_cancelled':
        for (const id of AGENT_IDS)
          if (id !== 'manager') this.setPose(id, 'idle', now, instant);
        this.endRun('idle', instant, now);
        break;
    }
  }

  /** Advance animation by `dtMs`. */
  update(dtMs: number, now: number): void {
    // Cap large gaps (e.g. after switching tabs) but keep real-time speed on slow/throttled devices.
    const step = (WALK_SPEED_PX_PER_S * Math.min(dtMs, 1000)) / 1000;
    for (const a of this.actors.values()) {
      const facing = moveAlong(a, step);
      if (facing) a.facing = facing;
      if (a.pose === 'walking' && a.path.length === 0) {
        a.pose = a.arrivalPose;
        a.poseUntil = a.pose === 'done' ? now + DONE_MS : null;
        a.facing = 'down';
      }
      if (a.poseUntil !== null && now >= a.poseUntil) {
        a.pose = 'idle';
        a.poseUntil = null;
      }
      if (this.ambient) this.updateWander(a, now);
    }
    if (this.ambient) this.updatePet(step, now);
    this.packets = this.packets.filter((p) => now - p.start < p.duration);
    for (const [id, until] of this.highlights)
      if (now >= until) this.highlights.delete(id);
  }

  private updateWander(a: Actor, now: number): void {
    if (a.id === 'manager' || this.runActive) return;
    const w = a.wander;
    switch (w.state) {
      case 'home': {
        if (!this.isHome(a) || a.pose !== 'idle') return;
        if (w.nextAt === null) {
          w.nextAt = now + this.between(WANDER_DELAY_MS);
          return;
        }
        if (now < w.nextAt) return;
        const taken = new Set(
          [...this.actors.values()]
            .filter((o) => o !== a && o.wander.state !== 'home')
            .map((o) => {
              const end = o.path.at(-1) ?? o.pos;
              return `${Math.round(end.x)},${Math.round(end.y)}`;
            }),
        );
        const free = HANGOUTS.filter((h) => {
          const p = tileToPoint(h.tile);
          return !taken.has(`${p.x},${p.y}`);
        });
        const spot = free[Math.floor(this.random() * free.length)];
        if (!spot) {
          w.nextAt = now + this.between(WANDER_DELAY_MS);
          return;
        }
        a.wander = { state: 'going', facing: spot.facing };
        this.walk(a.id, tileToPoint(spot.tile), 'idle', false);
        return;
      }
      case 'going':
        if (a.path.length === 0) {
          a.wander = {
            state: 'there',
            until: now + this.between(WANDER_STAY_MS),
            facing: w.facing,
          };
          a.facing = w.facing;
        }
        return;
      case 'there':
        a.facing = w.facing;
        if (now >= w.until) {
          a.wander = { state: 'returning', facing: 'down' };
          this.walk(a.id, STATIONS[a.id].seat, 'idle', false);
        }
        return;
      case 'returning':
        if (a.path.length === 0)
          a.wander = {
            state: 'home',
            nextAt: now + this.between(WANDER_DELAY_MS),
          };
        return;
    }
  }

  private updatePet(step: number, now: number): void {
    const pet = this.pet;
    const facing = moveAlong(pet, step * 0.6);
    if (facing === 'left' || facing === 'right') pet.facing = facing;
    if (pet.path.length > 0) return;
    if (pet.restUntil === 0) pet.restUntil = now + this.between(PET_REST_MS);
    if (now < pet.restUntil) return;
    const target =
      WALKABLE_TILES[Math.floor(this.random() * WALKABLE_TILES.length)];
    if (target) pet.path = findPath(pet.pos, tileToPoint(target));
    pet.restUntil = 0;
  }
}

/** Moves along `path` by up to `step` px. Returns the direction of travel, if it moved. */
function moveAlong(
  m: { pos: Point; path: Point[] },
  step: number,
): Facing | null {
  let remaining = step;
  let facing: Facing | null = null;
  while (remaining > 0 && m.path.length > 0) {
    const target = m.path[0]!;
    const dx = target.x - m.pos.x;
    const dy = target.y - m.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.01)
      facing =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0
            ? 'right'
            : 'left'
          : dy > 0
            ? 'down'
            : 'up';
    if (dist <= remaining) {
      m.pos = { ...target };
      m.path.shift();
      remaining -= dist;
    } else {
      m.pos = {
        x: m.pos.x + (dx / dist) * remaining,
        y: m.pos.y + (dy / dist) * remaining,
      };
      remaining = 0;
    }
  }
  return facing;
}

// ---------------------------------------------------------------------------
// Text version (legend + screen readers). Pure function of the events.
// ---------------------------------------------------------------------------

export interface AgentStatus {
  state: Pose;
  text: string;
}

export function deriveAgentStatuses(
  events: readonly AgentEvent[],
): Record<AgentId, AgentStatus> {
  const result = Object.fromEntries(
    AGENT_IDS.map((id) => [id, { state: 'idle', text: 'Idle' }]),
  ) as Record<AgentId, AgentStatus>;
  const set = (id: AgentId, state: Pose, text: string) => {
    result[id] = { state, text };
  };
  for (const e of events) {
    switch (e.type) {
      case 'run_started':
        for (const id of AGENT_IDS) set(id, 'idle', 'Idle');
        set('manager', 'thinking', 'Received a question');
        break;
      case 'run_state':
        if (e.state === 'queued')
          set('manager', 'thinking', 'Waiting in the queue');
        else {
          set('manager', 'idle', 'Delegated to the team');
          for (const id of AGENT_IDS)
            if (id !== 'manager')
              set(id, 'working', 'Working (step details unavailable)');
        }
        break;
      case 'agent_thinking':
        set(e.agent, 'thinking', 'Thinking');
        break;
      case 'agent_moving':
        set(
          e.agent,
          'walking',
          e.to === 'office'
            ? 'Walking to the office'
            : 'Walking back to the chat',
        );
        break;
      case 'handoff':
        set(
          e.from,
          'done',
          `Handed ${e.payloadLabel} to ${e.to.map((t) => AGENT_INFO[t].name).join(' & ')}`,
        );
        break;
      case 'agent_working':
        set(e.agent, 'working', e.message.replace(/…$/, ''));
        break;
      case 'agent_completed':
        set(e.agent, 'done', 'Done');
        break;
      case 'run_completed':
        set('manager', 'done', 'Delivered the answer');
        break;
      case 'run_failed':
        if (e.agent) set(e.agent, 'error', `Failed: ${e.error}`);
        set('manager', 'error', 'Run failed');
        break;
      case 'run_cancelled':
        for (const id of AGENT_IDS) set(id, 'idle', 'Idle');
        break;
    }
  }
  return result;
}

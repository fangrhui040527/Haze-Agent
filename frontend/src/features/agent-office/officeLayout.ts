import type { AgentId } from '../../shared/types/agents.ts';

/**
 * Office floor plan on a 16 px tile grid (20 × 12 tiles = 320 × 192 logical pixels).
 * Rows 0–1 are the back wall. The reception (columns 0–4) sits on the left, next to the chat,
 * behind a divider wall with a door, so the Manager has to walk through it to reach the team.
 * Characters walk tile to tile (breadth-first search around furniture), like pixel-agents.
 */
export const TILE = 16;
export const COLS = 20;
export const ROWS = 12;
export const OFFICE_WIDTH = COLS * TILE;
export const OFFICE_HEIGHT = ROWS * TILE;
export const WALL_ROWS = 2;
export const DIVIDER_COL = 5;
export const DOOR_ROWS = [6, 7] as const;

export interface Point {
  x: number;
  y: number;
}

export interface Tile {
  col: number;
  row: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Facing = 'down' | 'up' | 'left' | 'right';

/** Feet position of a character standing on a tile. */
export const tileToPoint = ({ col, row }: Tile): Point => ({
  x: col * TILE + TILE / 2,
  y: row * TILE + 13,
});

export const pointToTile = ({ x, y }: Point): Tile => ({
  col: Math.max(0, Math.min(COLS - 1, Math.floor(x / TILE))),
  row: Math.max(0, Math.min(ROWS - 1, Math.floor(y / TILE))),
});

export type FurnitureKind =
  | 'desk'
  | 'counter'
  | 'shelves'
  | 'cabinets'
  | 'meetingTable'
  | 'chair'
  | 'sofa'
  | 'plant'
  | 'cooler'
  | 'coffee';

/** Small object on a desk, so each workstation reads as "theirs". */
export type DeskProp =
  'satelliteMap' | 'magnifier' | 'books' | 'helmet' | 'folders' | 'bell';

export interface Furniture {
  kind: FurnitureKind;
  /** Footprint in tiles (blocks walking). */
  col: number;
  row: number;
  w: number;
  h: number;
  prop?: DeskProp;
  /** Which way a chair or sofa faces. */
  facing?: Facing;
}

export interface Station {
  /** Tile the agent sits on (a chair behind its desk, facing the viewer). */
  seatTile: Tile;
  /** Feet position on the seat. */
  seat: Point;
  desk: Furniture;
  /** Typing at a keyboard, or reading papers (records, sources, past episodes). */
  activity: 'type' | 'read';
  /** Nameplate text. */
  label: string;
}

const desk = (
  col: number,
  row: number,
  w: number,
  prop: DeskProp,
  kind: FurnitureKind = 'desk',
): Furniture => ({ kind, col, row, w, h: 1, prop });

const station = (
  col: number,
  row: number,
  furniture: Furniture,
  activity: Station['activity'],
  label: string,
): Station => ({
  seatTile: { col, row },
  seat: tileToPoint({ col, row }),
  desk: furniture,
  activity,
  label,
});

export const STATIONS: Record<AgentId, Station> = {
  manager: station(2, 3, desk(1, 4, 3, 'bell', 'counter'), 'type', 'Manager'),
  hazeops: station(7, 3, desk(6, 4, 3, 'satelliteMap'), 'type', 'HazeOps'),
  evidencecritic: station(
    11,
    3,
    desk(10, 4, 3, 'magnifier'),
    'read',
    'EvidenceCritic',
  ),
  worldmodel: station(15, 3, desk(14, 4, 3, 'books'), 'read', 'World Model'),
  workershield: station(7, 8, desk(6, 9, 3, 'helmet'), 'type', 'WorkerShield'),
  hmem: station(16, 8, desk(15, 9, 3, 'folders'), 'read', 'H-Mem'),
};

export const MEETING_TABLE: Furniture = {
  kind: 'meetingTable',
  col: 10,
  row: 7,
  w: 3,
  h: 2,
};
/** Where the Manager stands when briefing the team (just above the meeting table). */
export const MEETING_SPOT: Point = tileToPoint({ col: 11, row: 6 });
/** Floor rug under the meeting table (decoration only, does not block). */
export const RUG: Rect = {
  x: 9 * TILE,
  y: 6 * TILE + 4,
  w: 5 * TILE,
  h: 3 * TILE + 8,
};

export const FURNITURE: readonly Furniture[] = [
  ...Object.values(STATIONS).map((s) => s.desk),
  MEETING_TABLE,
  { kind: 'chair', col: 9, row: 7, w: 1, h: 1, facing: 'right' },
  { kind: 'chair', col: 13, row: 7, w: 1, h: 1, facing: 'left' },
  { kind: 'shelves', col: 17, row: 2, w: 3, h: 1 },
  { kind: 'cabinets', col: 18, row: 8, w: 2, h: 1 },
  { kind: 'coffee', col: 13, row: 2, w: 1, h: 1 },
  { kind: 'sofa', col: 0, row: 10, w: 2, h: 1, facing: 'up' },
  { kind: 'cooler', col: 0, row: 6, w: 1, h: 1 },
  { kind: 'plant', col: 0, row: 2, w: 1, h: 1 },
  { kind: 'plant', col: 4, row: 11, w: 1, h: 1 },
  { kind: 'plant', col: 9, row: 11, w: 1, h: 1 },
  { kind: 'plant', col: 19, row: 11, w: 1, h: 1 },
  { kind: 'plant', col: 6, row: 2, w: 1, h: 1 },
];

/** Places idle agents wander to between runs, and which way they look when there. */
export const HANGOUTS: readonly { tile: Tile; facing: Facing }[] = [
  { tile: { col: 13, row: 3 }, facing: 'up' }, // coffee machine
  { tile: { col: 9, row: 2 }, facing: 'up' }, // whiteboard
  { tile: { col: 16, row: 2 }, facing: 'up' }, // window
  { tile: { col: 18, row: 3 }, facing: 'up' }, // bookshelves
  { tile: { col: 1, row: 6 }, facing: 'left' }, // water cooler
  { tile: { col: 18, row: 10 }, facing: 'down' }, // by the plant
];

// ---------------------------------------------------------------------------
// Walkability and path finding
// ---------------------------------------------------------------------------

const key = (c: number, r: number) => r * COLS + c;

function buildBlocked(): Set<number> {
  const blocked = new Set<number>();
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < WALL_ROWS; r++) blocked.add(key(c, r));
  for (let r = WALL_ROWS; r < ROWS; r++)
    if (!(DOOR_ROWS as readonly number[]).includes(r))
      blocked.add(key(DIVIDER_COL, r));
  for (const f of FURNITURE)
    for (let c = f.col; c < f.col + f.w; c++)
      for (let r = f.row; r < f.row + f.h; r++) blocked.add(key(c, r));
  return blocked;
}

const BLOCKED = buildBlocked();

export function isWalkable({ col, row }: Tile): boolean {
  return (
    col >= 0 &&
    col < COLS &&
    row >= 0 &&
    row < ROWS &&
    !BLOCKED.has(key(col, row))
  );
}

/** Every walkable tile (for the office cat). */
export const WALKABLE_TILES: readonly Tile[] = Array.from(
  { length: COLS * ROWS },
  (_, i) => ({ col: i % COLS, row: Math.floor(i / COLS) }),
).filter(isWalkable);

/**
 * Shortest 4-direction route between two points, as feet positions tile by tile.
 * The first step is the tile after `from`; the last step is exactly `to`.
 * Returns [to] when no route exists, so a character never gets stuck.
 */
export function findPath(from: Point, to: Point): Point[] {
  const start = pointToTile(from);
  const goal = pointToTile(to);
  const startKey = key(start.col, start.row);
  const goalKey = key(goal.col, goal.row);
  if (startKey === goalKey) return [{ ...to }];
  const cameFrom = new Map<number, number>([[startKey, -1]]);
  const queue: Tile[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    if (key(t.col, t.row) === goalKey) break;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = { col: t.col + dc, row: t.row + dr };
      const k = key(n.col, n.row);
      if (cameFrom.has(k)) continue;
      // The goal may be a seat or a spot next to furniture; it only has to be on the map.
      if (k !== goalKey && !isWalkable(n)) continue;
      if (n.col < 0 || n.col >= COLS || n.row < 0 || n.row >= ROWS) continue;
      cameFrom.set(k, key(t.col, t.row));
      queue.push(n);
    }
  }
  if (!cameFrom.has(goalKey)) return [{ ...to }];
  const tiles: Point[] = [];
  for (let k = goalKey; k !== startKey; k = cameFrom.get(k)!) {
    tiles.push(tileToPoint({ col: k % COLS, row: Math.floor(k / COLS) }));
  }
  tiles.reverse();
  tiles[tiles.length - 1] = { ...to };
  return tiles;
}

export const WALK_SPEED_PX_PER_S = 110;

import { AGENT_IDS, type AgentId } from '../../shared/types/agents.ts';
import {
  DIVIDER_COL,
  DOOR_ROWS,
  FURNITURE,
  OFFICE_HEIGHT,
  OFFICE_WIDTH,
  RUG,
  STATIONS,
  TILE,
  WALL_ROWS,
  type DeskProp,
  type Furniture,
  type Point,
} from './officeLayout.ts';
import type { Actor, OfficeModel, Packet } from './officeModel.ts';
import {
  drawCat,
  drawCharacter,
  LOOKS,
  SEATED_DROP,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  type Gait,
} from './sprites.ts';

/** Fixed office colours (pixel art keeps the same look in light and dark mode). */
const C = {
  outline: '#1b1b1f',
  receptionA: '#c9d5d8',
  receptionB: '#bfccd0',
  grout: '#aebcc0',
  plankA: '#c9a273',
  plankB: '#c19969',
  plankSeam: '#a47d52',
  wall: '#a8967f',
  wallReception: '#8fa6aa',
  wallTrim: '#6e604f',
  wainscot: '#8a7763',
  wainscotReception: '#76898d',
  baseboard: '#5b4d3f',
  dividerTop: '#c9b8a0',
  dividerFace: '#8a7763',
  doormat: '#7a5a3a',
  skyTop: '#efd2a6',
  skyHaze: '#d9b088',
  skylineFar: '#c49a76',
  skylineNear: '#a98466',
  sun: '#f8e6bd',
  frame: '#5b4d3f',
  woodTop: '#c8945a',
  woodTopLight: '#dcae78',
  woodEdge: '#8a5a30',
  woodFront: '#9b6a3f',
  woodDark: '#6e4a2a',
  handle: '#e0c08a',
  counterTop: '#dccbb0',
  counterFront: '#5f7b82',
  counterStripe: '#f08a4b',
  metal: '#a3aab2',
  metalDark: '#5f666e',
  screenOff: '#26323a',
  screenOn: '#6fe3ff',
  screenDim: '#3d8fa8',
  key: '#4a4f57',
  keyCap: '#7a808a',
  paper: '#f6f3ea',
  paperLine: '#a9b0b8',
  chair: '#3d4450',
  chairLight: '#566070',
  leaf: '#4f9a5a',
  leafDark: '#2f6b3a',
  pot: '#b0603a',
  potDark: '#8a4628',
  rugOuter: '#8c3b2a',
  rugInner: '#b5543a',
  rugDot: '#e08a55',
  sofa: '#d0703c',
  sofaDark: '#a55628',
  water: '#8fd0f0',
  waterDark: '#5aa8d0',
  white: '#ffffff',
  ok: '#2c9a42',
  error: '#d63b30',
  accent: '#f08a4b',
  highlight: '#f6c445',
  shadow: 'rgba(0,0,0,0.18)',
};

type Ctx = CanvasRenderingContext2D;

const rect = (
  ctx: Ctx,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) => {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};

// Tiny 3×5 pixel font for signs (only the letters we need).
const GLYPHS: Record<string, string[]> = {
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
  C: ['.XX', 'X..', 'X..', 'X..', '.XX'],
  E: ['XXX', 'X..', 'XX.', 'X..', 'XXX'],
  H: ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  Q: ['XXX', 'X.X', 'X.X', 'XXX', '..X'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
  W: ['X...X', 'X...X', 'X.X.X', 'X.X.X', '.X.X.'],
  Z: ['XXX', '..X', '.X.', 'X..', 'XXX'],
};

function textWidth(text: string): number {
  return [...text].reduce(
    (w, ch) => w + (GLYPHS[ch]?.[0]?.length ?? 3) + 1,
    -1,
  );
}

function drawText(ctx: Ctx, text: string, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) {
      cx += 4;
      continue;
    }
    g.forEach((row, r) => {
      for (let c = 0; c < row.length; c++)
        if (row[c] === 'X') ctx.fillRect(cx + c, y + r, 1, 1);
    });
    cx += g[0].length + 1;
  }
}

// ---------------------------------------------------------------------------
// Room: floors, walls, windows
// ---------------------------------------------------------------------------

const RECEPTION_W = DIVIDER_COL * TILE;
const WALL_H = WALL_ROWS * TILE;

function drawFloors(ctx: Ctx): void {
  // Reception: cool checkered tiles with grout lines
  for (let r = WALL_ROWS; r < OFFICE_HEIGHT / TILE; r++) {
    for (let c = 0; c < DIVIDER_COL; c++) {
      rect(
        ctx,
        (r + c) % 2 === 0 ? C.receptionA : C.receptionB,
        c * TILE,
        r * TILE,
        TILE,
        TILE,
      );
      rect(ctx, C.grout, c * TILE, r * TILE, TILE, 1);
      rect(ctx, C.grout, c * TILE, r * TILE, 1, TILE);
    }
  }
  // Office: wooden planks (8 px tall, 32 px long, staggered)
  for (let y = WALL_H; y < OFFICE_HEIGHT; y += 8) {
    const row = (y - WALL_H) / 8;
    const offset = (row % 4) * 8;
    rect(
      ctx,
      row % 2 === 0 ? C.plankA : C.plankB,
      RECEPTION_W,
      y,
      OFFICE_WIDTH - RECEPTION_W,
      8,
    );
    rect(ctx, C.plankSeam, RECEPTION_W, y + 7, OFFICE_WIDTH - RECEPTION_W, 1);
    for (let x = RECEPTION_W - offset; x < OFFICE_WIDTH; x += 32)
      if (x >= RECEPTION_W) rect(ctx, C.plankSeam, x, y, 1, 7);
  }
}

function drawWindow(
  ctx: Ctx,
  x: number,
  w: number,
  skyline: 'towers' | 'city',
): void {
  const y = 5;
  const h = 19;
  rect(ctx, C.frame, x - 2, y - 2, w + 4, h + 4);
  // Hazy sky: warm and washed out
  rect(ctx, C.skyTop, x, y, w, h);
  rect(ctx, C.skyHaze, x, y + 9, w, h - 9);
  rect(ctx, C.sun, x + w - 11, y + 3, 5, 5);
  rect(ctx, C.sun, x + w - 12, y + 4, 7, 3);
  // Far skyline
  const far = [3, 6, 4, 8, 5, 7, 3, 6, 4, 5];
  for (let i = 0; i * 4 < w; i++)
    rect(
      ctx,
      C.skylineFar,
      x + i * 4,
      y + h - far[i % far.length] - 3,
      4,
      far[i % far.length] + 3,
    );
  if (skyline === 'towers') {
    // Twin towers with a skybridge, softened by the haze
    const tx = x + 8;
    for (const dx of [0, 8]) {
      rect(ctx, C.skylineNear, tx + dx, y + 5, 4, h - 5);
      rect(ctx, C.skylineNear, tx + dx + 1, y + 2, 2, 3);
      rect(ctx, C.skylineNear, tx + dx + 1.5, y, 1, 2);
    }
    rect(ctx, C.skylineNear, tx + 4, y + 10, 4, 1);
  } else {
    const near = [7, 11, 5, 9, 12, 6];
    for (let i = 0; i * 6 < w; i++)
      rect(
        ctx,
        C.skylineNear,
        x + i * 6,
        y + h - near[i % near.length],
        5,
        near[i % near.length],
      );
  }
  // Haze veil and mullions
  ctx.fillStyle = 'rgba(232, 200, 160, 0.35)';
  ctx.fillRect(x, y, w, h);
  rect(ctx, C.frame, x + Math.floor(w / 2), y, 1, h);
  rect(ctx, C.frame, x, y + 9, w, 1);
  rect(ctx, C.handle, x - 2, y + h + 1, w + 4, 1); // sill
}

function drawWhiteboard(ctx: Ctx, x: number, w: number): void {
  rect(ctx, C.metalDark, x - 1, 4, w + 2, 21);
  rect(ctx, C.paper, x, 5, w, 19);
  drawText(ctx, 'AQI', x + 2, 7, '#c0392b');
  // Axes and a rising PM2.5 line
  rect(ctx, '#55606a', x + 3, 13, 1, 9);
  rect(ctx, '#55606a', x + 3, 21, w - 6, 1);
  const pts = [19, 18, 19, 16, 17, 14, 12, 13, 10, 9, 8];
  pts.forEach((py, i) => {
    const px = x + 5 + i * 3;
    if (px < x + w - 3) {
      rect(ctx, '#d63b30', px, py, 3, 1);
    }
  });
  rect(ctx, '#2b6cb0', x + w - 12, 7, 9, 1);
  rect(ctx, '#2b6cb0', x + w - 12, 9, 6, 1);
  rect(ctx, C.metal, x + 2, 24, w - 4, 2); // marker tray
  rect(ctx, '#d63b30', x + 5, 24, 3, 1);
  rect(ctx, '#2b6cb0', x + 9, 24, 3, 1);
}

function drawClock(ctx: Ctx, cx: number, cy: number): void {
  rect(ctx, C.outline, cx - 4, cy - 5, 9, 11);
  rect(ctx, C.outline, cx - 5, cy - 4, 11, 9);
  rect(ctx, C.white, cx - 3, cy - 4, 7, 9);
  rect(ctx, C.white, cx - 4, cy - 3, 9, 7);
  const d = new Date();
  const hand = (angle: number, len: number, color: string) => {
    for (let i = 1; i <= len; i++)
      rect(
        ctx,
        color,
        cx + Math.round(Math.sin(angle) * i),
        cy - Math.round(Math.cos(angle) * i),
        1,
        1,
      );
  };
  hand(
    ((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6),
    2,
    C.outline,
  );
  hand(d.getMinutes() * (Math.PI / 30), 3, '#55606a');
  rect(ctx, '#d63b30', cx, cy, 1, 1);
}

function drawBackWall(ctx: Ctx): void {
  rect(ctx, C.wallReception, 0, 0, RECEPTION_W, WALL_H);
  rect(ctx, C.wall, RECEPTION_W, 0, OFFICE_WIDTH - RECEPTION_W, WALL_H);
  rect(ctx, C.wallTrim, 0, 0, OFFICE_WIDTH, 2);
  rect(ctx, C.wainscotReception, 0, 25, RECEPTION_W, 5);
  rect(ctx, C.wainscot, RECEPTION_W, 25, OFFICE_WIDTH - RECEPTION_W, 5);
  for (let x = 6; x < OFFICE_WIDTH; x += 12)
    rect(ctx, C.baseboard, x, 25, 1, 5);
  rect(ctx, C.baseboard, 0, 30, OFFICE_WIDTH, 2);

  // Reception sign
  const sign = 'HAZE';
  const sw = textWidth(sign) + 6;
  const sx = Math.round(RECEPTION_W / 2 - sw / 2);
  rect(ctx, C.outline, sx - 1, 7, sw + 2, 11);
  rect(ctx, C.accent, sx, 8, sw, 9);
  drawText(ctx, sign, sx + 3, 10, C.white);

  drawWindow(ctx, 6 * TILE + 2, 30, 'city');
  drawWhiteboard(ctx, 8 * TILE + 6, 44);
  drawClock(ctx, 12 * TILE + 6, 12);
  drawWindow(ctx, 14 * TILE + 2, 42, 'towers');
}

function drawDivider(ctx: Ctx): void {
  const x = DIVIDER_COL * TILE + 3;
  const w = TILE - 6;
  const doorTop = DOOR_ROWS[0] * TILE;
  const doorBottom = (DOOR_ROWS[DOOR_ROWS.length - 1] + 1) * TILE;
  rect(
    ctx,
    C.doormat,
    DIVIDER_COL * TILE,
    doorTop + 2,
    TILE,
    doorBottom - doorTop - 4,
  );
  rect(
    ctx,
    '#946f48',
    DIVIDER_COL * TILE + 2,
    doorTop + 4,
    TILE - 4,
    doorBottom - doorTop - 8,
  );
  // Upper segment (with a visible front face above the door) and lower segment
  rect(ctx, C.dividerTop, x, WALL_H - 6, w, doorTop - WALL_H + 6 - 6);
  rect(ctx, C.dividerFace, x, doorTop - 6, w, 6);
  rect(ctx, C.baseboard, x, doorTop - 1, w, 1);
  rect(ctx, C.dividerTop, x, doorBottom - 6, w, OFFICE_HEIGHT - doorBottom + 6);
  rect(ctx, C.wallTrim, x - 1, WALL_H - 6, 1, doorTop - WALL_H);
  rect(ctx, C.wallTrim, x + w, WALL_H - 6, 1, doorTop - WALL_H);
  rect(
    ctx,
    C.wallTrim,
    x - 1,
    doorBottom - 6,
    1,
    OFFICE_HEIGHT - doorBottom + 6,
  );
  rect(
    ctx,
    C.wallTrim,
    x + w,
    doorBottom - 6,
    1,
    OFFICE_HEIGHT - doorBottom + 6,
  );
}

function drawRug(ctx: Ctx): void {
  const { x, y, w, h } = RUG;
  rect(ctx, C.rugOuter, x + 1, y, w - 2, h);
  rect(ctx, C.rugOuter, x, y + 1, w, h - 2);
  rect(ctx, C.rugInner, x + 3, y + 3, w - 6, h - 6);
  for (let i = x + 6; i < x + w - 5; i += 6) {
    rect(ctx, C.rugDot, i, y + 1, 2, 1);
    rect(ctx, C.rugDot, i, y + h - 2, 2, 1);
  }
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

interface SceneState {
  now: number;
  reduced: boolean;
  seatedActor: (id: AgentId) => Actor | null;
}

function drawShadow(ctx: Ctx, x: number, y: number, w: number) {
  ctx.fillStyle = C.shadow;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), 2);
}

function drawMonitor(
  ctx: Ctx,
  x: number,
  top: number,
  state: 'off' | 'on' | 'busy',
  now: number,
) {
  rect(ctx, C.metalDark, x + 4, top + 11, 6, 2); // stand
  rect(ctx, C.outline, x, top - 1, 14, 12);
  rect(ctx, '#3a3f46', x + 1, top, 12, 10);
  const lit =
    state === 'busy'
      ? Math.floor(now / 160) % 2 === 0
        ? C.screenOn
        : '#a8f0ff'
      : state === 'on'
        ? C.screenDim
        : C.screenOff;
  rect(ctx, lit, x + 2, top + 1, 10, 8);
  if (state === 'busy') {
    // Scrolling "code" lines
    const shift = Math.floor(now / 200) % 3;
    for (let i = 0; i < 3; i++)
      rect(
        ctx,
        '#1d6f86',
        x + 3,
        top + 2 + ((i * 3 + shift) % 7),
        3 + ((i * 5) % 6),
        1,
      );
  }
}

function drawProp(ctx: Ctx, prop: DeskProp, x: number, y: number) {
  switch (prop) {
    case 'satelliteMap':
      rect(ctx, C.paper, x, y, 11, 7);
      rect(ctx, '#7fb07a', x + 1, y + 1, 5, 3);
      rect(ctx, '#c9a26b', x + 5, y + 3, 5, 3);
      rect(ctx, '#d63b30', x + 3, y + 2, 1, 1);
      rect(ctx, '#d63b30', x + 7, y + 4, 1, 1);
      rect(ctx, '#d63b30', x + 8, y + 3, 1, 1);
      break;
    case 'magnifier':
      rect(ctx, C.paper, x, y + 1, 9, 6);
      rect(ctx, C.paperLine, x + 1, y + 2, 6, 1);
      rect(ctx, C.paperLine, x + 1, y + 4, 5, 1);
      rect(ctx, C.outline, x + 5, y - 2, 5, 5);
      rect(ctx, '#9fd3ff', x + 6, y - 1, 3, 3);
      rect(ctx, C.woodDark, x + 9, y + 3, 2, 2);
      break;
    case 'books':
      rect(ctx, '#c0392b', x, y + 3, 11, 3);
      rect(ctx, '#2980b9', x + 1, y, 10, 3);
      rect(ctx, '#f39c12', x + 2, y - 3, 8, 3);
      rect(ctx, C.paper, x + 10, y + 4, 1, 1);
      break;
    case 'helmet':
      rect(ctx, C.outline, x + 1, y - 1, 9, 6);
      rect(ctx, '#f2c230', x + 2, y, 7, 4);
      rect(ctx, C.outline, x, y + 4, 11, 2);
      rect(ctx, '#f7dd75', x + 3, y + 1, 2, 1);
      break;
    case 'folders':
      rect(ctx, '#d9a94e', x, y + 3, 11, 4);
      rect(ctx, '#e8c37a', x + 1, y, 10, 4);
      rect(ctx, '#e8c37a', x + 2, y - 1, 4, 1);
      rect(ctx, C.paper, x + 3, y + 1, 6, 1);
      break;
    case 'bell':
      rect(ctx, '#b8860b', x + 1, y + 4, 8, 2);
      rect(ctx, '#e6b422', x + 2, y + 1, 6, 3);
      rect(ctx, '#f6d36b', x + 3, y + 1, 2, 1);
      rect(ctx, '#b8860b', x + 4, y, 2, 1);
      break;
  }
}

function drawDeskLike(
  ctx: Ctx,
  f: Furniture,
  s: SceneState,
  owner: AgentId | null,
) {
  const x0 = f.col * TILE;
  const y0 = f.row * TILE;
  const w = f.w * TILE;
  const counter = f.kind === 'counter';
  const actor = owner ? s.seatedActor(owner) : null;
  const station = owner ? STATIONS[owner] : null;
  const busy = actor?.pose === 'working';
  const on = actor && (busy || actor.pose === 'thinking');

  drawShadow(ctx, x0 + 2, y0 + 15, w - 4);
  // Monitor at the back-left of the desk, facing the person
  drawMonitor(
    ctx,
    x0 + 3,
    y0 - 13,
    busy && station?.activity === 'type' ? 'busy' : on ? 'on' : 'off',
    s.now,
  );
  // Top surface and front panel
  rect(ctx, counter ? C.counterTop : C.woodTop, x0, y0 - 2, w, 8);
  rect(ctx, counter ? '#ece0cb' : C.woodTopLight, x0, y0 - 2, w, 1);
  rect(ctx, counter ? '#a99a80' : C.woodEdge, x0, y0 + 6, w, 1);
  if (counter) {
    rect(ctx, C.counterFront, x0, y0 + 7, w, 8);
    rect(ctx, C.counterStripe, x0, y0 + 10, w, 2);
  } else {
    rect(ctx, C.woodFront, x0, y0 + 7, w, 8);
    rect(ctx, C.woodDark, x0 + w - 15, y0 + 8, 13, 6);
    rect(ctx, C.woodFront, x0 + w - 14, y0 + 9, 11, 4);
    rect(ctx, C.handle, x0 + w - 10, y0 + 10, 3, 1);
    rect(ctx, C.woodDark, x0 + 1, y0 + 13, 2, 3);
  }
  if (busy && station?.activity === 'type') {
    ctx.fillStyle = 'rgba(111, 227, 255, 0.22)';
    ctx.fillRect(x0 + 4, y0 - 2, 18, 6);
  }
  // Keyboard in front of the seat
  const cx = station ? station.seat.x : x0 + w / 2;
  rect(ctx, C.key, cx - 6, y0 - 1, 12, 3);
  for (let i = 0; i < 5; i++)
    rect(ctx, C.keyCap, cx - 5 + i * 2 + 0.5, y0, 1, 1);
  // Mug (not on the reception counter)
  if (!counter) {
    rect(ctx, C.white, cx + 9, y0 - 1, 3, 3);
    rect(ctx, '#d9d9d9', cx + 12, y0, 1, 1);
  }
  if (f.prop) drawProp(ctx, f.prop, x0 + w - 13, y0 - 3);

  // Hands (and papers) of the person sitting here, drawn on top of the desk
  if (actor && station) {
    const skin = LOOKS[actor.id].palette.S;
    const tap = !s.reduced && busy && Math.floor(s.now / 130) % 2 === 0;
    if (busy && station.activity === 'read') {
      const flip = !s.reduced && Math.floor(s.now / 1100) % 2 === 0;
      rect(ctx, C.outline, cx - 5, y0 - 8, 10, 8);
      rect(ctx, C.paper, cx - 4, y0 - 7, 8, 6);
      rect(ctx, C.paperLine, cx - 3, y0 - 6 + (flip ? 1 : 0), 6, 1);
      rect(ctx, C.paperLine, cx - 3, y0 - 4 + (flip ? 1 : 0), 4, 1);
      rect(ctx, skin, cx - 6, y0 - 4, 2, 2);
      rect(ctx, skin, cx + 4, y0 - 4, 2, 2);
    } else {
      rect(ctx, skin, cx - 5, y0 - 2 - (busy && tap ? 1 : 0), 2, 2);
      rect(ctx, skin, cx + 3, y0 - 2 - (busy && !tap ? 1 : 0), 2, 2);
    }
  }
}

function drawStationChair(ctx: Ctx, seat: Point) {
  // Office chair seen from the front; its back shows around the sitter's shoulders.
  const x = seat.x - 8;
  const y = seat.y - 13;
  rect(ctx, C.outline, x + 1, y, 14, 12);
  rect(ctx, C.outline, x, y + 1, 16, 10);
  rect(ctx, C.chair, x + 1, y + 1, 14, 9);
  rect(ctx, C.chairLight, x + 2, y + 2, 12, 2);
  rect(ctx, C.outline, x - 1, y + 10, 18, 4);
  rect(ctx, C.chairLight, x, y + 11, 16, 2);
}

function drawSideChair(ctx: Ctx, f: Furniture) {
  const x = f.col * TILE + 2;
  const y = f.row * TILE + 4;
  drawShadow(ctx, x, y + 11, 12);
  rect(ctx, C.outline, x, y + 4, 12, 5);
  rect(ctx, C.chairLight, x + 1, y + 5, 10, 3);
  const backX = f.facing === 'right' ? x : x + 9;
  rect(ctx, C.outline, backX, y - 4, 3, 13);
  rect(ctx, C.chair, backX + 1, y - 3, 1, 11);
  rect(ctx, C.metalDark, x + 2, y + 9, 1, 3);
  rect(ctx, C.metalDark, x + 9, y + 9, 1, 3);
}

function drawMeetingTable(ctx: Ctx, f: Furniture) {
  const x0 = f.col * TILE;
  const y0 = f.row * TILE;
  const w = f.w * TILE;
  const h = f.h * TILE;
  drawShadow(ctx, x0 + 3, y0 + h - 1, w - 6);
  rect(ctx, C.outline, x0 + 1, y0 - 3, w - 2, h - 4);
  rect(ctx, C.woodTop, x0 + 2, y0 - 2, w - 4, h - 7);
  rect(ctx, C.woodTopLight, x0 + 2, y0 - 2, w - 4, 1);
  rect(ctx, C.woodFront, x0 + 2, y0 + h - 9, w - 4, 4);
  rect(ctx, C.woodDark, x0 + 4, y0 + h - 5, 2, 4);
  rect(ctx, C.woodDark, x0 + w - 6, y0 + h - 5, 2, 4);
  // Laptop, papers and a small plant
  rect(ctx, C.metalDark, x0 + 8, y0 + 4, 12, 7);
  rect(ctx, C.screenDim, x0 + 9, y0 + 5, 10, 5);
  rect(ctx, C.metal, x0 + 7, y0 + 11, 14, 2);
  rect(ctx, C.paper, x0 + 26, y0 + 6, 8, 6);
  rect(ctx, C.paperLine, x0 + 27, y0 + 8, 5, 1);
  rect(ctx, C.paper, x0 + 28, y0 + 13, 7, 5);
  rect(ctx, C.pot, x0 + 39, y0 + 8, 4, 3);
  rect(ctx, C.leaf, x0 + 38, y0 + 5, 6, 3);
}

function drawShelves(ctx: Ctx, f: Furniture) {
  const x0 = f.col * TILE;
  const w = f.w * TILE;
  const top = 6;
  const bottom = (f.row + f.h) * TILE;
  rect(ctx, C.outline, x0, top, w, bottom - top);
  rect(ctx, C.woodDark, x0 + 1, top + 1, w - 2, bottom - top - 2);
  const colors = [
    '#c0392b',
    '#2980b9',
    '#27ae60',
    '#f39c12',
    '#8e44ad',
    '#e8e8e8',
    '#16a085',
  ];
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = top + 3 + shelf * 13;
    rect(ctx, '#5a3a20', x0 + 2, y, w - 4, 10);
    let bx = x0 + 3;
    let i = shelf * 3;
    while (bx < x0 + w - 5) {
      const bw = 2 + (i % 3 === 0 ? 1 : 0);
      const bh = 6 + ((i * 7) % 4);
      rect(ctx, colors[i % colors.length], bx, y + 10 - bh, bw, bh);
      bx += bw + (i % 5 === 4 ? 3 : 1);
      i++;
    }
    rect(ctx, C.woodTop, x0 + 1, y + 10, w - 2, 2);
  }
  rect(ctx, C.woodFront, x0 + 1, bottom - 3, w - 2, 3);
  // A globe on top
  rect(ctx, C.outline, x0 + w - 12, top - 6, 8, 7);
  rect(ctx, '#3a86c8', x0 + w - 11, top - 5, 6, 5);
  rect(ctx, '#5fb36a', x0 + w - 10, top - 4, 3, 2);
}

function drawCabinets(ctx: Ctx, f: Furniture) {
  const x0 = f.col * TILE;
  const y0 = f.row * TILE;
  const top = y0 - 12;
  for (let i = 0; i < f.w; i++) {
    const x = x0 + i * TILE;
    rect(ctx, C.outline, x, top, TILE - 1, TILE + 12);
    rect(ctx, C.metal, x + 1, top + 1, TILE - 3, TILE + 10);
    for (let d = 0; d < 3; d++) {
      const dy = top + 2 + d * 8;
      rect(ctx, C.metalDark, x + 2, dy + 6, TILE - 5, 1);
      rect(ctx, C.paper, x + 5, dy + 1, 5, 2);
      rect(ctx, C.metalDark, x + 6, dy + 4, 3, 1);
    }
  }
  rect(ctx, '#e8c37a', x0 + 4, top - 3, 10, 3); // archive box on top
  rect(ctx, '#c9a35e', x0 + 4, top - 1, 10, 1);
}

function drawCoffee(ctx: Ctx, f: Furniture, s: SceneState) {
  const x = f.col * TILE;
  const y0 = f.row * TILE;
  rect(ctx, C.outline, x, y0 - 2, TILE, TILE + 2);
  rect(ctx, C.wainscot, x + 1, y0 - 1, TILE - 2, TILE);
  rect(ctx, C.counterTop, x, y0 - 3, TILE, 2);
  rect(ctx, C.outline, x + 3, y0 - 16, 10, 13);
  rect(ctx, '#3a3a3a', x + 4, y0 - 15, 8, 11);
  rect(ctx, '#d63b30', x + 10, y0 - 13, 1, 1);
  rect(ctx, C.white, x + 6, y0 - 7, 3, 3);
  if (!s.reduced) {
    const t = Math.floor(s.now / 250) % 4;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(x + 7 + (t % 2), y0 - 10 - t, 1, 2);
  }
}

function drawCooler(ctx: Ctx, f: Furniture, s: SceneState) {
  const x = f.col * TILE + 3;
  const y0 = f.row * TILE;
  drawShadow(ctx, x, y0 + 14, 10);
  rect(ctx, C.outline, x, y0 - 2, 10, 17);
  rect(ctx, '#e8ecef', x + 1, y0 - 1, 8, 15);
  rect(ctx, '#2b6cb0', x + 3, y0 + 3, 4, 2);
  rect(ctx, C.outline, x + 1, y0 - 14, 8, 12);
  rect(ctx, C.water, x + 2, y0 - 13, 6, 10);
  rect(ctx, C.waterDark, x + 2, y0 - 8, 6, 5);
  rect(ctx, C.white, x + 3, y0 - 12, 1, 3);
  if (!s.reduced && Math.floor(s.now / 2000) % 3 === 0) {
    const b = Math.floor(s.now / 200) % 5;
    rect(ctx, C.white, x + 5, y0 - 4 - b, 1, 1);
  }
}

function drawSofa(ctx: Ctx, f: Furniture) {
  const x = f.col * TILE + 1;
  const y = f.row * TILE - 6;
  const w = f.w * TILE - 2;
  drawShadow(ctx, x + 1, y + 20, w - 2);
  rect(ctx, C.outline, x, y, w, 21);
  rect(ctx, C.sofaDark, x + 1, y + 1, w - 2, 8);
  rect(ctx, C.sofa, x + 3, y + 9, w - 6, 7);
  rect(ctx, C.sofaDark, x + 1, y + 9, 2, 10);
  rect(ctx, C.sofaDark, x + w - 3, y + 9, 2, 10);
  rect(ctx, C.sofaDark, x + Math.floor(w / 2), y + 9, 1, 7);
  rect(ctx, '#f2c230', x + 4, y + 4, 5, 4); // cushion
}

function drawPlant(ctx: Ctx, f: Furniture) {
  const cx = f.col * TILE + 8;
  const y0 = f.row * TILE + 15;
  drawShadow(ctx, cx - 5, y0, 10);
  rect(ctx, C.outline, cx - 4, y0 - 7, 9, 7);
  rect(ctx, C.pot, cx - 3, y0 - 6, 7, 5);
  rect(ctx, C.potDark, cx - 3, y0 - 2, 7, 1);
  rect(ctx, C.leafDark, cx - 6, y0 - 15, 13, 8);
  rect(ctx, C.leafDark, cx - 3, y0 - 20, 7, 6);
  rect(ctx, C.leaf, cx - 5, y0 - 14, 4, 4);
  rect(ctx, C.leaf, cx + 1, y0 - 17, 4, 5);
  rect(ctx, C.leaf, cx - 2, y0 - 19, 3, 3);
  rect(ctx, '#7cc47f', cx + 2, y0 - 16, 1, 2);
}

// ---------------------------------------------------------------------------
// Characters, bubbles, packets
// ---------------------------------------------------------------------------

const blinkPhase = (id: AgentId) => AGENT_IDS.indexOf(id) * 1370;

function isSeated(a: Actor): boolean {
  const seat = STATIONS[a.id].seat;
  return (
    a.path.length === 0 && Math.hypot(a.pos.x - seat.x, a.pos.y - seat.y) <= 1
  );
}

/** Feet position as drawn (seated characters sink behind their desk). */
function drawnFeet(a: Actor): Point {
  return isSeated(a) ? { x: a.pos.x, y: a.pos.y + SEATED_DROP } : a.pos;
}

/** Bounding box of a character on screen, in logical pixels (for clicks and labels). */
export function characterBounds(a: Actor) {
  const feet = drawnFeet(a);
  return {
    x: feet.x - SPRITE_WIDTH / 2,
    y: feet.y - SPRITE_HEIGHT,
    w: SPRITE_WIDTH,
    h: SPRITE_HEIGHT,
    feet,
    seated: isSeated(a),
  };
}

function drawActor(ctx: Ctx, a: Actor, now: number, reduced: boolean) {
  const seated = isSeated(a);
  const feet = drawnFeet(a);
  let gait: Gait = 'stand';
  if (!reduced && a.pose === 'walking' && a.path.length > 0) {
    const cycle: Gait[] = ['stepA', 'stand', 'stepB', 'stand'];
    gait = cycle[Math.floor(now / 110) % 4]!;
  }
  const blink = !reduced && (now + blinkPhase(a.id)) % 4200 < 140;
  if (!seated) drawShadow(ctx, feet.x - 5, feet.y - 1, 10);
  drawCharacter(
    ctx,
    a.id,
    { facing: seated ? 'down' : a.facing, gait, seated, blink },
    feet.x,
    feet.y,
  );
}

function bubbleFrame(ctx: Ctx, x: number, y: number, fill: string) {
  // 13×10 bubble with a tail at the bottom left; (x, y) = bottom of the tail
  const left = Math.round(x - 3);
  const top = Math.round(y - 12);
  rect(ctx, C.outline, left + 1, top, 11, 10);
  rect(ctx, C.outline, left, top + 1, 13, 8);
  rect(ctx, fill, left + 1, top + 1, 11, 8);
  rect(ctx, fill, left + 2, top + 0.5, 9, 1);
  rect(ctx, C.outline, left + 2, top + 10, 3, 1);
  rect(ctx, C.outline, left + 2, top + 11, 1, 1);
  rect(ctx, fill, left + 3, top + 9, 1, 1);
  return { left, top };
}

function drawStatusBubble(ctx: Ctx, a: Actor, now: number, reduced: boolean) {
  const b = characterBounds(a);
  const x = b.feet.x;
  const y = b.y - 1;
  switch (a.pose) {
    case 'thinking': {
      const { left, top } = bubbleFrame(ctx, x, y, C.white);
      const dots = reduced ? 3 : (Math.floor(now / 300) % 3) + 1;
      for (let i = 0; i < dots; i++)
        rect(ctx, '#333', left + 3 + i * 3, top + 4, 2, 2);
      break;
    }
    case 'done': {
      const { left, top } = bubbleFrame(ctx, x, y, C.white);
      rect(ctx, C.ok, left + 3, top + 4, 2, 2);
      rect(ctx, C.ok, left + 5, top + 6, 2, 1);
      rect(ctx, C.ok, left + 6, top + 4, 2, 2);
      rect(ctx, C.ok, left + 8, top + 2, 2, 2);
      break;
    }
    case 'error': {
      const { left, top } = bubbleFrame(ctx, x, y, C.error);
      rect(ctx, C.white, left + 6, top + 2, 1, 4);
      rect(ctx, C.white, left + 6, top + 7, 1, 1);
      break;
    }
    case 'working': {
      if (isSeated(a)) break; // the desk already shows typing / reading
      const bounce = reduced ? 0 : Math.floor(now / 160) % 3;
      for (let i = 0; i < 3; i++)
        rect(
          ctx,
          C.accent,
          x - 4 + i * 4,
          y - 3 - (i === bounce ? 2 : 0),
          2,
          2,
        );
      break;
    }
    case 'idle':
    case 'walking':
      break;
  }
}

function drawPacketIcon(ctx: Ctx, p: Packet, x: number, y: number) {
  switch (p.toAgent) {
    case 'worldmodel':
    case 'hmem':
      rect(ctx, C.outline, x - 4, y - 3, 9, 7);
      rect(ctx, '#e8c37a', x - 3, y - 2, 7, 5);
      rect(ctx, '#d9a94e', x - 3, y - 3, 3, 1);
      break;
    case 'evidencecritic':
      rect(ctx, C.outline, x - 3, y - 4, 6, 6);
      rect(ctx, '#9fd3ff', x - 2, y - 3, 4, 4);
      rect(ctx, C.woodDark, x + 2, y + 2, 2, 2);
      break;
    case 'workershield':
      rect(ctx, C.outline, x - 4, y - 4, 9, 7);
      rect(ctx, C.outline, x - 3, y + 3, 7, 1);
      rect(ctx, C.outline, x - 1, y + 4, 3, 1);
      rect(ctx, '#3f8f4f', x - 3, y - 3, 7, 6);
      rect(ctx, C.white, x, y - 2, 1, 4);
      rect(ctx, C.white, x - 1, y - 1, 3, 1);
      break;
    default:
      rect(ctx, C.outline, x - 3, y - 4, 7, 8);
      rect(ctx, C.paper, x - 2, y - 3, 5, 6);
      rect(ctx, C.paperLine, x - 1, y - 1, 3, 1);
      rect(ctx, C.paperLine, x - 1, y + 1, 3, 1);
  }
}

function drawPacket(ctx: Ctx, p: Packet, now: number) {
  const t = Math.min(1, (now - p.start) / p.duration);
  const x = p.from.x + (p.to.x - p.from.x) * t;
  const y =
    p.from.y + (p.to.y - p.from.y) * t - Math.sin(t * Math.PI) * 18 - 14;
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(
    Math.round(x - 3),
    Math.round(p.from.y + (p.to.y - p.from.y) * t - 1),
    6,
    2,
  );
  drawPacketIcon(ctx, p, Math.round(x), Math.round(y));
}

function drawPet(ctx: Ctx, model: OfficeModel, now: number, reduced: boolean) {
  const pet = model.pet;
  const moving = !reduced && pet.path.length > 0;
  const frame = moving
    ? Math.floor(now / 160) % 2 === 0
      ? 'walkA'
      : 'walkB'
    : 'sit';
  drawShadow(ctx, pet.pos.x - 4, pet.pos.y - 1, 8);
  drawCat(ctx, frame, pet.pos.x, pet.pos.y, pet.facing === 'left');
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface SceneOptions {
  reduced: boolean;
  selected: AgentId | null;
  hovered: AgentId | null;
}

const OWNER_OF = new Map<Furniture, AgentId>(
  (Object.entries(STATIONS) as [AgentId, (typeof STATIONS)[AgentId]][]).map(
    ([id, s]) => [s.desk, id],
  ),
);

export function drawScene(
  ctx: Ctx,
  model: OfficeModel,
  now: number,
  opts: SceneOptions,
): void {
  const { reduced } = opts;
  ctx.imageSmoothingEnabled = false;
  drawFloors(ctx);
  drawRug(ctx);
  drawDivider(ctx);
  drawBackWall(ctx);

  const s: SceneState = {
    now,
    reduced,
    seatedActor: (id) => {
      const a = model.actors.get(id);
      return a && isSeated(a) ? a : null;
    },
  };

  // Everything that can overlap is drawn back to front by its bottom edge (like pixel-agents' zY).
  const drawables: { z: number; draw: () => void }[] = [];
  for (const f of FURNITURE) {
    const z = (f.row + f.h) * TILE;
    const owner = OWNER_OF.get(f) ?? null;
    drawables.push({
      z,
      draw: () => {
        switch (f.kind) {
          case 'desk':
          case 'counter':
            return drawDeskLike(ctx, f, s, owner);
          case 'meetingTable':
            return drawMeetingTable(ctx, f);
          case 'chair':
            return drawSideChair(ctx, f);
          case 'shelves':
            return drawShelves(ctx, f);
          case 'cabinets':
            return drawCabinets(ctx, f);
          case 'coffee':
            return drawCoffee(ctx, f, s);
          case 'cooler':
            return drawCooler(ctx, f, s);
          case 'sofa':
            return drawSofa(ctx, f);
          case 'plant':
            return drawPlant(ctx, f);
        }
      },
    });
  }
  for (const station of Object.values(STATIONS)) {
    if (station.desk.kind === 'counter') continue; // the Manager stands at the counter
    drawables.push({
      z: station.seat.y - 3,
      draw: () => drawStationChair(ctx, station.seat),
    });
  }
  for (const a of model.actors.values()) {
    drawables.push({
      z: drawnFeet(a).y,
      draw: () => drawActor(ctx, a, now, reduced),
    });
  }
  drawables.push({
    z: model.pet.pos.y,
    draw: () => drawPet(ctx, model, now, reduced),
  });
  drawables.sort((a, b) => a.z - b.z);
  for (const d of drawables) d.draw();

  // Overlays: highlights, selection, bubbles, packets
  for (const [id] of model.highlights) {
    const a = model.actors.get(id);
    if (!a) continue;
    const b = characterBounds(a);
    ctx.strokeStyle = C.highlight;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(b.x) - 3, Math.round(b.y) - 3, b.w + 6, b.h + 5);
  }
  for (const id of [opts.hovered, opts.selected]) {
    const a = id ? model.actors.get(id) : null;
    if (!a) continue;
    const b = characterBounds(a);
    const bob = reduced ? 0 : Math.floor(now / 300) % 2;
    const ax = Math.round(b.feet.x);
    const ay = Math.round(b.y) - 16 - bob;
    const color = id === opts.selected ? C.highlight : C.white;
    rect(ctx, C.outline, ax - 4, ay - 1, 9, 2);
    rect(ctx, C.outline, ax - 3, ay + 1, 7, 2);
    rect(ctx, C.outline, ax - 2, ay + 3, 5, 1);
    rect(ctx, C.outline, ax - 1, ay + 4, 3, 1);
    rect(ctx, color, ax - 3, ay, 7, 1);
    rect(ctx, color, ax - 2, ay + 1, 5, 1);
    rect(ctx, color, ax - 1, ay + 2, 3, 1);
    rect(ctx, color, ax, ay + 3, 1, 1);
  }
  for (const a of model.actors.values()) drawStatusBubble(ctx, a, now, reduced);
  for (const p of model.packets) drawPacket(ctx, p, now);
}

/** Which character is under a point (logical pixels), front-most first. */
export function actorAt(
  model: OfficeModel,
  x: number,
  y: number,
): AgentId | null {
  const actors = [...model.actors.values()].sort(
    (a, b) => drawnFeet(b).y - drawnFeet(a).y,
  );
  for (const a of actors) {
    const b = characterBounds(a);
    if (x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.feet.y + 1)
      return a.id;
  }
  return null;
}

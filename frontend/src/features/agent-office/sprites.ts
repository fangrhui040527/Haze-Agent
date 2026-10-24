import type { AgentId } from '../../shared/types/agents.ts';
import type { Facing } from './officeLayout.ts';

/**
 * Original pixel-art characters, drawn in code (no image files, no licence questions).
 * Each frame is 12×20 and is assembled from a head, a torso and legs, in four directions
 * ('left' is 'right' mirrored). Letters map to palette colours; '.' is transparent.
 *   K outline · H hair · S skin · D skin shade (mouth, closed eyes) · E eyes
 *   C shirt · T shirt detail (tie, stripe) · P trousers · F shoes · Y hat · G glasses
 */

type Grid = readonly string[];

const HEAD: Record<'down' | 'up' | 'right', Grid> = {
  down: [
    '...KKKKKK...',
    '..KHHHHHHK..',
    '.KHHHHHHHHK.',
    '.KHHHHHHHHK.',
    '.KHSSSSSSHK.',
    '.KSSESSESSK.',
    '.KSSSSSSSSK.',
    '..KSSDDSSK..',
    '...KKSSKK...',
  ],
  up: [
    '...KKKKKK...',
    '..KHHHHHHK..',
    '.KHHHHHHHHK.',
    '.KHHHHHHHHK.',
    '.KHHHHHHHHK.',
    '.KHHHHHHHHK.',
    '.KSHHHHHHSK.',
    '..KSHHHHSK..',
    '...KKSSKK...',
  ],
  right: [
    '...KKKKKK...',
    '..KHHHHHHK..',
    '.KHHHHHHHHK.',
    '.KHHHHHHHHK.',
    '.KHHHHSSSSK.',
    '.KHHHSSSESK.',
    '.KHHSSSSSSK.',
    '..KHSSSSDK..',
    '...KKSSKK...',
  ],
};

/** Row 5 of the front head with the eyes shut (blinking). */
const BLINK_ROW = '.KSSDSSDSSK.';
/** Row 5 of the front head with glasses. */
const GLASSES_ROW = '.KGGEGGEGGK.';
const GLASSES_ROW_SIDE = '.KHHHSSGGGK.';

/** A hard hat replaces the top of the head (rows 0–3). */
const HAT: Record<'down' | 'up' | 'right', Grid> = {
  down: ['...KKKKKK...', '..KYYYYYYK..', '.KYYYYYYYYK.', 'KKKKKKKKKKKK'],
  up: ['...KKKKKK...', '..KYYYYYYK..', '.KYYYYYYYYK.', 'KKKKKKKKKKKK'],
  right: ['...KKKKKK...', '..KYYYYYYK..', '.KYYYYYYYYK.', '.KKKKKKKKKKK'],
};

const TORSO = {
  down: [
    '..KKCTTCKK..',
    '.KCCCTTCCCK.',
    'KCCCCTTCCCCK',
    'KCKCCTTCCKCK',
    'KSKCCCCCCKSK',
    '.KKPPPPPPKK.',
  ],
  up: [
    '..KKCCCCKK..',
    '.KCCCCCCCCK.',
    'KCCCCCCCCCCK',
    'KCKCCCCCCKCK',
    'KSKCCCCCCKSK',
    '.KKPPPPPPKK.',
  ],
  right: [
    '...KKCCKK...',
    '...KCCCCK...',
    '..KCCCCCCK..',
    '..KCKCCCCK..',
    '..KCSKCCCK..',
    '...KPPPPK...',
  ],
  /** Seated at a desk: elbows forward, hands on the desk (drawn by the renderer). */
  seated: [
    '..KKCTTCKK..',
    '.KCCCTTCCCK.',
    'KCCCCTTCCCCK',
    'KCCKCTTCKCCK',
    'KCCKCCCCKCCK',
    '.KKKPPPPKKK.',
  ],
} satisfies Record<string, Grid>;

const LEGS = {
  stand: [
    '..KPPPPPPK..',
    '..KPPKKPPK..',
    '..KPPKKPPK..',
    '..KFFKKFFK..',
    '..KKKKKKKK..',
  ],
  stepA: [
    '..KPPPPPPK..',
    '..KPPKKPPK..',
    '..KPPKKFFK..',
    '..KFFK.KKK..',
    '..KKKK......',
  ],
  stepB: [
    '..KPPPPPPK..',
    '..KPPKKPPK..',
    '..KFFKKPPK..',
    '..KKK.KFFK..',
    '......KKKK..',
  ],
  sideStand: [
    '...KPPPPK...',
    '...KPPPPK...',
    '...KPPPPK...',
    '...KFFFFFK..',
    '...KKKKKKK..',
  ],
  sideStep: [
    '...KPPPPK...',
    '..KPPKKPPK..',
    '.KPPK..KPPK.',
    '.KFFK..KFFFK',
    '.KKK....KKKK',
  ],
} satisfies Record<string, Grid>;

export const SPRITE_WIDTH = 12;
export const SPRITE_HEIGHT = 20;
/** How far down a character sinks when it sits behind a desk. */
export const SEATED_DROP = 3;

export interface Palette {
  K: string;
  H: string;
  S: string;
  D: string;
  E: string;
  C: string;
  T: string;
  P: string;
  F: string;
  Y: string;
  G: string;
}

export interface Look {
  palette: Palette;
  hat?: boolean;
  glasses?: boolean;
}

const OUTLINE = '#1b1b1f';
const base = {
  K: OUTLINE,
  E: '#1b1b1f',
  F: '#2a2320',
  Y: '#f2c230',
  G: '#4a4f57',
};

export const LOOKS: Record<AgentId, Look> = {
  manager: {
    palette: {
      ...base,
      H: '#3b2a20',
      S: '#e9b48a',
      D: '#c48a62',
      C: '#2f3f6b',
      T: '#c0392b',
      P: '#24283a',
    },
  },
  hazeops: {
    palette: {
      ...base,
      H: '#1f1f1f',
      S: '#c98e62',
      D: '#a06b45',
      C: '#e07b24',
      T: '#f2d04e',
      P: '#3d4a5c',
    },
  },
  worldmodel: {
    palette: {
      ...base,
      H: '#6b4a2b',
      S: '#f1c7a0',
      D: '#cf9f78',
      C: '#3567b5',
      T: '#9cc0f0',
      P: '#2b2b33',
    },
  },
  hmem: {
    palette: {
      ...base,
      H: '#c9c9c9',
      S: '#e2b08a',
      D: '#bb8763',
      C: '#2a9d8f',
      T: '#bfe8e2',
      P: '#33443f',
    },
  },
  evidencecritic: {
    palette: {
      ...base,
      H: '#2b1b12',
      S: '#8d5a3b',
      D: '#6b3f26',
      C: '#7b4fa0',
      T: '#e8e8e8',
      P: '#2b2b2b',
    },
    glasses: true,
  },
  workershield: {
    palette: {
      ...base,
      H: '#d9a441',
      S: '#f0c39b',
      D: '#c9946c',
      C: '#3f8f4f',
      T: '#f5d76e',
      P: '#3a3a2c',
    },
    hat: true,
  },
};

export type Gait = 'stand' | 'stepA' | 'stepB';

export interface FrameSpec {
  facing: Facing;
  gait: Gait;
  seated: boolean;
  blink: boolean;
}

function buildFrame(look: Look, spec: FrameSpec): Grid {
  const dir = spec.facing === 'left' ? 'right' : spec.facing;
  const head = [...HEAD[dir]];
  if (look.hat) head.splice(0, 4, ...HAT[dir]);
  if (dir === 'down') {
    if (spec.blink) head[5] = BLINK_ROW;
    else if (look.glasses) head[5] = GLASSES_ROW;
  } else if (dir === 'right' && look.glasses && !spec.blink) {
    head[5] = GLASSES_ROW_SIDE;
  }
  const torso = spec.seated ? TORSO.seated : TORSO[dir];
  const legs =
    dir === 'right'
      ? spec.gait === 'stand'
        ? LEGS.sideStand
        : LEGS.sideStep
      : LEGS[spec.gait];
  return [...head, ...torso, ...legs];
}

// Frames are cached as small canvases per look + frame (like pixel-agents' sprite cache).
const cache = new Map<string, HTMLCanvasElement>();

function frameCanvas(id: AgentId, spec: FrameSpec): HTMLCanvasElement {
  const cacheKey = `${id}|${spec.facing}|${spec.gait}|${spec.seated}|${spec.blink}`;
  let canvas = cache.get(cacheKey);
  if (canvas) return canvas;
  const look = LOOKS[id];
  const rows = buildFrame(look, spec);
  canvas = document.createElement('canvas');
  canvas.width = SPRITE_WIDTH;
  canvas.height = SPRITE_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const k = row[c] as keyof Palette | '.';
      if (k === '.') continue;
      ctx.fillStyle = look.palette[k];
      ctx.fillRect(c, r, 1, 1);
    }
  });
  cache.set(cacheKey, canvas);
  return canvas;
}

/** Draw a character with its feet at (x, y). */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  id: AgentId,
  spec: FrameSpec,
  x: number,
  y: number,
): void {
  const img = frameCanvas(id, spec);
  const left = Math.round(x - SPRITE_WIDTH / 2);
  const top = Math.round(y - SPRITE_HEIGHT);
  if (spec.facing === 'left') {
    ctx.save();
    ctx.translate(left + SPRITE_WIDTH, top);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(img, left, top);
  }
}

// ---------------------------------------------------------------------------
// The office cat
// ---------------------------------------------------------------------------

const CAT: Record<'walkA' | 'walkB' | 'sit', Grid> = {
  walkA: [
    '.......K.K',
    '.......KKK',
    'K......KOE',
    'K.KKKKKKOK',
    '.KOOOOOOK.',
    '.KOK..KOK.',
    '.KK...KK..',
  ],
  walkB: [
    '.......K.K',
    '.......KKK',
    'K......KOE',
    '.KKKKKKKOK',
    '.KOOOOOOK.',
    '..KOKKOK..',
    '..KK..KK..',
  ],
  sit: [
    '......K.K.',
    '......KKKK',
    '......KOEK',
    '..KKKKKOOK',
    'K.KOOOOOK.',
    'KKOOOOOOK.',
    '.KKKKKKKK.',
  ],
};
const CAT_COLORS: Record<string, string> = {
  K: '#2b2420',
  O: '#e39a4c',
  E: '#2b2420',
};

/** Draw the cat with its feet at (x, y), facing right unless `left`. */
export function drawCat(
  ctx: CanvasRenderingContext2D,
  frame: keyof typeof CAT,
  x: number,
  y: number,
  left: boolean,
): void {
  const rows = CAT[frame];
  const w = rows[0].length;
  const x0 = Math.round(x - w / 2);
  const y0 = Math.round(y - rows.length);
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const k = row[c];
      if (k === '.') continue;
      ctx.fillStyle = CAT_COLORS[k]!;
      ctx.fillRect(left ? x0 + w - 1 - c : x0 + c, y0 + r, 1, 1);
    }
  });
}

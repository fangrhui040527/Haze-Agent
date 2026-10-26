// Reading aid for Skia/Chromium PDFs storing text as glyph IDs.
// Handles 1- and 2-byte codes, and resolves fonts per page (names like /F5 are reused).
// Scratchpad only - not project code.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const buf = readFileSync(process.argv[2]);
const raw = buf.toString('latin1');

function inflateAt(start) {
  let p = start;
  while (buf[p] === 13 || buf[p] === 10) p++;
  const end = buf.indexOf('endstream', p);
  if (end < 0) return null;
  const body = buf.subarray(p, end);
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      /* next */
    }
  }
  return null;
}

const objects = new Map();
for (const m of raw.matchAll(/(\d+) 0 obj/g)) {
  const from = m.index + m[0].length;
  const endObj = raw.indexOf('endobj', from);
  const sIdx = raw.indexOf('stream', from);
  const hasStream = sIdx >= 0 && sIdx < endObj;
  objects.set(Number(m[1]), {
    head: raw.slice(from, hasStream ? sIdx : endObj),
    streamStart: hasStream ? sIdx + 6 : null,
  });
}

const hexToStr = (h) => {
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) {
    out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  }
  return out;
};

function parseCMap(text) {
  const map = new Map();
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const base = parseInt(p[3], 16);
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
    for (const p of blk[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      const lo = parseInt(p[1], 16);
      [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((it, i) =>
        map.set(lo + i, hexToStr(it[1])),
      );
    }
  }
  return map;
}

const cmapCache = new Map();
function fontMap(num, seen = new Set()) {
  if (cmapCache.has(num)) return cmapCache.get(num);
  if (seen.has(num)) return new Map();
  seen.add(num);
  const o = objects.get(num);
  let map = new Map();
  if (o) {
    const tu = /\/ToUnicode\s+(\d+) 0 R/.exec(o.head);
    if (tu) {
      const t = objects.get(Number(tu[1]));
      if (t?.streamStart != null) {
        const d = inflateAt(t.streamStart);
        if (d) map = parseCMap(d.toString('latin1'));
      }
    } else {
      const df = /\/DescendantFonts\s*\[\s*(\d+) 0 R/.exec(o.head);
      if (df) map = fontMap(Number(df[1]), seen);
    }
  }
  // code width: 1 byte if every mapped code fits in a byte
  const wide = [...map.keys()].some((k) => k > 0xff);
  const result = { map, step: wide ? 4 : 2 };
  cmapCache.set(num, result);
  return result;
}

// --- pages: content stream + its own font resources ----------------------
function fontsFrom(headText) {
  const names = new Map();
  const fd = /\/Font\s*<<([\s\S]*?)>>/.exec(headText);
  if (fd) {
    for (const p of fd[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+) 0 R/g)) {
      names.set(p[1], Number(p[2]));
    }
  }
  return names;
}

const pages = [];
for (const [, o] of objects) {
  if (!/\/Type\s*\/Page\b/.test(o.head)) continue;
  const contents = [...o.head.matchAll(/\/Contents\s+(\d+) 0 R/g)].map((m) =>
    Number(m[1]),
  );
  let fonts = fontsFrom(o.head);
  if (fonts.size === 0) {
    const rref = /\/Resources\s+(\d+) 0 R/.exec(o.head);
    if (rref) fonts = fontsFrom(objects.get(Number(rref[1]))?.head ?? '');
  }
  if (contents.length) pages.push({ contents, fonts });
}

const lines = [];
for (const page of pages) {
  for (const cnum of page.contents) {
    const o = objects.get(cnum);
    if (!o || o.streamStart == null) continue;
    const d = inflateAt(o.streamStart);
    if (!d) continue;
    const text = d.toString('latin1');
    let font = { map: new Map(), step: 2 };
    let lastY = null;
    let line = '';
    const flush = () => {
      if (line.trim()) lines.push(line.replace(/\s+/g, ' ').trim());
      line = '';
    };
    const decode = (hex) => {
      let out = '';
      for (let i = 0; i + font.step <= hex.length; i += font.step) {
        out += font.map.get(parseInt(hex.slice(i, i + font.step), 16)) ?? '';
      }
      return out;
    };
    for (const t of text.matchAll(
      /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj|\[([\s\S]*?)\]\s*TJ|1 0 0 -1 ([-\d.]+) ([-\d.]+) Tm/g,
    )) {
      if (t[1] !== undefined) {
        const fo = page.fonts.get(t[1]);
        if (fo) font = fontMap(fo);
      } else if (t[2] !== undefined) {
        line += decode(t[2]);
      } else if (t[3] !== undefined) {
        for (const h of t[3].matchAll(/<([0-9a-fA-F]*)>/g))
          line += decode(h[1]);
      } else if (t[5] !== undefined) {
        const y = Number(t[5]);
        if (lastY !== null && Math.abs(y - lastY) > 0.6) flush();
        lastY = y;
      }
    }
    flush();
    lines.push('');
  }
}

process.stdout.write(lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
process.stderr.write(
  `[objects ${objects.size}, pages ${pages.length}, lines ${lines.filter(Boolean).length}]\n`,
);

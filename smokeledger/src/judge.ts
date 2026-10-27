// The judge lane: nothing reaches a user unless every factual sentence is
// backed by an evidence id that actually exists. Two layers:
//  1. deterministic: citations must exist; sentences with numbers must cite something;
//     banned wording ("guilty", "caused by <company>") is rejected
//  2. model: a Nemotron judge lane checks each cited sentence against its evidence rows

import { CONFIG } from "./config.ts";
import { chat } from "./llm.ts";
import type { Evidence } from "./query.ts";

export interface Verdict {
  ok: boolean;
  problems: string[];
  judgeModel?: string;
}

// Evidence citations look like [E-0123456789]; H-MEM memory citations like [M:mem-12].
const CITE = /\[(E-[0-9a-f]{10}|M:[A-Za-z0-9_\-]+)\]/g;
const BANNED = [/\bguilty\b/i, /\bcriminal\b/i, /\bdeliberately\b/i, /\bset (the )?fires?\b/i, /\barson\b/i];

// Company abbreviations ("Sdn. Bhd.", "PT.") must not end a sentence.
const ABBREV = /\b(Sdn|Bhd|PT|Tbk|Ltd|Co|Inc|No|Jl|Jln|St|Dr|Mr|Mrs|Bros|approx)\.(?=\s)/g;
const DOT = "\u2024";

export function splitSentences(text: string): string[] {
  return text
    .replace(ABBREV, `$1${DOT}`)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replaceAll(DOT, ".").trim())
    .filter((s) => s.length > 0 && !/^#+\s/.test(s));
}

export interface MemoryCite {
  id: string;
  content: string;
}

export function deterministicCheck(text: string, evidence: Evidence[], memories: MemoryCite[] = []): Verdict {
  const known = new Set([...evidence.map((e) => e.evidence_id), ...memories.map((m) => `M:${m.id}`)]);
  const problems: string[] = [];
  for (const s of splitSentences(text)) {
    const cites = [...s.matchAll(CITE)].map((m) => m[1]);
    for (const c of cites) if (!known.has(c)) problems.push(`Unknown evidence id ${c} in: "${s}"`);
    const stripped = s.replace(CITE, "");
    if (/\d/.test(stripped) && !cites.length) problems.push(`Number without a citation: "${s}"`);
    for (const b of BANNED) if (b.test(s)) problems.push(`Wording implies guilt (not allowed): "${s}"`);
  }
  return { ok: problems.length === 0, problems };
}

export async function judge(
  text: string,
  evidence: Evidence[],
  opts: { useModel?: boolean; memories?: MemoryCite[] } = {},
): Promise<Verdict> {
  const memories = opts.memories ?? [];
  const det = deterministicCheck(text, evidence, memories);
  if (!det.ok || opts.useModel === false) return det;
  const cited = citedSentences(text);
  if (!cited.length) return det;
  // Small batches in parallel, each with only the evidence its sentences cite: a reasoning
  // model takes minutes on one long request. Every sentence still needs its own verdict.
  const batches: string[][] = [];
  for (let i = 0; i < cited.length; i += JUDGE_BATCH) batches.push(cited.slice(i, i + JUDGE_BATCH));
  const results = await Promise.all(batches.map((batch) => judgeBatch(batch, evidence, memories)));
  return {
    ok: results.every((r) => r.ok),
    problems: results.flatMap((r) => r.problems),
    judgeModel: results[0]?.judgeModel,
  };
}

const JUDGE_BATCH = 2;

async function judgeBatch(sentences: string[], evidence: Evidence[], memories: MemoryCite[]): Promise<Verdict> {
  const ids = new Set(sentences.flatMap((s) => [...s.matchAll(CITE)].map((m) => m[1])));
  const ev = [
    ...evidence.filter((e) => ids.has(e.evidence_id)).map((e) => `${e.evidence_id}\nSQL: ${e.sql}\n${judgeRows(e.rows)}`),
    ...memories.filter((m) => ids.has(`M:${m.id}`)).map((m) => `M:${m.id}\nMEMORY: ${m.content}`),
  ].join("\n\n");
  const { message, model } = await chat(
    [
      {
        role: "system",
        content:
          "You are a strict fact-checker. For each numbered sentence, check that the rows it cites support it " +
          "(allow rounding). Columns ending in _epoch are seconds since 1970-01-01 UTC. Reply ONLY with JSON, one verdict per sentence: " +
          '{"verdicts": [{"id": "S1", "supported": true, "reason": "<short reason>"}]}. "supported" must be true or false.',
      },
      { role: "user", content: `EVIDENCE:\n${ev}\n\nSENTENCES:\n${sentences.map((s, i) => `S${i + 1}: ${s}`).join("\n")}` },
    ],
    { model: CONFIG.llm.modelJudge, temperature: 0, json: true },
  );
  return { ...parseJudgeReply(message.content ?? "", sentences), judgeModel: model };
}

const JUDGE_ROW_LIMIT = 200;
const EPOCH_MIN = 1_500_000_000; // 2017
const EPOCH_MAX = 2_200_000_000; // 2039

/**
 * Display only (stored rows and hashes are untouched): show up to JUDGE_ROW_LIMIT rows and
 * annotate epoch-second values with UTC and Malaysia time so the model checks facts, not arithmetic.
 */
export function judgeRows(rows: unknown[][]): string {
  const label = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{10}$/.test(v) ? Number(v) : NaN;
    if (!(n >= EPOCH_MIN && n <= EPOCH_MAX)) return v;
    const utc = new Date(n * 1000);
    const myt = new Date(n * 1000 + 8 * 3_600_000);
    return `${v} (${utc.toISOString().slice(0, 16)}Z = ${myt.toISOString().slice(0, 16).replace("T", " ")} MYT)`;
  };
  const shown = rows.slice(0, JUDGE_ROW_LIMIT).map((row) => row.map(label));
  const note = rows.length > JUDGE_ROW_LIMIT ? `ROWS (first ${JUDGE_ROW_LIMIT} of ${rows.length}):` : `ROWS (all ${rows.length}):`;
  return `${note} ${JSON.stringify(shown)}`;
}

/** Sentences the model lane checks: those citing evidence or memory. */
export function citedSentences(text: string): string[] {
  return splitSentences(text).filter((s) => [...s.matchAll(CITE)].length > 0);
}

/**
 * Reads per-sentence verdicts. Fails closed: unreadable output, a missing verdict
 * or anything other than an explicit `supported: true` is a problem. A model that
 * also writes reasoning around the JSON is tolerated; only the JSON object counts.
 */
export function parseJudgeReply(content: string, sentences: string[]): Verdict {
  const raw = content.replace(/```(?:json)?/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let verdicts: unknown;
  try {
    verdicts = (JSON.parse(raw.slice(start, end + 1)) as { verdicts?: unknown }).verdicts;
  } catch {
    return { ok: false, problems: ["Judge returned unreadable output"] };
  }
  if (!Array.isArray(verdicts)) return { ok: false, problems: ["Judge returned unreadable output"] };
  const byId = new Map<string, { supported?: unknown; reason?: unknown }>();
  for (const v of verdicts) if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") byId.set((v as { id: string }).id, v);
  const problems: string[] = [];
  sentences.forEach((s, i) => {
    const v = byId.get(`S${i + 1}`);
    if (!v) problems.push(`No judge verdict for: "${s}"`);
    else if (v.supported !== true) problems.push(`${s}: ${typeof v.reason === "string" ? v.reason : "not supported by the cited rows"}`);
  });
  return { ok: problems.length === 0, problems };
}

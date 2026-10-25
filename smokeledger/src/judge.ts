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
  const ev = [
    ...evidence.map((e) => `${e.evidence_id}\nSQL: ${e.sql}\nROWS: ${JSON.stringify(e.rows.slice(0, 40))}`),
    ...memories.map((m) => `M:${m.id}\nMEMORY: ${m.content}`),
  ].join("\n\n");
  const { message, model } = await chat(
    [
      {
        role: "system",
        content:
          "You are a strict fact-checker. For each sentence that cites [E-...], check the cited rows support it " +
          "(allow rounding). Columns ending in _epoch are seconds since 1970-01-01 UTC. Reply ONLY with JSON: {\"unsupported\": [\"<sentence>: <reason>\", ...]}. Empty list if all supported.",
      },
      { role: "user", content: `EVIDENCE:\n${ev}\n\nTEXT:\n${text}` },
    ],
    { model: CONFIG.llm.modelJudge, temperature: 0, json: true },
  );
  try {
    const parsed = JSON.parse((message.content ?? "{}").replace(/^```(json)?|```$/g, "").trim());
    const unsupported: string[] = parsed.unsupported ?? [];
    return { ok: unsupported.length === 0, problems: unsupported, judgeModel: model };
  } catch {
    return { ok: false, problems: ["Judge returned unreadable output"], judgeModel: model };
  }
}

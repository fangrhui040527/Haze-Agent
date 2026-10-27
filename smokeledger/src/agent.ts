// The agent: Nemotron (via Nightshift) decides which tools to call; tools run the
// physics, query Zetaris, and recall H-MEM; the final answer must pass the judge lane.

import { CONFIG, HOUR } from "./config.ts";
import { runBackward, runForward } from "./engine.ts";
import { buildDossier } from "./dossier.ts";
import { buildWarning } from "./warning.ts";
import { chat, type ChatMessage, type ToolSpec } from "./llm.ts";
import { judge, type MemoryCite } from "./judge.ts";
import { recall } from "./meterless/hmem.ts";
import { evidence, type Evidence } from "./query.ts";

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "trace_smoke",
      description:
        "Backward attribution: where did the smoke over a Malaysian town come from (fires, peat, concessions, holders)? Returns shares with ranges and evidence ids.",
      parameters: {
        type: "object",
        properties: {
          town: { type: "string" },
          time_utc: { type: "string", description: "End of the period, ISO 8601 UTC, e.g. 2026-10-07T00:00:00Z" },
          window_hours: { type: "number", description: "Default 24" },
        },
        required: ["town", "time_utc"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forecast_town",
      description: "Forward outlook for a town: projected 24 h API, school-closure probability for coming mornings, smoke arrival.",
      parameters: {
        type: "object",
        properties: { town: { type: "string" }, now_utc: { type: "string", description: "ISO 8601 UTC; default now" } },
        required: ["town"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run ONE read-only Spark SQL query on Zetaris. Tables: {src}.fires, {src}.concessions, {src}.companies, {src}.pm25, {src}.towns, {src}.cases, {src}.case_events, {src}.attribution, {src}.projections. Write the {src}. prefix literally.",
      parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_history",
      description: "Recall remembered history (H-MEM) about a concession, company group, or town: past fires, notices, re-checks.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
];

const SYSTEM = `You are SmokeLedger, an evidence agent for Malaysia's transboundary haze.
Rules:
- Get facts only from tools. Every sentence with a number must end with the evidence id it came from, like [E-0123456789], or a memory id like [M:mem-3].
- Fires inside a concession show where land burned, not who lit it. Never call a company guilty or say it deliberately burned land.
- Give ranges and confidence when tools provide them. If the data cannot answer, say so.
- Answer in the user's language (Bahasa Malaysia or English). Be brief.`;

export async function ask(question: string, maxSteps = 8): Promise<{ answer: string; evidence: Evidence[]; verified: boolean; problems: string[]; model: string }> {
  const ev: Evidence[] = [];
  const mems: MemoryCite[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: question },
  ];
  let model = CONFIG.llm.modelDeep;

  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === "run_sql") {
      const e = await evidence(String(args.sql));
      ev.push(e);
      return { evidence_id: e.evidence_id, rows: e.rows.slice(0, 50) };
    }
    if (name === "trace_smoke") {
      const at = new Date(String(args.time_utc)).getTime();
      const r = await runBackward(String(args.town), at, Number(args.window_hours ?? 24));
      const d = await buildDossier(r);
      ev.push(...d.evidence);
      return { dossier: d.text.split("## What this does and does not show")[0], file: d.file };
    }
    if (name === "forecast_town") {
      const now = args.now_utc ? new Date(String(args.now_utc)).getTime() : Math.floor(Date.now() / HOUR) * HOUR;
      const fw = await runForward(now);
      const w = await buildWarning(fw, String(args.town));
      ev.push(...w.evidence);
      return { outlook: w.text, file: w.file };
    }
    if (name === "recall_history") {
      const r = await recall(String(args.query), 6);
      mems.push(...r.items);
      return { memories: r.items.map((m) => ({ id: `M:${m.id}`, content: m.content })) };
    }
    return { error: `unknown tool ${name}` };
  };

  for (let step = 0; step < maxSteps; step++) {
    const { message, model: m } = await chat(messages, { tools: TOOLS });
    model = m;
    if (!message.tool_calls?.length) {
      let answer = (message.content ?? "").trim();
      let v = await judge(answer, ev, { memories: mems });
      if (!v.ok) {
        messages.push(message, {
          role: "user",
          content: `The fact-checker rejected your answer: ${v.problems.join("; ")}. Rewrite it so every number cites a valid id from the tool results, and remove anything unsupported.`,
        });
        const retry = await chat(messages);
        answer = (retry.message.content ?? "").trim();
        v = await judge(answer, ev, { memories: mems });
      }
      return { answer, evidence: ev, verified: v.ok, problems: v.problems, model };
    }
    messages.push(message);
    for (const call of message.tool_calls) {
      let result: unknown;
      try {
        result = await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"));
      } catch (e) {
        result = { error: (e as Error).message.slice(0, 400) };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result, null, 0).slice(0, 12_000) });
    }
  }
  return { answer: "", evidence: ev, verified: false, problems: ["Stopped: too many steps"], model };
}

// SmokeLedger command line. Run `npm run sl -- help`.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { CONFIG, HOUR, PARAMS } from "./config.ts";
import { closeDb, db } from "./db.ts";
import { prepare } from "./seed.ts";
import * as load from "./load.ts";
import { getTown, runBackward, runForward } from "./engine.ts";
import { buildDossier, localTime } from "./dossier.ts";
import { buildWarning } from "./warning.ts";
import { approve, draftNotice, getCase, listCases, recheck, scan } from "./cases.ts";
import { ask } from "./agent.ts";
import { listModels } from "./llm.ts";
import { auditMemory, hmem, memoryStatus, recall } from "./meterless/hmem.ts";
import { runSql, verifyEvidence } from "./query.ts";
import { bestSeries, project, type PmPoint } from "./closure.ts";

const HELP = `SmokeLedger: haze evidence agent

Setup
  db:init                                  create tables, towns, guidance (+ sample episode in SAMPLE_MODE)
  urls --from YYYY-MM-DD --to YYYY-MM-DD   print the exact API calls to fetch
  check                                    test Postgres, Zetaris, Nightshift, H-MEM

Load the files you fetched
  load towns [towns.csv]
  load concessions <file.geojson> --source "GFW oil palm" --date 2019 [--id F --name F --company F --group F --type F]
  load peat <file.geojson>
  load companies <companies.csv>
  load fires <firms1.csv> [firms2.csv ...]
  load wind <openmeteo1.json> [...]
  load pm25 <file.json|file.csv> --kind model|observed [--issued now|ISO] [--towns "A,B,..."] [--source text]
  overlay                                  re-tag fires with concession/peat after loading new maps

Protect (forward)
  forecast --town T [--now ISO] [--hindsight]           outlook + BM parent/school drafts
  replay --town T --from ISO --to ISO [--every 3] [--actual ISO] [--threshold 0.7] [--hindsight]

Trace (backward)
  trace --town T --at ISO [--window 24] [--llm]         smoke source dossier

Act (warn -> record -> escalate)
  scan [--now ISO]            open cases for burning concessions whose plume reaches Malaysia
  cases                       list cases
  draft <case_id> [--now ISO] draft the notice (cites evidence + H-MEM history)
  approve <case_id> [--yes] [--now ISO]   human approval, then "send" (sandbox in DEMO_MODE)
  recheck [--now ISO]         re-check notified cases; drafts escalation if still burning

Ask / audit
  ask "question"              Nemotron agent with tools, answer checked by the judge lane
  verify <evidence_id>        re-run a cited query and compare its hash
  sql "SELECT ..."            run a read-only query on the configured backend
  memory:recall "query"       what H-MEM remembers
  memory:audit <memory_id>    H-MEM trust-ledger history for one memory
  models                      list Nightshift routes`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const timeArg = (v: string | true | undefined, fallback: number): number => {
  if (typeof v !== "string") return fallback;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) throw new Error(`Bad time: ${v} (use ISO 8601, e.g. 2026-10-07T00:00:00Z)`);
  return t;
};
const nowHour = () => Math.floor(Date.now() / HOUR) * HOUR;
const need = (v: string | true | undefined, name: string): string => {
  if (typeof v !== "string") throw new Error(`Missing --${name}`);
  return v;
};

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${prompt} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case "help":
      console.log(HELP);
      return;

    case "db:init": {
      const r = await prepare();
      console.log(`Schema, towns and guidance ready (${db().kind}).${r.seeded ? " Sample episode loaded (SAMPLE_MODE)." : ""}`);
      return;
    }

    case "urls":
      console.log(load.printUrls(need(flags.from, "from"), need(flags.to, "to")));
      return;

    case "check": {
      const line = (ok: boolean, name: string, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
      try {
        const r = await db().query("SELECT (SELECT count(*) FROM fires) f, (SELECT count(*) FROM wind) w, (SELECT count(*) FROM pm25) p, (SELECT count(*) FROM concessions) c");
        line(true, "Postgres", `fires=${r.rows[0].f} wind=${r.rows[0].w} pm25=${r.rows[0].p} concessions=${r.rows[0].c}`);
      } catch (e) {
        line(false, "Postgres", (e as Error).message);
      }
      try {
        const rows = await runSql("SELECT town FROM {src}.towns");
        line(true, `Query backend (${CONFIG.queryBackend})`, `${rows.length} towns visible`);
      } catch (e) {
        line(false, `Query backend (${CONFIG.queryBackend})`, (e as Error).message.slice(0, 200));
      }
      try {
        line(true, "Nightshift models", (await listModels()).slice(0, 6).join(", "));
      } catch (e) {
        line(false, "Nightshift models", (e as Error).message);
      }
      await hmem();
      line(memoryStatus().startsWith("H-MEM loaded"), "H-MEM", memoryStatus());
      console.log(`DEMO_MODE=${CONFIG.demoMode} (notices go to ${CONFIG.demoMode ? CONFIG.sandboxRecipient : "real recipients"})`);
      return;
    }

    case "load": {
      const [what, ...files] = pos;
      if (what === "towns") console.log(`towns: ${await load.loadTowns(files[0])}`);
      else if (what === "concessions")
        console.log(
          `concessions: ${await load.loadConcessions(files[0], {
            id: flags.id as string,
            name: flags.name as string,
            company: flags.company as string,
            group: flags.group as string,
            type: flags.type as string,
            country: flags.country as string,
            source: need(flags.source, "source"),
            date: need(flags.date, "date"),
          })} (run \`overlay\` if fires are already loaded)`,
        );
      else if (what === "peat")
        console.log(`peat polygons: ${load.loadPeat(files[0], flags.source as string | undefined)} (run \`overlay\` if fires are already loaded)`);
      else if (what === "companies") console.log(`companies: ${await load.loadCompanies(files[0])}`);
      else if (what === "fires") console.log("fires:", await load.loadFires(files));
      else if (what === "wind") console.log(`wind rows: ${await load.loadWind(files)}`);
      else if (what === "pm25") {
        const kind = need(flags.kind, "kind");
        if (kind !== "model" && kind !== "observed") throw new Error("--kind must be model or observed");
        const issued = flags.issued === "now" ? new Date().toISOString() : typeof flags.issued === "string" ? new Date(flags.issued).toISOString() : null;
        const towns = typeof flags.towns === "string" ? flags.towns.split(",").map((s) => s.trim()) : undefined;
        const source = typeof flags.source === "string" ? flags.source : kind === "model" ? "Open-Meteo CAMS" : "ground observations";
        console.log(`pm25 rows: ${await load.loadPm25(files, { kind, issued, towns, source })}`);
      } else throw new Error("load what? towns | concessions | peat | companies | fires | wind | pm25");
      return;
    }

    case "overlay":
      console.log(`fires re-tagged: ${await load.overlayAll()}`);
      return;

    case "trace": {
      const r = await runBackward(need(flags.town, "town"), timeArg(flags.at, nowHour()), Number(flags.window ?? 24));
      console.log(`Run ${r.run_id}: ${r.members} trajectories, ${r.firesWithWeight}/${r.firesConsidered} fires on the air's path`);
      const d = await buildDossier(r, { useLlm: !!flags.llm });
      if (d.narrative) console.log(`\nNemotron summary (judge: passed)\n${d.narrative}\n`);
      else if (d.narrativeVerdict) console.log(`\nNemotron summary rejected by the judge lane: ${d.narrativeVerdict.problems.join("; ")}\n`);
      console.log(d.text);
      console.log(`\nSaved: ${d.file}`);
      return;
    }

    case "forecast": {
      const now = timeArg(flags.now, nowHour());
      const fw = await runForward(now, { allowHindsight: !!flags.hindsight });
      const w = await buildWarning(fw, need(flags.town, "town"));
      console.log(w.text);
      console.log(`\n--- Parent notice (BM) ---\n${w.parentNoticeBM}\n\n--- School pre-notice (BM) ---\n${w.schoolNoticeBM}`);
      console.log(`\nSaved: ${w.file}`);
      return;
    }

    case "replay": {
      const town = (await getTown(need(flags.town, "town"))).town;
      const from = timeArg(flags.from, NaN);
      const to = timeArg(flags.to, NaN);
      const every = Number(flags.every ?? 3);
      const thr = Number(flags.threshold ?? 0.7);
      const lines: string[] = [`# Backtest: ${town}`, "", "| as of (MYT) | max P(API>200) next 36 h | max projected API |", "|---|---|---|"];
      let firstWarn: number | null = null;
      for (let t = from; t <= to; t += every * HOUR) {
        const fw = await runForward(t, { allowHindsight: !!flags.hindsight, skipTrajectories: true });
        const proj = (fw.projections.get(town) ?? []).filter((p) => p.tMs <= t + 36 * HOUR);
        const maxP = Math.max(0, ...proj.map((p) => p.p_close));
        const maxApi = Math.max(0, ...proj.map((p) => p.api));
        if (firstWarn === null && maxP >= thr) firstWarn = t;
        lines.push(`| ${localTime(t)} | ${proj.length ? Math.round(maxP * 100) + "%" : "no data"} | ${proj.length ? Math.round(maxApi) : "-"} |`);
      }
      // When did the API actually cross 200? From --actual, else from observed PM2.5.
      let actual: number | null = typeof flags.actual === "string" ? timeArg(flags.actual, NaN) : null;
      let actualSource = "given with --actual";
      if (actual === null) {
        const r = await db().query(
          `SELECT (extract(epoch FROM valid_utc)*1000)::bigint t, pm25, kind FROM pm25 WHERE town = $1 AND kind = 'observed' AND valid_utc BETWEEN $2 AND $3`,
          [town, new Date(from - 30 * HOUR).toISOString(), new Date(to + 72 * HOUR).toISOString()],
        );
        const pts: PmPoint[] = r.rows.map((x) => ({ tMs: Number(x.t), pm25: Number(x.pm25), kind: "observed", issuedMs: null }));
        const cross = project(bestSeries(pts, to + 72 * HOUR, false), from, Math.round((to - from) / HOUR) + 72).find(
          (p) => p.api > PARAMS.api.closeThreshold,
        );
        actual = cross?.tMs ?? null;
        actualSource = "first hour the observed 24 h API exceeded 200";
      }
      lines.push("");
      lines.push(`First warning (P >= ${Math.round(thr * 100)}%): ${firstWarn ? localTime(firstWarn) : "none in this period"}`);
      lines.push(`Actual: ${actual ? `${localTime(actual)} (${actualSource})` : "no crossing found (load observed PM2.5 or pass --actual)"}`);
      if (firstWarn && actual) lines.push(`Lead time: ${Math.round((actual - firstWarn) / HOUR)} hours`);
      if (flags.hindsight) lines.push("Caveat: future hours used archived model values (hindsight). Save live forecasts daily (--issued now) for a true test.");
      const out = lines.join("\n");
      fs.mkdirSync(CONFIG.outboxDir, { recursive: true });
      const file = path.join(CONFIG.outboxDir, `backtest-${town.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
      fs.writeFileSync(file, out + "\n");
      console.log(out);
      console.log(`\nSaved: ${file}`);
      return;
    }

    case "scan": {
      const fw = await runForward(timeArg(flags.now, nowHour()));
      const opened = await scan(fw);
      console.log(`${fw.clusters.length} active fire clusters; ${opened.length} new case(s): ${opened.join(", ") || "-"}`);
      return;
    }

    case "cases": {
      for (const c of await listCases())
        console.log(
          `${c.case_id}  ${c.status.padEnd(18)}  ${c.name ?? c.concession_id}  [${c.group_name ?? "-"}]  opened ${localTime(new Date(c.opened_utc).getTime())}` +
            (c.status === "NOTIFIED" && c.recheck_due_utc ? `  re-check ${localTime(new Date(c.recheck_due_utc).getTime())}` : ""),
        );
      return;
    }

    case "draft": {
      const d = await draftNotice(need(pos[0], "case_id"), timeArg(flags.now, Date.now()));
      console.log(d.text);
      console.log(`\nDraft saved: ${d.file}\nNext: npm run sl -- approve ${pos[0]}`);
      return;
    }

    case "approve": {
      const caseId = need(pos[0], "case_id");
      const k = await getCase(caseId);
      if (k.draft_path) console.log(fs.readFileSync(k.draft_path, "utf8"));
      console.log(`\nDEMO_MODE=${CONFIG.demoMode}: this will be sent to ${CONFIG.demoMode ? CONFIG.sandboxRecipient + " (sandbox)" : "the real recipient above"}.`);
      if (!flags.yes && !(await confirm("Approve and send?"))) {
        console.log("Not sent.");
        return;
      }
      const r = await approve(caseId, timeArg(flags.now, Date.now()));
      console.log(`Case ${caseId} -> ${r.status}. Written to ${r.sentFile} (intended recipient: ${r.intended})`);
      return;
    }

    case "recheck": {
      const res = await recheck(timeArg(flags.now, Date.now()));
      if (!res.length) console.log("No notified cases are due for a re-check.");
      for (const r of res) console.log(`${r.case_id}: ${r.firesAfter} fire detections after notice -> ${r.status}`);
      return;
    }

    case "ask": {
      const r = await ask(pos.join(" "));
      if (r.verified) console.log(r.answer);
      else console.log(`The judge lane could not verify the answer, so it is withheld.\nProblems: ${r.problems.join("; ")}`);
      console.log(`\nModel route: ${r.model}. Evidence: ${r.evidence.map((e) => e.evidence_id).join(", ") || "none"}`);
      return;
    }

    case "verify": {
      const v = await verifyEvidence(need(pos[0], "evidence_id"));
      console.log(`${v.ok ? "MATCH" : "MISMATCH"}  stored ${v.stored}\n           now    ${v.now}\n${v.sql}`);
      return;
    }

    case "sql":
      console.table(await runSql(pos.join(" ")));
      return;

    case "memory:recall": {
      const r = await recall(pos.join(" "), 8);
      console.log(r.reason ? `(${r.reason})` : "");
      for (const m of r.items) console.log(`${m.id}: ${m.content}`);
      return;
    }

    case "memory:audit":
      console.log(JSON.stringify(await auditMemory(need(pos[0], "memory_id")), null, 2));
      return;

    case "models":
      console.log((await listModels()).join("\n"));
      return;

    default:
      console.log(`Unknown command '${cmd}'.\n\n${HELP}`);
  }
}

main()
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

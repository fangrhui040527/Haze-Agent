// CLI behind run.mjs. Input is either a run request (same JSON as POST /run) or a
// scenario: { "scenario_steps": [ {action:"run", request}, {action:"load_fixture", name},
//                                 {action:"heartbeat_tick", now} ] }
import fs from "node:fs";
import { closeDb } from "./db.ts";
import { prepare, loadFixture } from "./seed.ts";
import { executeRun, InputError } from "./run.ts";
import { tick } from "./heartbeat.ts";
import type { RunRequest } from "./orchestration/types.ts";

type Step = { action: "run"; request: RunRequest } | { action: "load_fixture"; name: string } | { action: "heartbeat_tick"; now?: string };

export async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = arg("--input");
  if (!file) {
    console.error("usage: node run.mjs --input FILE [--out FILE]");
    return 2;
  }
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    await prepare();
    const steps: Step[] = body.scenario_steps ?? [{ action: "run", request: body }];
    const results: unknown[] = [];
    let code = 0;
    for (const st of steps) {
      if (st.action === "run") {
        const r = await executeRun(st.request);
        if (r.status === "error") code = 1;
        results.push({ step: "run", result: r });
      } else if (st.action === "load_fixture") results.push({ step: "load_fixture", result: await loadFixture(st.name) });
      else if (st.action === "heartbeat_tick") results.push({ step: "heartbeat_tick", result: await tick(st.now ? Date.parse(st.now) : Date.now()) });
    }
    const out = body.scenario_steps ? { scenario: file, steps: results } : (results[0] as { result: unknown }).result;
    const json = JSON.stringify(out, null, 2);
    const outFile = arg("--out");
    if (outFile) fs.writeFileSync(outFile, json + "\n");
    console.log(json);
    return code;
  } catch (e) {
    if (e instanceof InputError) {
      console.log(JSON.stringify({ status: "error", error: { type: "invalid_input", message: e.message, recoverable: false, failed_dependencies: [] } }, null, 2));
      return 2;
    }
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  } finally {
    await closeDb();
  }
}

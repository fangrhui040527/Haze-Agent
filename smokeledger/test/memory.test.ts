// Feature test for the Meterless H-MEM integration: a memory written in one
// session is recalled in the next, and the trust ledger records it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entry = path.resolve("vendor", "hmem", "src", "index.ts");

test("H-MEM remembers a concession across sessions", { skip: !fs.existsSync(entry) && "run npm run setup first" }, async () => {
  const { HMEM } = await import(pathToFileURL(entry).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-"));
  const s1 = new HMEM({ persistDir: dir, actor: "smokeledger" });
  const rec = s1.add({
    content: "Concession PT Contoh Sawit Lestari had 14 fire detections on peat; notice sent; still burning 48 h later.",
    type: "factual",
    layer: "long_term",
    tags: ["concession:demo:1"],
    source: "smokeledger",
  });
  const s2 = new HMEM({ persistDir: dir, actor: "smokeledger" }); // a new session
  const res = s2.query("Contoh Sawit Lestari fire history", { threshold: 0.2 }); // same threshold as src/memory.ts
  assert.ok(res.memories.some((m: { memory: { id: string } }) => m.memory.id === rec.id), "memory recalled in new session");
  assert.ok(s2.ledger.history(rec.id).length >= 1, "ledger has the write");
});

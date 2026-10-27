#!/usr/bin/env node
// Vendors the official Meterless engines at a PINNED revision (build time only, never at startup):
//   vendor/hmem, vendor/world-model            reference implementations used by the app
//   vendor/hmem-conformance, vendor/world-model-conformance   upstream conformance suites
// and records what loaded in engine_sources.json (revision + sha256 of every source file).
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO = "meterless/meterless";
const REV = process.env.METERLESS_REV ?? "1742dec56a66e58eef9dda2d2b865823758ca8cd";
const parts = [
  ["engines/hmem/reference", "vendor/hmem"],
  ["engines/hmem/conformance", "vendor/hmem-conformance"],
  ["engines/world-model/reference", "vendor/world-model"],
  ["engines/world-model/conformance", "vendor/world-model-conformance"],
];

for (const [src, dest] of parts) {
  if (process.env.SKIP_DOWNLOAD && fs.existsSync(dest)) continue;
  fs.rmSync(dest, { recursive: true, force: true });
  execSync(`npx --yes degit ${REPO}/${src}#${REV} ${dest}`, { stdio: "inherit" });
}

function digest(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p.replace(/\\/g, "/")).update(fs.readFileSync(p));
    });
  walk(dir);
  return h.digest("hex");
}

const record = {
  generated_utc: new Date().toISOString(),
  repository: `https://github.com/${REPO}`,
  revision: REV,
  licence: "Apache-2.0",
  hmem: { path: "engines/hmem/reference", vendored_to: "vendor/hmem", src_sha256: digest("vendor/hmem/src") },
  world_model: { path: "engines/world-model/reference", vendored_to: "vendor/world-model", src_sha256: digest("vendor/world-model/src") },
};
fs.writeFileSync("engine_sources.json", JSON.stringify(record, null, 2) + "\n");
console.log(`Vendored Meterless engines at ${REV}; wrote engine_sources.json`);

import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicCheck, splitSentences } from "../src/judge.ts";
import type { Evidence } from "../src/query.ts";

const ev = (id: string): Evidence => ({ evidence_id: id, backend: "postgres", sql: "SELECT 1", executed_utc: "", row_count: 1, sha256: "", rows: [[1]] });
const E = [ev("E-0123456789")];

test("numbers need a valid citation", () => {
  assert.equal(deterministicCheck("Peat share was 42% [E-0123456789].", E).ok, true);
  assert.equal(deterministicCheck("Peat share was 42%.", E).ok, false);
  assert.equal(deterministicCheck("Peat share was 42% [E-aaaaaaaaaa].", E).ok, false);
});

test("memory citations are accepted when the memory exists", () => {
  assert.equal(deterministicCheck("Notified on 5 Oct [M:mem-3].", E, [{ id: "mem-3", content: "x" }]).ok, true);
  assert.equal(deterministicCheck("Notified on 5 Oct [M:mem-9].", E, [{ id: "mem-3", content: "x" }]).ok, false);
});

test("guilt wording is rejected", () => {
  assert.equal(deterministicCheck("The company is guilty of burning.", E).ok, false);
  assert.equal(deterministicCheck("Fires were on its concession.", E).ok, true);
});

test("company abbreviations do not split sentences", () => {
  const s = splitSentences("Holder: Contoh Sdn. Bhd. had 12 detections [E-0123456789]. Next line.");
  assert.equal(s.length, 2);
  assert.equal(deterministicCheck("Holder: Contoh Sdn. Bhd. had 12 detections [E-0123456789].", E).ok, true);
});

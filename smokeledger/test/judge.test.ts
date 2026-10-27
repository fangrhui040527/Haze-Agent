import { test } from "node:test";
import assert from "node:assert/strict";
import { citedSentences, deterministicCheck, judgeRows, parseJudgeReply, splitSentences } from "../src/judge.ts";
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

const S = citedSentences("Mean was 83.5 [E-0123456789]. Peak was 118 [E-0123456789]. No numbers here.");

test("judge: only explicit supported=false verdicts are problems, reasons included", () => {
  assert.deepEqual(S.length, 2);
  const ok = parseJudgeReply('{"verdicts":[{"id":"S1","supported":true,"reason":"rounds to 83.5"},{"id":"S2","supported":true,"reason":"max is 118"}]}', S);
  assert.deepEqual(ok, { ok: true, problems: [] });
  const bad = parseJudgeReply('{"verdicts":[{"id":"S1","supported":false,"reason":"mean is 83.49, not 25"},{"id":"S2","supported":true}]}', S);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, ["Mean was 83.5 [E-0123456789].: mean is 83.49, not 25"]);
});

test("judge: tolerates reasoning text around the JSON (Nemotron style)", () => {
  const reply = 'The user wants me to check two sentences. S1 rounds fine.\n```json\n{"verdicts":[{"id":"S1","supported":true},{"id":"S2","supported":true}]}\n```';
  assert.equal(parseJudgeReply(reply, S).ok, true);
});

test("judge: fails closed on unreadable output, missing verdicts and non-boolean verdicts", () => {
  assert.deepEqual(parseJudgeReply("I think it is all fine.", S).problems, ["Judge returned unreadable output"]);
  assert.deepEqual(parseJudgeReply('{"unsupported": []}', S).problems, ["Judge returned unreadable output"]);
  const missing = parseJudgeReply('{"verdicts":[{"id":"S1","supported":true}]}', S);
  assert.deepEqual(missing.problems, ['No judge verdict for: "Peak was 118 [E-0123456789]."']);
  assert.equal(parseJudgeReply('{"verdicts":[{"id":"S1","supported":"yes"},{"id":"S2","supported":true}]}', S).ok, false);
});

test("judge rows: all rows up to the limit, epoch seconds annotated in UTC and Malaysia time", () => {
  const rows = Array.from({ length: 73 }, (_, i) => [1793120400 + i * 3600, 25 + i]);
  const shown = judgeRows(rows);
  assert.match(shown, /^ROWS \(all 73\):/);
  assert.match(shown, /1793120400 \(2026-10-27T17:00Z = 2026-10-28 01:00 MYT\)/);
  assert.match(shown, /2026-10-30T17:00Z = 2026-10-31 01:00 MYT/, "the 73rd row is visible");
  assert.match(judgeRows([[42.5, "Batu Pahat"]]), /\[42\.5,"Batu Pahat"\]/, "non-epoch values are unchanged");
  assert.match(judgeRows(Array.from({ length: 250 }, () => [1])), /^ROWS \(first 200 of 250\):/);
});

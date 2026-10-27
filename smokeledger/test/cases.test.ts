import { test } from "node:test";
import assert from "node:assert/strict";
import { onApprove, onRecheck } from "../src/cases.ts";
import { HOUR } from "../src/config.ts";

const t0 = Date.UTC(2026, 9, 5, 6);

test("approve a notice -> NOTIFIED with a re-check due in 24 h", () => {
  const r = onApprove("NOTICE_PENDING", t0);
  assert.equal(r.status, "NOTIFIED");
  assert.equal(r.recheckDueMs, t0 + 24 * HOUR);
});

test("still burning after notice -> escalation pending", () => {
  assert.equal(onRecheck({ status: "NOTIFIED", notifiedMs: t0, recheckDueMs: t0 + 24 * HOUR }, 3, t0 + 25 * HOUR).status, "ESCALATION_PENDING");
});

test("quiet for 24 h -> keep watching; quiet for 48 h -> resolved", () => {
  const a = onRecheck({ status: "NOTIFIED", notifiedMs: t0, recheckDueMs: t0 + 24 * HOUR }, 0, t0 + 25 * HOUR);
  assert.equal(a.status, "NOTIFIED");
  assert.equal(a.recheckDueMs, t0 + 49 * HOUR);
  assert.equal(onRecheck({ status: "NOTIFIED", notifiedMs: t0, recheckDueMs: t0 + 49 * HOUR }, 0, t0 + 49 * HOUR).status, "RESOLVED");
});

test("re-check before it is due changes nothing", () => {
  assert.equal(onRecheck({ status: "NOTIFIED", notifiedMs: t0, recheckDueMs: t0 + 24 * HOUR }, 9, t0 + 2 * HOUR).status, "NOTIFIED");
});

test("approving an escalation -> ESCALATED; approving anything else throws", () => {
  assert.equal(onApprove("ESCALATION_PENDING", t0).status, "ESCALATED");
  assert.throws(() => onApprove("NOTIFIED", t0));
});

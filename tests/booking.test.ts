// Run with: node --experimental-strip-types tests/booking.test.ts
import assert from "node:assert/strict";
import {
  todayIoM,
  addDays,
  isFriday,
  spanDaysFor,
  coveredDates,
  lastDay,
  overlapsAny,
  journeysFor,
  transportPence,
  computeEstimate,
} from "../shared/booking.ts";

// --- Isle of Man local dates, including the BST midnight hour -------------
assert.equal(todayIoM(new Date("2026-01-15T10:00:00Z")), "2026-01-15");
// 23:30 UTC in July is 00:30 BST the NEXT day on the Isle of Man:
assert.equal(todayIoM(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
// 23:30 UTC in January is still the same day (GMT):
assert.equal(todayIoM(new Date("2026-01-01T23:30:00Z")), "2026-01-01");

// --- calendar arithmetic across the DST changes ---------------------------
assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // clocks go forward 29 Mar
assert.equal(addDays("2026-10-24", 2), "2026-10-26"); // clocks go back 25 Oct
assert.equal(addDays("2026-12-31", 1), "2027-01-01");

// --- package spans, weekend includes the Monday return day ----------------
assert.equal(spanDaysFor("weekend", 63), 4);
assert.equal(spanDaysFor("24h", 24), 1);
assert.equal(spanDaysFor("48h", 48), 2);
assert.equal(spanDaysFor("3day", 72), 3);
assert.equal(spanDaysFor("week", 168), 7);
assert.equal(spanDaysFor("48h"), 2); // fallback without hours
assert.deepEqual(coveredDates("2026-10-16", 4), ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
assert.equal(lastDay("2026-10-16", 4), "2026-10-19");
assert.ok(isFriday("2026-10-16"));
assert.ok(!isFriday("2026-10-17"));

// --- overlap checks (inclusive both ends) ---------------------------------
const busy = [{ start_date: "2026-10-20", end_date: "2026-10-22" }];
assert.ok(overlapsAny("2026-10-22", 1, busy)); // touches last busy day
assert.ok(overlapsAny("2026-10-18", 3, busy)); // runs into the start
assert.ok(!overlapsAny("2026-10-23", 2, busy)); // starts the day after
assert.ok(!overlapsAny("2026-10-17", 3, busy)); // ends the day before

// --- transport -------------------------------------------------------------
const zone = { one_way_pence: 2000, both_pence: 4000 };
assert.equal(journeysFor("self"), 0);
assert.equal(transportPence("self", null), 0);
assert.equal(transportPence("deliver_only", zone), 2000);
assert.equal(transportPence("collect_only", zone), 2000);
assert.equal(transportPence("both", zone), 4000);
assert.equal(transportPence("quote", zone), null);
assert.equal(transportPence("both", null), null); // no zone chosen yet

// --- estimate: deposit separate, totals as specified -----------------------
const e = computeEstimate({ hirePence: 4500, transportPence: 0, extrasPence: [500], depositPence: 7500 });
assert.equal(e.chargesPence, 5000);
assert.equal(e.dueAtHandoverPence, 12500);
assert.equal(e.effectivePence, 5000);
const q = computeEstimate({ hirePence: 4500, transportPence: null, extrasPence: [], depositPence: 7500 });
assert.equal(q.transportQuoted, true);
assert.equal(q.dueAtHandoverPence, null);

console.log("booking.test.ts: all assertions passed");

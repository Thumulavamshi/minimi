import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTemporal } from "../src/time/temporal.ts";
import { formatDateTime, startOfDayMs } from "../src/time/zoned.ts";

const TZ = "Asia/Kolkata";
/** Tuesday 10 November 2026, 14:30 in Bengaluru. */
const NOW = Date.parse("2026-11-10T09:00:00Z");
/** Thursday 12 November 2026, 14:30 in Bengaluru. */
const THURSDAY = Date.parse("2026-11-12T09:00:00Z");

function labels(text: string, now = NOW, tz = TZ): string[][] {
  return resolveTemporal(text, now, tz).map((ref) => ref.candidates.map((c) => c.label));
}

test("the three prompts from the challenge brief", () => {
  assert.deepEqual(labels("On Monday we shortlisted 5 CRM tools for a 20-person sales team."), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(labels("What did I ask you on 3 November? Is your answer still correct today?"), [
    ["Tue 3 Nov 2026"],
    ["Tue 10 Nov 2026"],
  ]);
  assert.deepEqual(labels("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [
    ["Tue 3 Nov 2026"],
  ]);
});

test("explicit dates in several spellings", () => {
  for (const text of ["on 3rd Nov", "November 3", "Nov 3rd, 2026", "the 3rd of November 2026", "2026-11-03", "03/11/2026"]) {
    assert.equal(labels(text)[0]?.[0], "Tue 3 Nov 2026", text);
  }
});

test("a date with no year is its most recent occurrence", () => {
  assert.deepEqual(labels("on 25 December"), [["Thu 25 Dec 2025"]]);
  assert.deepEqual(labels("on 10 November"), [["Tue 10 Nov 2026"]]);
});

test("a slash date offers both day-first and month-first readings", () => {
  assert.deepEqual(labels("03/11/2026"), [["Tue 3 Nov 2026", "Wed 11 Mar 2026"]]);
});

test("'last Tuesday' said on a Thursday keeps both readings", () => {
  assert.deepEqual(labels("last Tuesday", THURSDAY), [["Tue 10 Nov 2026", "Tue 3 Nov 2026"]]);
  // The nearer Friday is already in the previous week, so there is one reading.
  assert.deepEqual(labels("last Friday", THURSDAY), [["Fri 6 Nov 2026"]]);
});

test("a weekday named on that same weekday means today, or a week ago", () => {
  assert.deepEqual(labels("on Tuesday"), [["Tue 10 Nov 2026", "Tue 3 Nov 2026"]]);
});

test("relative days, weeks and months", () => {
  assert.deepEqual(labels("yesterday"), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(labels("the day before yesterday"), [["Sun 8 Nov 2026"]]);
  assert.deepEqual(labels("3 days ago"), [["Sat 7 Nov 2026"]]);
  assert.deepEqual(labels("a couple of weeks ago"), [["Sat 24 Oct 2026 – Fri 30 Oct 2026"]]);
  assert.deepEqual(labels("last week"), [["Mon 2 Nov 2026 – Sun 8 Nov 2026"]]);
  assert.deepEqual(labels("earlier this week"), [["Mon 9 Nov 2026 – Tue 10 Nov 2026"]]);
  assert.deepEqual(labels("last month"), [["Thu 1 Oct 2026 – Sat 31 Oct 2026"]]);
  assert.deepEqual(labels("in the last 3 days"), [["Sat 7 Nov 2026 – Tue 10 Nov 2026"]]);
  assert.deepEqual(labels("last weekend"), [["Sat 7 Nov 2026 – Sun 8 Nov 2026"]]);
  assert.deepEqual(labels("in October"), [["Thu 1 Oct 2026 – Sat 31 Oct 2026"]]);
});

test("phrases about the future, and look-alikes, are not past dates", () => {
  assert.deepEqual(labels("remind me next Monday"), []);
  assert.deepEqual(labels("finish it by Friday"), []);
  assert.deepEqual(labels("the top 5 may be enough"), []);
  assert.deepEqual(labels("they offer 24/7 support"), []);
  assert.deepEqual(labels("what is the best CRM for a small team?"), []);
});

test("day boundaries follow the user's timezone", () => {
  // 20:30 UTC on 9 Nov is already 10 Nov in Bengaluru but still 9 Nov in Los Angeles.
  const instant = Date.parse("2026-11-09T20:30:00Z");
  assert.deepEqual(labels("today", instant, "Asia/Kolkata"), [["Tue 10 Nov 2026"]]);
  assert.deepEqual(labels("today", instant, "America/Los_Angeles"), [["Mon 9 Nov 2026"]]);

  const [ref] = resolveTemporal("3 November", NOW, TZ);
  assert.equal(ref?.candidates[0]?.startMs, Date.parse("2026-11-02T18:30:00Z"));
  assert.equal(ref?.candidates[0]?.endMs, Date.parse("2026-11-03T18:30:00Z"));
});

test("a day that contains a daylight-saving change still starts at local midnight", () => {
  // US clocks went back on 1 Nov 2026, so that day is 25 hours long.
  const start = startOfDayMs({ y: 2026, m: 11, d: 1 }, "America/New_York");
  const next = startOfDayMs({ y: 2026, m: 11, d: 2 }, "America/New_York");
  assert.equal(formatDateTime(start, "America/New_York"), "Sun 1 Nov 2026, 00:00");
  assert.equal((next - start) / 3_600_000, 25);
});

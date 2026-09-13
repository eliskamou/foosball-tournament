import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/tournament.js";
import { formatClock, formatDelta, parseClock, scheduleStatus, slotWindow } from "../src/time.js";

const settings = { ...DEFAULT_SETTINGS, startTime: "18:00", matchMinutes: 10, breakMinutes: 2 };
const match = (id, slot, table, played, playedAt = null) => ({
  id, homeId: id, awayId: id + 100, slot, table, homeScore: played ? 1 : null, awayScore: played ? 0 : null, played, playedAt, pinned: false,
});

/** A timestamp for today at the given wall-clock time, whatever the time zone. */
function today(hours, minutes) {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

test("clock strings are read and written back", () => {
  assert.equal(parseClock("18:00"), 1080);
  assert.equal(parseClock("9:05"), 545);
  assert.equal(parseClock("18.30"), 1110);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("nonsense"), null);
  assert.equal(formatClock(1080), "18:00");
  assert.equal(formatClock(545), "09:05");
});

test("a schedule running past midnight keeps counting", () => {
  assert.equal(formatClock(24 * 60 + 20), "00:20");
  assert.equal(formatClock(25 * 60 + 10), "01:10");
});

test("slots are spaced by the match length plus the break", () => {
  assert.deepEqual(slotWindow(1, settings), { start: 1080, end: 1090 });
  assert.deepEqual(slotWindow(4, settings), { start: 1080 + 36, end: 1080 + 46 });
});

test("delays are worded from the organiser's point of view", () => {
  assert.equal(formatDelta(0), "on time");
  assert.equal(formatDelta(7), "7 min behind");
  assert.equal(formatDelta(-3), "3 min ahead");
});

test("an empty schedule has no status", () => {
  assert.equal(scheduleStatus([], settings).state, "empty");
});

test("before the first result the first slot is up next", () => {
  const status = scheduleStatus([match(1, 1, 1, false), match(2, 1, 2, false)], settings, today(17, 45));
  assert.equal(status.state, "upcoming");
  assert.equal(status.currentSlot, 1);
  assert.equal(status.delayMinutes, 0);
  assert.equal(Math.round(status.dueInMinutes), 15);
});

test("the drift is measured against slots that actually finished", () => {
  // Slot 1 was planned to end at 18:10 and finished at 18:18.
  const matches = [
    match(1, 1, 1, true, today(18, 16)),
    match(2, 1, 2, true, today(18, 18)),
    match(3, 2, 1, false),
  ];
  const status = scheduleStatus(matches, settings, today(18, 20));
  assert.equal(status.state, "running");
  assert.equal(status.currentSlot, 2);
  assert.equal(status.measuredSlot, 1);
  assert.equal(status.delayMinutes, 8);
  // Slot 2 was due to end at 18:22; eight minutes late makes it 18:30.
  assert.equal(status.projectedEnd, slotWindow(2, settings).end + 8);
});

test("a half-finished slot is still the current one", () => {
  const matches = [match(1, 1, 1, true, today(18, 8)), match(2, 1, 2, false)];
  const status = scheduleStatus(matches, settings, today(18, 9));
  assert.equal(status.currentSlot, 1);
  assert.equal(status.measuredSlot, null);
});

test("a finished tournament reports when it actually ended", () => {
  const matches = [match(1, 1, 1, true, today(18, 15)), match(2, 1, 2, true, today(18, 14))];
  const status = scheduleStatus(matches, settings, today(18, 30));
  assert.equal(status.state, "finished");
  assert.equal(status.delayMinutes, 5);
  assert.equal(formatClock(status.projectedEnd), "18:15");
});

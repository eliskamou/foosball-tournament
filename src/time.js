/**
 * Clock arithmetic for the schedule.
 *
 * Everything is minutes past midnight of the day the tournament starts. Slots
 * that run past midnight simply keep counting (25:10 is 1510 minutes), which is
 * what an evening tournament needs and what plain `Date` maths gets wrong.
 */

import { matchesInSlot, slotNumbers } from "./tournament.js";

const MINUTES_PER_DAY = 24 * 60;

export function parseClock(value) {
  const match = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClock(minutes) {
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

export function formatDelta(minutes) {
  const rounded = Math.round(Math.abs(minutes));
  if (rounded === 0) return "on time";
  const label = rounded === 1 ? "1 min" : `${rounded} min`;
  return minutes > 0 ? `${label} behind` : `${label} ahead`;
}

function slotLength(settings) {
  return Math.max(1, settings.matchMinutes + settings.breakMinutes);
}

/** Planned start and end of a slot, in minutes past midnight. */
export function slotWindow(slotNumber, settings) {
  const start = (parseClock(settings.startTime) ?? 0) + (slotNumber - 1) * slotLength(settings);
  return { start, end: start + Math.max(1, settings.matchMinutes) };
}

/**
 * A wall-clock timestamp as minutes past the tournament's starting midnight.
 * Anything earlier than the start time is read as "after midnight", so a
 * tournament that begins at 20:00 and finishes at 00:20 stays in order.
 */
function clockMinutes(timestamp, settings) {
  const date = new Date(timestamp);
  const minutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const start = parseClock(settings.startTime) ?? 0;
  return minutes < start - 60 ? minutes + MINUTES_PER_DAY : minutes;
}

function slotIsComplete(matches, slotNumber) {
  const inSlot = matchesInSlot(matches, slotNumber);
  return inSlot.length > 0 && inSlot.every((match) => match.played);
}

/**
 * Where the tournament actually stands: which slot is up next, how far it has
 * drifted from the plan, and when it now looks like finishing.
 *
 * The drift is measured against real finishing times of completed slots rather
 * than against the wall clock, so it does not creep up while nothing is running.
 */
export function scheduleStatus(matches, settings, now = Date.now()) {
  const slots = slotNumbers(matches);
  if (slots.length === 0) return { state: "empty" };

  const lastSlot = slots[slots.length - 1];
  const currentSlot = slots.find((slot) => !slotIsComplete(matches, slot)) ?? null;

  let delayMinutes = 0;
  let measuredSlot = null;
  for (const slot of slots) {
    if (currentSlot !== null && slot >= currentSlot) break;
    if (!slotIsComplete(matches, slot)) continue;
    const stamps = matchesInSlot(matches, slot)
      .map((match) => match.playedAt)
      .filter((stamp) => Number.isFinite(stamp));
    if (stamps.length === 0) continue;
    delayMinutes = Math.max(...stamps.map((stamp) => clockMinutes(stamp, settings))) - slotWindow(slot, settings).end;
    measuredSlot = slot;
  }

  const projectedEnd = slotWindow(lastSlot, settings).end + Math.max(0, delayMinutes);

  if (currentSlot === null) {
    return {
      state: "finished",
      lastSlot,
      measuredSlot,
      delayMinutes,
      plannedEnd: slotWindow(lastSlot, settings).end,
      projectedEnd: slotWindow(lastSlot, settings).end + delayMinutes,
    };
  }

  const window = slotWindow(currentSlot, settings);
  return {
    state: currentSlot === slots[0] && measuredSlot === null ? "upcoming" : "running",
    currentSlot,
    lastSlot,
    measuredSlot,
    delayMinutes,
    plannedStart: window.start,
    plannedEnd: window.end,
    projectedEnd,
    dueInMinutes: window.start - clockMinutes(now, settings),
  };
}

/** A stored `playedAt` timestamp as a plain wall-clock label. */
export function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return formatClock(date.getHours() * 60 + date.getMinutes());
}

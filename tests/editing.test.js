import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  findConflicts,
  pairKey,
  planSchedule,
  slotNumbers,
} from "../src/tournament.js";

const teams = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));
const settings = (tableCount = 2) => ({ ...DEFAULT_SETTINGS, tableCount });
const find = (schedule, home, away) => schedule.find((match) => pairKey(match.homeId, match.awayId) === pairKey(home, away));

function playFirstSlots(schedule, slotCount) {
  for (const match of schedule) {
    if (match.slot > slotCount) continue;
    Object.assign(match, { homeScore: 3, awayScore: 1, played: true, playedAt: Date.now() });
  }
  return schedule;
}

test("a result survives a rebuild even when the pair is listed the other way round", () => {
  const original = planSchedule(teams(4), settings());
  Object.assign(original[0], { homeScore: 5, awayScore: 2, played: true });
  const flipped = original.map((match) => ({ ...match, homeId: match.awayId, awayId: match.homeId, homeScore: match.awayScore, awayScore: match.homeScore }));

  const rebuilt = planSchedule(teams(4), settings(3), flipped);
  const same = find(rebuilt, original[0].homeId, original[0].awayId);
  const scoreForOriginalHome = same.homeId === original[0].homeId ? same.homeScore : same.awayScore;
  assert.equal(scoreForOriginalHome, 5);
  assert.equal(same.played, true);
});

test("adding a team mid-tournament leaves played matches exactly where they were", () => {
  const before = playFirstSlots(planSchedule(teams(6), settings()), 3);
  const played = before.filter((match) => match.played).map((match) => ({ ...match }));

  const after = planSchedule([...teams(6), { id: 7, name: "Latecomer" }], settings(), before);

  assert.equal(after.length, 21);
  for (const old of played) {
    const now = find(after, old.homeId, old.awayId);
    assert.equal(now.slot, old.slot, "slot moved");
    assert.equal(now.table, old.table, "table moved");
    assert.equal(now.homeScore, old.homeScore);
    assert.equal(now.played, true);
  }
  assert.deepEqual(findConflicts(after, [...teams(6), { id: 7, name: "Latecomer" }]), []);
});

test("new matches are never planned into slots that are already finished", () => {
  const before = playFirstSlots(planSchedule(teams(6), settings()), 4);
  const after = planSchedule([...teams(6), { id: 7, name: "Latecomer" }], settings(), before);
  const newcomer = after.filter((match) => match.homeId === 7 || match.awayId === 7);
  assert.ok(newcomer.length === 6);
  for (const match of newcomer) assert.ok(match.slot > 4, `slot ${match.slot} is in the past`);
});

test("removing a team keeps everyone else's results and drops the empty slots", () => {
  const before = playFirstSlots(planSchedule(teams(6), settings()), 3);
  const survivors = teams(6).filter((team) => team.id !== 2);
  const after = planSchedule(survivors, settings(), before);

  assert.equal(after.length, 10);
  assert.equal(after.some((match) => match.homeId === 2 || match.awayId === 2), false);
  for (const old of before.filter((match) => match.played && match.homeId !== 2 && match.awayId !== 2)) {
    assert.equal(find(after, old.homeId, old.awayId).homeScore, old.homeScore);
  }
  assert.deepEqual(slotNumbers(after), Array.from({ length: slotNumbers(after).length }, (_, i) => i + 1));
});

test("a match placed by hand stays put when the schedule is rebuilt", () => {
  const schedule = planSchedule(teams(8), settings());
  const moved = schedule.find((match) => match.slot > 5);
  Object.assign(moved, { slot: 2, table: 2, pinned: true });
  // Whatever was on slot 2 table 2 has to give way.
  const displaced = schedule.find((match) => match !== moved && match.slot === 2 && match.table === 2);
  if (displaced) displaced.slot = 0;

  const rebuilt = planSchedule(teams(8), settings(), schedule);
  const after = find(rebuilt, moved.homeId, moved.awayId);
  assert.equal(after.slot, 2);
  assert.equal(after.table, 2);
  assert.equal(after.pinned, true);
  assert.deepEqual(findConflicts(rebuilt, teams(8)), []);
});

test("reloading keeps the schedule identical, hand edits included", () => {
  const schedule = planSchedule(teams(7), settings());
  const stored = JSON.parse(JSON.stringify(schedule));
  const reloaded = planSchedule(teams(7), settings(), stored, { keepPlacements: true });
  assert.deepEqual(reloaded.map(({ id, slot, table }) => ({ id, slot, table })),
    schedule.map(({ id, slot, table }) => ({ id, slot, table })));
});

test("dropping to fewer tables re-seats the matches that no longer have one", () => {
  const wide = planSchedule(teams(8), { ...DEFAULT_SETTINGS, tableCount: 4 });
  const narrow = planSchedule(teams(8), settings(2), wide);
  assert.ok(narrow.every((match) => match.table <= 2));
  assert.deepEqual(findConflicts(narrow, teams(8)), []);
  assert.equal(narrow.length, 28);
});

test("a corrupted saved position is repaired rather than trusted", () => {
  const schedule = planSchedule(teams(6), settings());
  const broken = schedule.map((match) => ({ ...match, slot: 1, table: 1 }));
  const repaired = planSchedule(teams(6), settings(), broken, { keepPlacements: true });
  assert.deepEqual(findConflicts(repaired, teams(6)), []);
  assert.equal(repaired.length, 15);
});

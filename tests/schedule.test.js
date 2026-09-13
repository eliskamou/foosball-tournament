import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  fairnessReport,
  findConflicts,
  matchesInSlot,
  pairKey,
  planSchedule,
  slotNumbers,
} from "../src/tournament.js";

const teams = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));
const settings = (tableCount) => ({ ...DEFAULT_SETTINGS, tableCount });
const sizes = [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 3], [12, 2], [6, 1], [16, 4]];

test("every pair meets exactly once", () => {
  for (const [count, tableCount] of sizes) {
    const schedule = planSchedule(teams(count), settings(tableCount));
    assert.equal(schedule.length, (count * (count - 1)) / 2, `${count} teams`);
    assert.equal(new Set(schedule.map((match) => pairKey(match.homeId, match.awayId))).size, schedule.length);
  }
});

test("a slot never double-books a team or a table", () => {
  for (const [count, tableCount] of sizes) {
    const schedule = planSchedule(teams(count), settings(tableCount));
    assert.deepEqual(findConflicts(schedule, teams(count)), [], `${count} teams on ${tableCount} tables`);
    for (const slot of slotNumbers(schedule)) {
      assert.ok(matchesInSlot(schedule, slot).length <= tableCount);
    }
  }
});

test("the schedule is as short as the tables allow", () => {
  // With an even number of teams every table can be busy in every slot; with an
  // odd number one team always sits out, which sets a higher floor.
  const shortestPossible = (count, tableCount) => Math.max(
    Math.ceil((count * (count - 1)) / 2 / tableCount),
    Math.ceil((count * (count - 1)) / 2 / Math.min(tableCount, Math.floor(count / 2))),
  );
  for (const [count, tableCount] of sizes) {
    const schedule = planSchedule(teams(count), settings(tableCount));
    assert.equal(slotNumbers(schedule).length, shortestPossible(count, tableCount), `${count} teams on ${tableCount} tables`);
  }
});

test("tables are shared out evenly between the teams", () => {
  // Four teams on two tables is the one arrangement where perfect balance is
  // impossible: the three slots are forced, and one team is stuck on one table.
  for (const [count, tableCount] of sizes.filter(([teamCount]) => teamCount > 4)) {
    for (const row of fairnessReport(teams(count), planSchedule(teams(count), settings(tableCount)), settings(tableCount))) {
      assert.ok(row.tableSpread <= 2, `${row.name} of ${count}: ${row.tables.join("/")}`);
    }
  }
});

test("nobody waits far longer than anyone else", () => {
  for (const [count, tableCount] of sizes) {
    const schedule = planSchedule(teams(count), settings(tableCount));
    const report = fairnessReport(teams(count), schedule, settings(tableCount));
    const slots = slotNumbers(schedule).length;
    // A team's matches are spread over `slots`, so an even share of the waiting
    // is about `slots / count` slots each. One slot of slack allows for the
    // rounding when the numbers do not divide.
    const fairWait = Math.ceil(slots / count) + 1;
    for (const row of report) {
      assert.ok(row.longestWait <= fairWait, `${row.name} of ${count} waited ${row.longestWait}, fair is ${fairWait}`);
    }
  }
});

test("fewer than two teams means no matches", () => {
  assert.deepEqual(planSchedule([], settings(2)), []);
  assert.deepEqual(planSchedule(teams(1), settings(2)), []);
});

test("duplicate team ids are refused", () => {
  assert.throws(() => planSchedule([{ id: 1, name: "A" }, { id: 1, name: "B" }], settings(2)), /unique/i);
});

test("the same teams always produce the same schedule", () => {
  const first = planSchedule(teams(9), settings(2));
  const second = planSchedule(teams(9), settings(2));
  assert.deepEqual(first, second);
});

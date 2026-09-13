import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  computeStandings,
  fairnessReport,
  findConflicts,
  isComplete,
  planSchedule,
} from "../src/tournament.js";

const teams = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Bravo" },
  { id: 3, name: "Charlie" },
];
const played = (homeId, awayId, homeScore, awayScore) => ({
  id: homeId * 10 + awayId, homeId, awayId, slot: 1, table: 1, homeScore, awayScore, played: true, playedAt: null, pinned: false,
});

test("points follow the configured win and draw values", () => {
  const matches = [played(1, 2, 3, 0), played(1, 3, 1, 1)];
  const rows = computeStandings(teams, matches, { ...DEFAULT_SETTINGS, winPoints: 5, drawPoints: 2 });
  const alpha = rows.find((row) => row.name === "Alpha");
  assert.equal(alpha.points, 7);
  assert.equal(alpha.wins, 1);
  assert.equal(alpha.draws, 1);
  assert.equal(alpha.goalDifference, 3);
});

test("unplayed matches count for nothing", () => {
  const rows = computeStandings(teams, [{ ...played(1, 2, 9, 0), played: false }], DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((row) => row.played), [0, 0, 0]);
});

test("the chosen tie-break decides the order", () => {
  // Alpha and Bravo finish level on points and wins: Alpha has the better goal
  // difference (+2 against +1), Bravo scored more goals (4 against 2).
  const matches = [played(1, 3, 2, 0), played(2, 3, 4, 3)];
  const byDifference = computeStandings(teams, matches, { ...DEFAULT_SETTINGS, tieBreak: "goalDifference" });
  assert.deepEqual(byDifference.slice(0, 2).map((row) => row.name), ["Alpha", "Bravo"]);

  const byGoals = computeStandings(teams, matches, { ...DEFAULT_SETTINGS, tieBreak: "goalsFor" });
  assert.deepEqual(byGoals.slice(0, 2).map((row) => row.name), ["Bravo", "Alpha"]);
});

test("teams level on everything are listed alphabetically", () => {
  const rows = computeStandings(teams, [], DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((row) => row.name), ["Alpha", "Bravo", "Charlie"]);
});

test("the fairness report describes each team's split", () => {
  const squad = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));
  const schedule = planSchedule(squad, { ...DEFAULT_SETTINGS, tableCount: 2 });
  const report = fairnessReport(squad, schedule, { ...DEFAULT_SETTINGS, tableCount: 2 });

  assert.equal(report.length, 6);
  for (const row of report) {
    assert.equal(row.matches, 5);
    assert.equal(row.tables.reduce((sum, count) => sum + count, 0), 5);
    assert.equal(row.remaining, 5);
    assert.equal(typeof row.nextSlot, "number");
  }
});

test("a hand-made clash is reported rather than hidden", () => {
  const clashing = [played(1, 2, 0, 0), { ...played(1, 3, 0, 0), table: 2 }];
  const conflicts = findConflicts(clashing, teams);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /Alpha plays twice/);

  const sameTable = [played(1, 2, 0, 0), played(3, 1, 0, 0)];
  assert.ok(findConflicts(sameTable, teams).some((conflict) => /table 1/.test(conflict.message)));
});

test("a tournament is complete only once every match has a score", () => {
  assert.equal(isComplete([]), false);
  assert.equal(isComplete([played(1, 2, 1, 0)]), true);
  assert.equal(isComplete([played(1, 2, 1, 0), { ...played(1, 3, 0, 0), played: false }]), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, planSchedule } from "../src/tournament.js";
import {
  STORAGE_KEY,
  createEmptyState,
  exportFileName,
  loadState,
  normaliseName,
  normaliseState,
  saveState,
} from "../src/storage.js";

const teams = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));

/** The two methods `storage.js` uses, backed by a plain object. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

test("junk is refused with a readable message", () => {
  assert.throws(() => normaliseState(null), /JSON object/);
  assert.throws(() => normaliseState({}), /list of teams/);
  assert.throws(() => normaliseState({ teams: "nope" }), /list of teams/);
});

test("settings are clamped to what the app can actually draw", () => {
  const state = normaliseState({
    teams: teams(2),
    matches: [],
    settings: { tableCount: 99, winPoints: -4, drawPoints: 1e9, tieBreak: "vibes", startTime: "99:99", matchMinutes: 0, title: "  " },
  });
  assert.equal(state.settings.tableCount, 8);
  assert.equal(state.settings.winPoints, 0);
  assert.equal(state.settings.drawPoints, 20);
  assert.equal(state.settings.tieBreak, DEFAULT_SETTINGS.tieBreak);
  assert.equal(state.settings.startTime, DEFAULT_SETTINGS.startTime);
  assert.equal(state.settings.matchMinutes, 1);
  assert.equal(state.settings.title, DEFAULT_SETTINGS.title);
});

test("broken team entries are dropped instead of breaking the app", () => {
  const state = normaliseState({
    teams: [
      { id: 1, name: "Real" },
      { id: 1, name: "Duplicate id" },
      { id: 2, name: "  Real  " },
      { id: 3, name: "" },
      { id: "x", name: "Bad id" },
      null,
      { id: 4, name: "Also real" },
    ],
    matches: [],
  });
  assert.deepEqual(state.teams.map((team) => team.name), ["Real", "Also real"]);
});

test("loading a saved tournament reproduces the schedule exactly", () => {
  const saved = normaliseState({ teams: teams(7), matches: [], settings: { tableCount: 2 } });
  // Stand in for the organiser swapping two tables by hand before saving.
  const moved = saved.matches.find((match) => saved.matches.some((other) => other !== match && other.slot === match.slot));
  const partner = saved.matches.find((other) => other !== moved && other.slot === moved.slot);
  [moved.table, partner.table] = [partner.table, moved.table];
  moved.pinned = true;
  partner.pinned = true;

  const storage = fakeStorage();
  assert.equal(saveState(saved, storage), true);
  const { state, restored } = loadState(storage);

  const positions = (matches) => Object.fromEntries(matches.map((match) => [match.id, `${match.slot}/${match.table}/${match.pinned}`]));
  assert.equal(restored, true);
  assert.deepEqual(positions(state.matches), positions(saved.matches));
  assert.deepEqual(state.teams, saved.teams);
});

test("a version 2 file with per-round slots is migrated to running slot numbers", () => {
  const legacy = {
    teams: teams(4),
    settings: { tableCount: 2 },
    matches: [
      { id: 1, homeId: 1, awayId: 4, round: 1, slot: 1, table: 1, homeScore: 3, awayScore: 1, played: true },
      { id: 2, homeId: 2, awayId: 3, round: 1, slot: 1, table: 2, homeScore: 0, awayScore: 2, played: true },
      { id: 3, homeId: 1, awayId: 3, round: 2, slot: 1, table: 1, homeScore: null, awayScore: null, played: false },
      { id: 4, homeId: 4, awayId: 2, round: 2, slot: 1, table: 2, homeScore: null, awayScore: null, played: false },
      { id: 5, homeId: 1, awayId: 2, round: 3, slot: 1, table: 1, homeScore: null, awayScore: null, played: false },
      { id: 6, homeId: 3, awayId: 4, round: 3, slot: 1, table: 2, homeScore: null, awayScore: null, played: false },
    ],
  };
  const state = normaliseState(legacy);
  assert.equal(state.version, 3);
  assert.deepEqual([...new Set(state.matches.map((match) => match.slot))].sort(), [1, 2, 3]);

  const first = state.matches.find((match) => match.homeId === 1 && match.awayId === 4);
  assert.equal(first.slot, 1);
  assert.equal(first.homeScore, 3);
  assert.equal(first.played, true);
});

test("nothing stored means a fresh tournament rather than an error", () => {
  const { state, restored } = loadState(fakeStorage());
  assert.equal(restored, false);
  assert.deepEqual(state, createEmptyState());
});

test("unreadable stored data falls back to a fresh tournament", () => {
  const { state, restored, error } = loadState(fakeStorage({ [STORAGE_KEY]: "{not json" }));
  assert.equal(restored, false);
  assert.ok(error instanceof Error);
  assert.deepEqual(state.teams, []);
});

test("a storage that refuses to write is reported, not thrown", () => {
  const readOnly = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  assert.equal(saveState(createEmptyState(), readOnly), false);
});

test("undo entries pointing at matches that no longer exist are dropped", () => {
  const state = normaliseState({
    teams: teams(3),
    matches: [],
    settings: {},
    history: [{ matchId: 1, homeScore: 1, awayScore: 0, played: true }, { matchId: 9999, homeScore: 0, awayScore: 0, played: true }],
  });
  assert.deepEqual(state.history.map((entry) => entry.matchId), [1]);
});

test("names are tidied and file names are safe", () => {
  assert.equal(normaliseName("  The   Runners  "), "The Runners");
  assert.equal(normaliseName("", "fallback"), "fallback");
  assert.equal(normaliseName("x".repeat(200)).length, 40);

  const state = { ...createEmptyState(), settings: { ...DEFAULT_SETTINGS, title: "Friday Night / Cup!" } };
  assert.equal(exportFileName(state, new Date("2026-03-04T10:00:00Z")), "friday-night-cup-2026-03-04.json");
});

test("matches for teams that are no longer in the file are discarded", () => {
  const schedule = planSchedule(teams(4), { ...DEFAULT_SETTINGS, tableCount: 2 });
  const state = normaliseState({ teams: teams(3), matches: schedule, settings: { tableCount: 2 } });
  assert.equal(state.matches.length, 3);
  assert.equal(state.matches.some((match) => match.homeId === 4 || match.awayId === 4), false);
});

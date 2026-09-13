/**
 * Persistence: local autosave, and the JSON file used to move a tournament
 * between devices or keep a backup.
 *
 * Every path in and out of the app goes through `normaliseState`, so a hand-edited
 * or half-corrupted file can never put the UI into a state it cannot render.
 */

import {
  DEFAULT_SETTINGS,
  MAX_NAME_LENGTH,
  MAX_TABLES,
  MAX_TEAMS,
  MAX_TITLE_LENGTH,
  TIE_BREAKS,
  clamp,
  planSchedule,
} from "./tournament.js";
import { parseClock } from "./time.js";

export const STORAGE_KEY = "foosballTournament.v3";
const LEGACY_KEYS = ["foosballTournament.v2", "foosballState"];
const STATE_VERSION = 3;
export const MAX_UNDO_STEPS = 40;

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    teams: [],
    matches: [],
    settings: { ...DEFAULT_SETTINGS },
    history: [],
  };
}

function tidy(value, limit, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  return text || fallback;
}

export function normaliseName(value, fallback = "") {
  return tidy(value, MAX_NAME_LENGTH, fallback);
}

export function normaliseTitle(value, fallback = DEFAULT_SETTINGS.title) {
  return tidy(value, MAX_TITLE_LENGTH, fallback);
}

function normaliseSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback);
  return {
    title: normaliseTitle(settings.title),
    tableCount: clamp(number(settings.tableCount, DEFAULT_SETTINGS.tableCount), 1, MAX_TABLES),
    winPoints: clamp(number(settings.winPoints, DEFAULT_SETTINGS.winPoints), 0, 20),
    drawPoints: clamp(number(settings.drawPoints, DEFAULT_SETTINGS.drawPoints), 0, 20),
    tieBreak: Object.hasOwn(TIE_BREAKS, settings.tieBreak) ? settings.tieBreak : DEFAULT_SETTINGS.tieBreak,
    startTime: parseClock(settings.startTime) === null ? DEFAULT_SETTINGS.startTime : String(settings.startTime).replace(".", ":"),
    matchMinutes: clamp(number(settings.matchMinutes, DEFAULT_SETTINGS.matchMinutes), 1, 240),
    breakMinutes: clamp(number(settings.breakMinutes, DEFAULT_SETTINGS.breakMinutes), 0, 120),
  };
}

function normaliseTeams(raw) {
  if (!Array.isArray(raw)) throw new Error("The file does not contain a list of teams.");
  const seenIds = new Set();
  const seenNames = new Set();
  const teams = [];

  for (const entry of raw.slice(0, MAX_TEAMS)) {
    if (!entry || typeof entry !== "object") continue;
    const id = Number(entry.id);
    if (!Number.isInteger(id) || id < 1 || seenIds.has(id)) continue;
    const name = normaliseName(entry.name);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seenNames.has(key)) continue;
    seenIds.add(id);
    seenNames.add(key);
    teams.push({ id, name });
  }
  return teams;
}

/**
 * Version 2 numbered time slots inside each round. Flatten those to the single
 * running slot number used since version 3.
 */
function migrateMatches(raw) {
  if (!Array.isArray(raw)) return [];
  if (!raw.some((match) => match && Object.hasOwn(match, "round"))) return raw;

  const order = [...new Set(raw.map((match) => `${match?.round ?? 1}:${match?.slot ?? 1}`))]
    .sort((a, b) => {
      const [roundA, slotA] = a.split(":").map(Number);
      const [roundB, slotB] = b.split(":").map(Number);
      return roundA - roundB || slotA - slotB;
    });
  const slotByKey = new Map(order.map((key, index) => [key, index + 1]));
  return raw.map((match) => ({ ...match, slot: slotByKey.get(`${match?.round ?? 1}:${match?.slot ?? 1}`) ?? 0 }));
}

function normaliseHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && Number.isInteger(entry.matchId))
    .slice(-MAX_UNDO_STEPS);
}

/**
 * Turn arbitrary parsed JSON into a state the app can render.
 *
 * `keepPlacements` is on for loading: reopening a saved tournament must show the
 * exact schedule it showed before, including every table the organiser changed
 * by hand. It is off when the schedule is deliberately being rebuilt.
 */
export function normaliseState(raw, { keepPlacements = true } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("The file must contain a JSON object.");
  const teams = normaliseTeams(raw.teams);
  const settings = normaliseSettings(raw.settings);
  const matches = planSchedule(teams, settings, migrateMatches(raw.matches), { keepPlacements });
  const liveIds = new Set(matches.map((match) => match.id));

  return {
    version: STATE_VERSION,
    teams,
    settings,
    matches,
    history: normaliseHistory(raw.history).filter((entry) => liveIds.has(entry.matchId)),
  };
}

/* ------------------------------------------------------------------ *
 * Browser storage
 * ------------------------------------------------------------------ */

function readRaw(storage) {
  for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) {
    const raw = storage.getItem(key);
    if (raw) return raw;
  }
  return null;
}

export function loadState(storage = globalThis.localStorage) {
  try {
    const raw = readRaw(storage);
    if (!raw) return { state: createEmptyState(), restored: false };
    return { state: normaliseState(JSON.parse(raw)), restored: true };
  } catch (error) {
    return { state: createEmptyState(), restored: false, error };
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    // Private browsing and a full quota both land here; the app keeps working,
    // it just cannot promise the tournament survives a reload.
    return false;
  }
}

export function clearStoredState(storage = globalThis.localStorage) {
  for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) storage.removeItem(key);
}

export function exportFileName(state, now = new Date()) {
  const slug = state.settings.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "foosball"}-${now.toISOString().slice(0, 10)}.json`;
}

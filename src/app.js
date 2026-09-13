/**
 * Application wiring: owns the state, applies the actions, saves after each one.
 *
 * The rules live in `tournament.js` and `time.js`; the drawing lives in
 * `views.js`. This file is the part that decides what a click means.
 */

import {
  MAX_TABLES,
  MAX_TEAMS,
  clamp,
  compactSlots,
  matchesInSlot,
  planSchedule,
  slotNumbers,
} from "./tournament.js";
import { parseClock, scheduleStatus } from "./time.js";
import {
  MAX_UNDO_STEPS,
  clearStoredState,
  createEmptyState,
  exportFileName,
  loadState,
  normaliseName,
  normaliseState,
  normaliseTitle,
  saveState,
} from "./storage.js";
import {
  renderFairness,
  renderHeader,
  renderSchedule,
  renderSettings,
  renderStandings,
  renderTeams,
} from "./views.js";

const dom = new Proxy({}, {
  get: (cache, id) => (cache[id] ??= document.getElementById(id)),
});

let state = createEmptyState();
let storageWorks = true;
let toastTimer;

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function notify(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3200);
}

function persist() {
  storageWorks = saveState(state);
  dom.saveHint.textContent = storageWorks
    ? "Saved in this browser as you go. Save to a file to keep a copy or move to another device."
    : "This browser will not let the page store data, so nothing is kept on reload — save to a file instead.";
}

function render(options = {}) {
  const status = scheduleStatus(state.matches, state.settings);
  renderHeader(dom, state, status);
  renderSettings(dom, state);
  renderTeams(dom, state, actions);
  renderSchedule(dom, state, status, actions, options);
  renderStandings(dom, state);
  renderFairness(dom, state);
  dom.undoButton.disabled = state.history.length === 0;
  dom.reoptimiseButton.disabled = state.matches.every((match) => match.played);
}

function commit(options = {}) {
  render(options);
  persist();
}

/** Rebuild the schedule, keeping played results and hand-placed matches. */
function replan() {
  state.matches = planSchedule(state.teams, state.settings, state.matches, { keepPlacements: false });
  const liveIds = new Set(state.matches.map((match) => match.id));
  state.history = state.history.filter((entry) => liveIds.has(entry.matchId));
}

const findMatch = (matchId) => state.matches.find((match) => match.id === matchId);

/* ------------------------------------------------------------------ *
 * Teams
 * ------------------------------------------------------------------ */

function addTeams(text) {
  const wanted = String(text).split(/[\n,;]+/).map((name) => normaliseName(name)).filter(Boolean);
  if (wanted.length === 0) return;

  const taken = new Set(state.teams.map((team) => team.name.toLocaleLowerCase()));
  let nextId = Math.max(0, ...state.teams.map((team) => team.id)) + 1;
  const added = [];
  const skipped = [];

  for (const name of wanted) {
    if (state.teams.length >= MAX_TEAMS) { skipped.push(`${name} (limit is ${MAX_TEAMS} teams)`); continue; }
    if (taken.has(name.toLocaleLowerCase())) { skipped.push(`${name} (already added)`); continue; }
    taken.add(name.toLocaleLowerCase());
    state.teams.push({ id: nextId++, name });
    added.push(name);
  }

  if (added.length) replan();
  commit();
  if (skipped.length) notify(`Skipped ${skipped.join(", ")}.`);
  else if (added.length > 1) notify(`Added ${added.length} teams.`);
}

function renameTeam(teamId, value) {
  const team = state.teams.find((candidate) => candidate.id === teamId);
  if (!team) return;
  const name = normaliseName(value);
  if (!name) { render(); return notify("A team needs a name."); }
  if (state.teams.some((other) => other.id !== teamId && other.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    render();
    return notify(`There is already a team called ${name}.`);
  }
  team.name = name;
  commit();
}

function removeTeam(teamId) {
  const team = state.teams.find((candidate) => candidate.id === teamId);
  if (!team) return;
  const lost = state.matches.filter((match) => match.played && (match.homeId === teamId || match.awayId === teamId)).length;
  const warning = lost ? ` ${lost === 1 ? "Its result" : `Its ${lost} results`} will be deleted.` : "";
  if (!window.confirm(`Remove ${team.name}?${warning}`)) return;

  state.teams = state.teams.filter((candidate) => candidate.id !== teamId);
  replan();
  commit();
  notify(`${team.name} removed. The remaining matches were re-balanced.`);
}

/* ------------------------------------------------------------------ *
 * Scores
 * ------------------------------------------------------------------ */

function parseScore(value) {
  const text = String(value).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  return Number(text);
}

function remember(match) {
  state.history.push({
    matchId: match.id,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    played: match.played,
    playedAt: match.playedAt,
  });
  state.history = state.history.slice(-MAX_UNDO_STEPS);
}

function saveScore(matchId, homeValue, awayValue) {
  const match = findMatch(matchId);
  if (!match) return;
  const homeScore = parseScore(homeValue);
  const awayScore = parseScore(awayValue);
  if (homeScore === null || awayScore === null) return notify("Both scores need to be whole numbers.");

  remember(match);
  Object.assign(match, { homeScore, awayScore, played: true, playedAt: Date.now() });
  commit({ discardDraftsFor: matchId });
  focusNextPending(matchId);
}

function clearScore(matchId) {
  const match = findMatch(matchId);
  if (!match?.played) return;
  remember(match);
  Object.assign(match, { homeScore: null, awayScore: null, played: false, playedAt: null });
  commit({ discardDraftsFor: matchId });
}

function undo() {
  const entry = state.history.pop();
  if (!entry) return;
  const match = findMatch(entry.matchId);
  if (match) {
    const { matchId, ...values } = entry;
    Object.assign(match, values);
  }
  commit({ discardDraftsFor: entry.matchId });
  notify("Score change undone.");
}

/** After saving, put the cursor on the next match still waiting for a result. */
function focusNextPending(afterMatchId) {
  const order = state.matches.map((match) => match.id);
  const start = order.indexOf(afterMatchId) + 1;
  const next = [...state.matches.slice(start), ...state.matches.slice(0, start)].find((match) => !match.played);
  const field = next && dom.slotList.querySelector(`input.score[data-match-id="${next.id}"][data-side="home"]`);
  field?.focus();
}

/* ------------------------------------------------------------------ *
 * Moving matches around
 * ------------------------------------------------------------------ */

const teamsIn = (matches, except) => new Set(matches
  .filter((match) => match !== except)
  .flatMap((match) => [match.homeId, match.awayId]));

function setTable(matchId, table) {
  const match = findMatch(matchId);
  if (!match || match.table === table) return;

  // Two matches in the same slot can always trade tables: the teams do not change.
  const occupant = state.matches.find((other) => other !== match && other.slot === match.slot && other.table === table);
  if (occupant) Object.assign(occupant, { table: match.table, pinned: true });
  Object.assign(match, { table, pinned: true });

  sortSchedule();
  commit();
  notify(occupant
    ? `Swapped tables with ${nameOf(occupant.homeId)} v ${nameOf(occupant.awayId)}.`
    : `Moved to table ${table}.`);
}

function shiftMatch(matchId, direction) {
  const match = findMatch(matchId);
  if (!match) return;
  const slots = slotNumbers(state.matches);
  const lastSlot = slots[slots.length - 1];
  const target = match.slot + direction;

  if (target < 1) return notify("This match is already in the first slot.");
  if (direction > 0 && match.slot === lastSlot && matchesInSlot(state.matches, match.slot).length === 1) {
    return notify("This match is already last.");
  }

  const inTarget = matchesInSlot(state.matches, target);
  const busyThere = teamsIn(inTarget);
  const freeTable = [...Array(state.settings.tableCount).keys()]
    .map((index) => index + 1)
    .find((table) => !inTarget.some((other) => other.table === table));

  if (freeTable && !busyThere.has(match.homeId) && !busyThere.has(match.awayId)) {
    Object.assign(match, { slot: target, table: freeTable, pinned: true });
  } else {
    const busyHere = teamsIn(matchesInSlot(state.matches, match.slot), match);
    const partner = inTarget.find((other) => {
      const rest = teamsIn(inTarget, other);
      return !rest.has(match.homeId) && !rest.has(match.awayId)
        && !busyHere.has(other.homeId) && !busyHere.has(other.awayId);
    });
    if (!partner) {
      return notify(`Cannot move there: one of these teams already plays in slot ${target}.`);
    }
    const from = { slot: match.slot, table: match.table };
    Object.assign(match, { slot: partner.slot, table: partner.table, pinned: true });
    Object.assign(partner, { ...from, pinned: true });
  }

  compactSlots(state.matches);
  sortSchedule();
  commit();
}

function unpin(matchId) {
  const match = findMatch(matchId);
  if (!match) return;
  match.pinned = false;
  commit();
  notify("The planner may move this match again. Use Re-balance remaining to apply it.");
}

function reoptimise() {
  for (const match of state.matches) if (!match.played) match.pinned = false;
  replan();
  commit();
  notify("Remaining matches re-balanced across the tables and time slots.");
}

const nameOf = (teamId) => state.teams.find((team) => team.id === teamId)?.name ?? "a team";
const sortSchedule = () => state.matches.sort((a, b) => a.slot - b.slot || a.table - b.table);

/* ------------------------------------------------------------------ *
 * Settings and data
 * ------------------------------------------------------------------ */

function applySettings(event) {
  event.preventDefault();
  const whole = (input, fallback, min, max) => clamp(Math.trunc(Number(input.value)) || fallback, min, max);
  const tableCount = whole(dom.tableCount, 1, 1, MAX_TABLES);
  const changesLayout = tableCount !== state.settings.tableCount;

  state.settings = {
    ...state.settings,
    title: normaliseTitle(dom.tournamentTitle.value, state.settings.title),
    tableCount,
    startTime: parseClock(dom.startTime.value) === null ? state.settings.startTime : dom.startTime.value,
    matchMinutes: whole(dom.matchMinutes, 10, 1, 240),
    breakMinutes: clamp(Math.trunc(Number(dom.breakMinutes.value)) || 0, 0, 120),
    winPoints: clamp(Math.trunc(Number(dom.winPoints.value)) || 0, 0, 20),
    drawPoints: clamp(Math.trunc(Number(dom.drawPoints.value)) || 0, 0, 20),
    tieBreak: dom.tieBreak.value,
  };

  if (changesLayout) replan();
  commit();
  notify(changesLayout ? `Rebuilt the schedule for ${tableCount} tables.` : "Settings applied.");
}

function exportFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: exportFileName(state) });
  link.click();
  URL.revokeObjectURL(url);
  notify("Tournament saved to a file.");
}

async function importFile(file) {
  try {
    state = normaliseState(JSON.parse(await file.text()));
    commit();
    notify(`Loaded ${state.settings.title}.`);
  } catch (error) {
    notify(`That file could not be loaded: ${error.message}`);
  }
}

function reset() {
  if (!window.confirm("Delete all teams, matches and results?")) return;
  state = createEmptyState();
  clearStoredState();
  commit();
  notify("Everything cleared.");
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const actions = { renameTeam, removeTeam, saveScore, clearScore, setTable, shiftMatch, unpin };

dom.teamForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addTeams(dom.teamName.value);
  dom.teamName.value = "";
  dom.teamName.focus();
});
dom.settingsForm.addEventListener("submit", applySettings);
dom.undoButton.addEventListener("click", undo);
dom.reoptimiseButton.addEventListener("click", reoptimise);
dom.exportButton.addEventListener("click", exportFile);
dom.importButton.addEventListener("click", () => dom.fileInput.click());
dom.fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importFile(file);
  event.target.value = "";
});
dom.printButton.addEventListener("click", () => window.print());
dom.resetButton.addEventListener("click", reset);

const restored = loadState();
state = restored.state;
if (restored.error) notify("The saved tournament could not be read, so a fresh one was opened.");
commit();

// Keep "next up" and the running time honest without redrawing the schedule,
// which would interrupt anyone mid-way through typing a score.
setInterval(() => {
  const status = scheduleStatus(state.matches, state.settings);
  renderHeader(dom, state, status);
  for (const slot of dom.slotList.querySelectorAll(".slot")) {
    if (slot.dataset.state === "done") continue;
    slot.dataset.state = Number(slot.dataset.slot) === status.currentSlot ? "current" : "upcoming";
  }
}, 20000);

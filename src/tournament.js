/**
 * Pure tournament domain logic: fixtures, scheduling, standings and fairness.
 *
 * Nothing in this module touches the DOM, so every rule it encodes is covered
 * by the test suite. The UI layer only reads from and writes to these shapes.
 *
 * A match looks like this:
 *   { id, homeId, awayId, slot, table, homeScore, awayScore, played, playedAt, pinned }
 *
 * `slot` is a global time slot (1, 2, 3 …). Every match sharing a slot is played
 * at the same time, one per table, so a slot is both "who plays now" and "when".
 * `pinned` marks a match the organiser has moved by hand; the planner never
 * relocates a pinned or an already played match.
 */

export const MAX_TABLES = 8;
export const MAX_TEAMS = 24;
export const MAX_NAME_LENGTH = 40;
export const MAX_TITLE_LENGTH = 60;

export const TIE_BREAKS = Object.freeze({
  goalDifference: "Goal difference",
  wins: "Wins",
  goalsFor: "Goals scored",
});

export const DEFAULT_SETTINGS = Object.freeze({
  title: "Foosball Tournament",
  tableCount: 2,
  winPoints: 3,
  drawPoints: 1,
  tieBreak: "goalDifference",
  startTime: "18:00",
  matchMinutes: 10,
  breakMinutes: 2,
});

/**
 * How hard a long wait is punished. Squaring already spreads a single team's
 * matches evenly, but the search adds up the cost of everyone it touches, and
 * with squares it will happily strand one team behind a long gap to shave a
 * little off three others. The fourth power makes the worst gap dominate, so
 * nobody gets sacrificed for the average.
 */
const REST_PENALTY_POWER = 4;

/**
 * How much an uneven table split counts against an even one. Rest costs grow
 * with the fourth power of a gap and so run into the thousands; a table that is
 * one match out of balance is worth a fraction of one. This brings the two onto
 * the same scale.
 */
const TABLE_BALANCE_WEIGHT = 2500;
/** Hill-climbing passes; the search exits as soon as a pass finds no gain. */
const MAX_REFINEMENT_PASSES = 8;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function pairKey(first, second) {
  return [Number(first), Number(second)].sort((a, b) => a - b).join(":");
}

/**
 * Round-robin fixtures via the circle method: every pair meets exactly once and
 * consecutive fixtures in the returned order never share a team, which gives the
 * planner a naturally spread starting point.
 */
function buildFixtures(teamIds) {
  const rotation = [...teamIds];
  if (rotation.length % 2 !== 0) rotation.push(null);
  const half = rotation.length / 2;
  const fixtures = [];

  for (let round = 0; round < rotation.length - 1; round += 1) {
    for (let index = 0; index < half; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      if (first === null || second === null) continue;
      // Alternate the home side each round so nobody is always listed first.
      const [homeId, awayId] = round % 2 === 0 ? [first, second] : [second, first];
      fixtures.push({ homeId, awayId });
    }
    rotation.splice(1, 0, rotation.pop());
  }
  return fixtures;
}

function createMatch(homeId, awayId) {
  return {
    id: 0,
    homeId,
    awayId,
    slot: 0,
    table: 0,
    homeScore: null,
    awayScore: null,
    played: false,
    playedAt: null,
    pinned: false,
  };
}

function isScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 999;
}

/* ------------------------------------------------------------------ *
 * Occupancy: who and what is busy in each slot
 * ------------------------------------------------------------------ */

function emptySlot() {
  return { tables: new Map(), teams: new Map() };
}

function occupancyOf(matches) {
  const slots = new Map();
  for (const match of matches) {
    if (!match.slot) continue;
    if (!slots.has(match.slot)) slots.set(match.slot, emptySlot());
    const slot = slots.get(match.slot);
    slot.tables.set(match.table, match);
    slot.teams.set(match.homeId, match);
    slot.teams.set(match.awayId, match);
  }
  return slots;
}

function detach(match, occupancy) {
  const slot = occupancy.get(match.slot);
  if (!slot) return;
  slot.tables.delete(match.table);
  slot.teams.delete(match.homeId);
  slot.teams.delete(match.awayId);
  if (slot.tables.size === 0) occupancy.delete(match.slot);
}

function attach(match, slotNumber, tableNumber, occupancy) {
  match.slot = slotNumber;
  match.table = tableNumber;
  if (!occupancy.has(slotNumber)) occupancy.set(slotNumber, emptySlot());
  const slot = occupancy.get(slotNumber);
  slot.tables.set(tableNumber, match);
  slot.teams.set(match.homeId, match);
  slot.teams.set(match.awayId, match);
}

function firstFreeTable(slot, tableCount) {
  for (let table = 1; table <= tableCount; table += 1) {
    if (!slot || !slot.tables.has(table)) return table;
  }
  return 0;
}

function slotAccepts(slot, match, tableCount) {
  if (!slot) return true;
  if (slot.tables.size >= tableCount) return false;
  return !slot.teams.has(match.homeId) && !slot.teams.has(match.awayId);
}

/** Earliest-fit placement, which keeps the schedule as short as the tables allow. */
function place(match, occupancy, tableCount, earliestSlot) {
  for (let slotNumber = earliestSlot; ; slotNumber += 1) {
    const slot = occupancy.get(slotNumber);
    if (!slotAccepts(slot, match, tableCount)) continue;
    attach(match, slotNumber, firstFreeTable(slot, tableCount), occupancy);
    return;
  }
}

/* ------------------------------------------------------------------ *
 * Fairness cost: even rest between matches, even use of the tables
 * ------------------------------------------------------------------ */

/**
 * The gaps between a team's matches, raised to a power and added up. The wait
 * before their first match and after their last one count too, so the measure
 * covers the whole evening. Since the gaps always sum to the same total, the
 * result is smallest when they are equal — which is "never idle for long, and
 * never three matches back to back" written as a number.
 */
function restCost(slots, totalSlots) {
  const ordered = [...slots].sort((a, b) => a - b);
  let cost = 0;
  let previous = 0;
  for (const slot of ordered) {
    cost += (slot - previous) ** REST_PENALTY_POWER;
    previous = slot;
  }
  return cost + (totalSlots + 1 - previous) ** REST_PENALTY_POWER;
}

/** Spread of one team's matches across the tables, smallest when even. */
function tableCost(counts) {
  const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
  return counts.reduce((sum, count) => sum + (count - average) ** 2, 0);
}

function teamCost(teamMatches, tableCount, totalSlots) {
  const slots = [];
  const counts = Array(tableCount).fill(0);
  for (const match of teamMatches) {
    slots.push(match.slot);
    counts[match.table - 1] += 1;
  }
  return restCost(slots, totalSlots) + TABLE_BALANCE_WEIGHT * tableCost(counts);
}

function indexByTeam(matches, teamIds) {
  const index = new Map(teamIds.map((teamId) => [teamId, []]));
  for (const match of matches) {
    index.get(match.homeId)?.push(match);
    index.get(match.awayId)?.push(match);
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Refinement: hill-climbing over the movable matches
 * ------------------------------------------------------------------ */

function canSwap(first, second, occupancy) {
  if (first.slot === second.slot) return true;
  const target = occupancy.get(second.slot);
  const source = occupancy.get(first.slot);
  for (const teamId of [first.homeId, first.awayId]) {
    const holder = target?.teams.get(teamId);
    if (holder && holder !== second) return false;
  }
  for (const teamId of [second.homeId, second.awayId]) {
    const holder = source?.teams.get(teamId);
    if (holder && holder !== first) return false;
  }
  return true;
}

function reposition(match, slotNumber, tableNumber, occupancy) {
  detach(match, occupancy);
  attach(match, slotNumber, tableNumber, occupancy);
}

/**
 * Deterministic hill climbing: repeatedly swap two movable matches, or move one
 * onto a free table, whenever it lowers the fairness cost. Deterministic so the
 * same teams always produce the same schedule.
 *
 * `fixed` holds the matches that must not move — played, pinned, or, when a
 * saved tournament is being reopened, every match that already had a place.
 */
function refine(matches, teamIds, tableCount, earliestSlot, fixed) {
  const movable = matches.filter((match) => !fixed.has(match));
  if (movable.length < 2) return;

  const occupancy = occupancyOf(matches);
  const byTeam = indexByTeam(matches, teamIds);
  const totalSlots = Math.max(...matches.map((match) => match.slot));
  const costOf = (teamId) => teamCost(byTeam.get(teamId), tableCount, totalSlots);
  const localCost = (teams) => [...teams].reduce((sum, teamId) => sum + costOf(teamId), 0);

  const tryMove = (apply, revert, teams) => {
    const before = localCost(teams);
    apply();
    if (localCost(teams) < before) return true;
    revert();
    return false;
  };

  for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass += 1) {
    let improved = false;

    for (let i = 0; i < movable.length; i += 1) {
      for (let j = i + 1; j < movable.length; j += 1) {
        const [first, second] = [movable[i], movable[j]];
        if (!canSwap(first, second, occupancy)) continue;
        const teams = new Set([first.homeId, first.awayId, second.homeId, second.awayId]);
        const origin = { slot: first.slot, table: first.table };
        const destination = { slot: second.slot, table: second.table };
        improved = tryMove(
          () => {
            detach(first, occupancy);
            detach(second, occupancy);
            attach(first, destination.slot, destination.table, occupancy);
            attach(second, origin.slot, origin.table, occupancy);
          },
          () => {
            detach(first, occupancy);
            detach(second, occupancy);
            attach(first, origin.slot, origin.table, occupancy);
            attach(second, destination.slot, destination.table, occupancy);
          },
          teams,
        ) || improved;
      }
    }

    // Moving onto an empty table matters when a slot is short of matches, which
    // happens with an odd number of teams or after a team has been removed.
    for (const match of movable) {
      const origin = { slot: match.slot, table: match.table };
      const teams = new Set([match.homeId, match.awayId]);
      for (let slotNumber = earliestSlot; slotNumber <= totalSlots; slotNumber += 1) {
        const slot = occupancy.get(slotNumber);
        if (slotNumber === match.slot && slot?.tables.size === 1) continue;
        if (slotNumber !== match.slot && !slotAccepts(slot, match, tableCount)) continue;
        for (let table = 1; table <= tableCount; table += 1) {
          if (slot?.tables.has(table)) continue;
          if (slotNumber === match.slot && table === match.table) continue;
          improved = tryMove(
            () => reposition(match, slotNumber, table, occupancy),
            () => reposition(match, origin.slot, origin.table, occupancy),
            teams,
          ) || improved;
        }
      }
    }

    if (!improved) break;
  }
}

/** Renumber slots so that removing teams never leaves an empty gap in the day. */
export function compactSlots(matches) {
  const used = [...new Set(matches.map((match) => match.slot))].sort((a, b) => a - b);
  const renumbered = new Map(used.map((slot, index) => [slot, index + 1]));
  for (const match of matches) match.slot = renumbered.get(match.slot);
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

function carryOver(previous) {
  const match = createMatch(previous.homeId, previous.awayId);
  const played = previous.played === true && isScore(previous.homeScore) && isScore(previous.awayScore);
  return {
    ...match,
    id: Number.isInteger(previous.id) && previous.id > 0 ? previous.id : 0,
    homeScore: played ? previous.homeScore : null,
    awayScore: played ? previous.awayScore : null,
    played,
    playedAt: played && Number.isFinite(previous.playedAt) ? previous.playedAt : null,
    pinned: previous.pinned === true,
    slot: Number.isInteger(previous.slot) && previous.slot > 0 ? previous.slot : 0,
    table: Number.isInteger(previous.table) && previous.table > 0 ? previous.table : 0,
  };
}

/**
 * Decide which matches keep the position they already have. Played matches always
 * do — history is never rewritten. Pinned matches do, because the organiser put
 * them there on purpose. On a reload everything valid is kept, so opening the app
 * again never reshuffles a schedule people are already reading off a screen.
 */
function selectFixed(matches, tableCount, keepPlacements) {
  const wanted = matches.filter((match) => {
    if (match.slot < 1 || match.table < 1 || match.table > tableCount) return false;
    return keepPlacements || match.played || match.pinned;
  });
  // Played first, then in schedule order, so a clash is resolved in favour of
  // what already happened rather than what is merely planned.
  wanted.sort((a, b) => Number(b.played) - Number(a.played)
    || a.slot - b.slot || a.table - b.table || a.id - b.id);

  const occupancy = new Map();
  const fixed = new Set();
  for (const match of wanted) {
    if (!occupancy.has(match.slot)) occupancy.set(match.slot, emptySlot());
    const slot = occupancy.get(match.slot);
    if (slot.tables.has(match.table)) continue;
    if (slot.teams.has(match.homeId) || slot.teams.has(match.awayId)) continue;
    slot.tables.set(match.table, match);
    slot.teams.set(match.homeId, match);
    slot.teams.set(match.awayId, match);
    fixed.add(match);
  }
  return fixed;
}

/**
 * How far the tournament has actually got: the last slot such that it and every
 * slot before it are finished. New matches are never planned into that stretch,
 * but a slot that is only half played is still fair game — a free table there is
 * a free table.
 */
function completedPrefix(matches) {
  const finished = new Map();
  for (const match of matches) {
    if (!match.slot) continue;
    finished.set(match.slot, (finished.get(match.slot) ?? true) && match.played);
  }
  let frontier = 0;
  for (const slot of [...finished.keys()].sort((a, b) => a - b)) {
    if (slot !== frontier + 1 || !finished.get(slot)) break;
    frontier = slot;
  }
  return frontier;
}

/**
 * Build the full round-robin for `teams` and lay it out over the tables.
 *
 * Results already recorded for a pairing survive, whichever way round the pair is
 * listed, so teams can be added or removed mid-tournament without losing scores.
 */
export function planSchedule(teams, settings = DEFAULT_SETTINGS, previousMatches = [], { keepPlacements = false } = {}) {
  if (!Array.isArray(teams)) throw new TypeError("Teams must be an array.");
  const tableCount = clamp(Math.trunc(Number(settings.tableCount) || 1), 1, MAX_TABLES);
  const teamIds = teams.map((team) => Number(team.id));
  if (new Set(teamIds).size !== teamIds.length) throw new Error("Team IDs must be unique.");
  if (teamIds.length < 2) return [];

  const known = new Set(teamIds);
  const previousByPair = new Map();
  for (const previous of previousMatches) {
    if (!known.has(previous.homeId) || !known.has(previous.awayId)) continue;
    previousByPair.set(pairKey(previous.homeId, previous.awayId), previous);
  }

  const matches = buildFixtures(teamIds).map((fixture) => {
    const previous = previousByPair.get(pairKey(fixture.homeId, fixture.awayId));
    return previous ? carryOver(previous) : createMatch(fixture.homeId, fixture.awayId);
  });

  let nextId = Math.max(0, ...matches.map((match) => match.id)) + 1;
  for (const match of matches) if (!match.id) match.id = nextId++;

  const fixed = selectFixed(matches, tableCount, keepPlacements);
  const earliestSlot = completedPrefix([...fixed]) + 1;

  const occupancy = occupancyOf([...fixed]);
  for (const match of matches) {
    if (fixed.has(match)) continue;
    // A match that lost its position is no longer where the organiser put it.
    match.pinned = false;
    place(match, occupancy, tableCount, earliestSlot);
  }

  refine(matches, teamIds, tableCount, earliestSlot, fixed);
  compactSlots(matches);
  return matches.sort((a, b) => a.slot - b.slot || a.table - b.table);
}

export function slotNumbers(matches) {
  return [...new Set(matches.map((match) => match.slot))].sort((a, b) => a - b);
}

export function matchesInSlot(matches, slotNumber) {
  return matches.filter((match) => match.slot === slotNumber).sort((a, b) => a.table - b.table);
}

/* ------------------------------------------------------------------ *
 * Standings, fairness and conflicts
 * ------------------------------------------------------------------ */

export function computeStandings(teams, matches, settings = DEFAULT_SETTINGS) {
  const rows = teams.map((team) => ({
    id: team.id,
    name: team.name,
    played: 0,
    points: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const match of matches) {
    if (!match.played) continue;
    const home = byId.get(match.homeId);
    const away = byId.get(match.awayId);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    home.goalsFor += match.homeScore;
    home.goalsAgainst += match.awayScore;
    away.goalsFor += match.awayScore;
    away.goalsAgainst += match.homeScore;
    if (match.homeScore > match.awayScore) {
      home.wins += 1;
      away.losses += 1;
      home.points += settings.winPoints;
    } else if (match.homeScore < match.awayScore) {
      away.wins += 1;
      home.losses += 1;
      away.points += settings.winPoints;
    } else {
      home.draws += 1;
      away.draws += 1;
      home.points += settings.drawPoints;
      away.points += settings.drawPoints;
    }
  }

  for (const row of rows) row.goalDifference = row.goalsFor - row.goalsAgainst;

  const compare = {
    wins: (a, b) => b.wins - a.wins,
    goalDifference: (a, b) => b.goalDifference - a.goalDifference,
    goalsFor: (a, b) => b.goalsFor - a.goalsFor,
  };
  const order = [settings.tieBreak, ...Object.keys(compare).filter((key) => key !== settings.tieBreak)];
  return rows.sort((a, b) => b.points - a.points
    || compare[order[0]](a, b)
    || compare[order[1]](a, b)
    || compare[order[2]](a, b)
    || a.name.localeCompare(b.name));
}

/**
 * Per-team view of the two things the planner optimises, so the organiser can
 * check the split rather than take it on trust.
 */
export function fairnessReport(teams, matches, settings = DEFAULT_SETTINGS) {
  const tableCount = clamp(Math.trunc(Number(settings.tableCount) || 1), 1, MAX_TABLES);
  const totalSlots = matches.length ? Math.max(...matches.map((match) => match.slot)) : 0;

  return teams.map((team) => {
    const own = matches
      .filter((match) => match.homeId === team.id || match.awayId === team.id)
      .sort((a, b) => a.slot - b.slot);
    const tables = Array(tableCount).fill(0);
    for (const match of own) tables[match.table - 1] += 1;

    const waits = own.map((match, index) => match.slot - (index === 0 ? 0 : own[index - 1].slot) - 1);
    const next = own.find((match) => !match.played) ?? null;

    return {
      id: team.id,
      name: team.name,
      matches: own.length,
      tables,
      tableSpread: own.length ? Math.max(...tables) - Math.min(...tables) : 0,
      longestWait: waits.length ? Math.max(...waits) : 0,
      backToBack: waits.filter((wait) => wait === 0).length,
      remaining: own.filter((match) => !match.played).length,
      nextSlot: next?.slot ?? null,
      nextTable: next?.table ?? null,
      lastSlot: own.length ? own[own.length - 1].slot : 0,
      totalSlots,
    };
  });
}

/**
 * Manual edits are allowed to produce an impossible slot — mid-rearrangement it
 * is normal — but the app has to say so out loud rather than quietly accept it.
 */
export function findConflicts(matches, teams) {
  const names = new Map(teams.map((team) => [team.id, team.name]));
  const conflicts = [];

  for (const slotNumber of slotNumbers(matches)) {
    const inSlot = matchesInSlot(matches, slotNumber);
    const tables = new Map();
    const players = new Map();
    for (const match of inSlot) {
      tables.set(match.table, (tables.get(match.table) ?? 0) + 1);
      for (const teamId of [match.homeId, match.awayId]) {
        players.set(teamId, (players.get(teamId) ?? 0) + 1);
      }
    }
    for (const [table, count] of tables) {
      if (count > 1) conflicts.push({ slot: slotNumber, message: `two matches on table ${table}` });
    }
    for (const [teamId, count] of players) {
      if (count > 1) conflicts.push({ slot: slotNumber, message: `${names.get(teamId) ?? "a team"} plays twice` });
    }
  }
  return conflicts;
}

export function isComplete(matches) {
  return matches.length > 0 && matches.every((match) => match.played);
}

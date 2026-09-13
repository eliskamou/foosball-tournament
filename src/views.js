/**
 * Rendering. Every function here builds DOM from the current state and calls
 * back into the action handlers passed by `app.js`; none of them mutate state.
 */

import {
  MAX_TEAMS,
  TIE_BREAKS,
  computeStandings,
  fairnessReport,
  findConflicts,
  isComplete,
  matchesInSlot,
  slotNumbers,
} from "./tournament.js";
import { formatClock, formatDelta, formatTimestamp, slotWindow } from "./time.js";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/* ------------------------------------------------------------------ *
 * Header and live status
 * ------------------------------------------------------------------ */

export function renderHeader(dom, state, status) {
  const { title } = state.settings;
  document.title = title;
  dom.pageTitle.textContent = title;

  if (state.teams.length < 2) {
    dom.pageSubtitle.textContent = "Add at least two teams and the schedule builds itself.";
  } else {
    const slots = slotNumbers(state.matches).length;
    const played = state.matches.filter((match) => match.played).length;
    dom.pageSubtitle.textContent = `${plural(state.teams.length, "team")} · ${plural(state.matches.length, "match")} · ${plural(slots, "time slot")} · ${played} played`;
  }

  dom.statusCard.replaceChildren(...statusContent(state, status));
  dom.statusCard.dataset.state = status.state ?? "empty";
}

function statusContent(state, status) {
  if (status.state === "empty") return [el("p", { class: "status-line", text: "No matches yet." })];

  if (status.state === "finished") {
    const winner = computeStandings(state.teams, state.matches, state.settings)[0];
    return [
      el("p", { class: "status-label", text: "Finished" }),
      el("p", { class: "status-main", text: winner ? `🏆 ${winner.name}` : "All matches played" }),
      el("p", { class: "status-line", text: `Ended ${formatClock(status.projectedEnd)} · planned ${formatClock(status.plannedEnd)}` }),
    ];
  }

  const window = slotWindow(status.currentSlot, state.settings);
  const upNext = matchesInSlot(state.matches, status.currentSlot)
    .map((match) => `T${match.table}`)
    .join(" · ");
  const drift = status.measuredSlot === null
    ? (status.dueInMinutes > 0
      ? `starts in ${plural(Math.round(status.dueInMinutes), "min")}`
      : formatDelta(-status.dueInMinutes))
    : formatDelta(status.delayMinutes);

  return [
    el("p", { class: "status-label", text: status.state === "upcoming" ? "Up first" : "Now playing" }),
    el("p", { class: "status-main", text: `Slot ${status.currentSlot} · ${formatClock(window.start)}` }),
    el("p", { class: "status-line", text: `${drift} · ${upNext || "no tables"}` }),
    el("p", { class: "status-line", text: `Finish about ${formatClock(status.projectedEnd)}` }),
  ];
}

/* ------------------------------------------------------------------ *
 * Teams
 * ------------------------------------------------------------------ */

export function renderTeams(dom, state, actions) {
  dom.teamCounter.textContent = `${state.teams.length}/${MAX_TEAMS}`;
  dom.teamList.replaceChildren(...state.teams.map((team) => {
    const input = el("input", {
      class: "team-name",
      type: "text",
      value: team.name,
      "aria-label": `Name of ${team.name}`,
      onchange: (event) => actions.renameTeam(team.id, event.target.value),
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") { input.value = team.name; input.blur(); }
    });
    return el("li", { class: "team" }, input, el("button", {
      type: "button",
      class: "icon danger",
      "aria-label": `Remove ${team.name}`,
      title: `Remove ${team.name}`,
      text: "×",
      onclick: () => actions.removeTeam(team.id),
    }));
  }));

  dom.teamsHint.textContent = state.teams.length < 2
    ? "Two teams are enough to start."
    : "Renaming is safe at any time. Adding or removing a team reschedules only the matches that have not been played.";
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

function scoreInput(match, side) {
  const value = side === "home" ? match.homeScore : match.awayScore;
  return el("input", {
    class: "score",
    type: "text",
    inputmode: "numeric",
    maxlength: "3",
    value: value ?? "",
    dataset: { matchId: String(match.id), side },
    "aria-label": `${side === "home" ? "Home" : "Away"} score`,
    onfocus: (event) => event.target.select(),
  });
}

function matchCard(state, match, actions, teamName) {
  const home = teamName(match.homeId);
  const away = teamName(match.awayId);

  const tableSelect = el("select", {
    class: "table-select",
    "aria-label": `Table for ${home} versus ${away}`,
    onchange: (event) => actions.setTable(match.id, Number(event.target.value)),
  }, ...Array.from({ length: state.settings.tableCount }, (_, index) => el("option", {
    value: String(index + 1),
    selected: match.table === index + 1,
    text: `Table ${index + 1}`,
  })));

  const form = el("form", {
    class: "score-form",
    onsubmit: (event) => {
      event.preventDefault();
      const [homeField, awayField] = form.querySelectorAll("input.score");
      actions.saveScore(match.id, homeField.value, awayField.value);
    },
  },
  el("label", { class: "side" }, el("span", { class: "side-name", text: home }), scoreInput(match, "home")),
  el("span", { class: "colon", text: ":" }),
  el("label", { class: "side" }, el("span", { class: "side-name", text: away }), scoreInput(match, "away")),
  el("button", { class: "primary small", type: "submit", text: match.played ? "Update" : "Save" }));

  const controls = el("div", { class: "match-actions" },
    el("button", { type: "button", class: "small", text: "◀ Earlier", title: "Move one slot earlier", onclick: () => actions.shiftMatch(match.id, -1) }),
    el("button", { type: "button", class: "small", text: "Later ▶", title: "Move one slot later", onclick: () => actions.shiftMatch(match.id, 1) }),
    match.played
      ? el("button", { type: "button", class: "small", text: "Clear score", onclick: () => actions.clearScore(match.id) })
      : null,
    match.pinned
      ? el("button", { type: "button", class: "small pin", text: "📌 Placed by hand", title: "Let the planner move this match again", onclick: () => actions.unpin(match.id) })
      : null,
    match.playedAt ? el("span", { class: "played-at", text: `finished ${formatTimestamp(match.playedAt)}` }) : null,
  );

  return el("article", { class: "match", dataset: { state: match.played ? "played" : "pending" } },
    el("div", { class: "match-head" }, tableSelect), form, controls);
}

export function renderSchedule(dom, state, status, actions, { discardDraftsFor = null } = {}) {
  const teamName = (id) => state.teams.find((team) => team.id === id)?.name ?? "Unknown team";
  const conflicts = findConflicts(state.matches, state.teams);
  const drafts = captureDrafts(dom.slotList, discardDraftsFor);

  dom.conflictBanner.hidden = conflicts.length === 0;
  if (conflicts.length) {
    dom.conflictBanner.textContent = `Check ${plural(conflicts.length, "clash")}: ${conflicts
      .slice(0, 3)
      .map((conflict) => `slot ${conflict.slot} — ${conflict.message}`)
      .join("; ")}${conflicts.length > 3 ? "; …" : ""}`;
  }

  if (state.matches.length === 0) {
    dom.slotList.replaceChildren(el("p", { class: "muted", text: "The schedule appears here once there are two teams." }));
    return;
  }

  dom.slotList.replaceChildren(...slotNumbers(state.matches).map((slotNumber) => {
    const inSlot = matchesInSlot(state.matches, slotNumber);
    const window = slotWindow(slotNumber, state.settings);
    const done = inSlot.every((match) => match.played);
    const current = status.currentSlot === slotNumber;

    return el("section", { class: "slot", dataset: { slot: String(slotNumber), state: done ? "done" : current ? "current" : "upcoming" } },
      el("header", { class: "slot-head" },
        el("h3", { text: `Slot ${slotNumber}` }),
        el("span", { class: "slot-time", text: `${formatClock(window.start)}–${formatClock(window.end)}` }),
        current ? el("span", { class: "slot-flag", text: "next up" }) : null,
        done ? el("span", { class: "slot-flag done", text: "done" }) : null),
      el("div", { class: "match-grid" }, ...inSlot.map((match) => matchCard(state, match, actions, teamName))));
  }));

  restoreDrafts(dom.slotList, drafts);
  dom.scheduleHint.textContent = `Every team plays every other team once. ${plural(state.settings.tableCount, "table")} running in parallel, ${state.settings.matchMinutes} minutes per match.`;
}

/**
 * Keep half-typed scores alive across a re-render caused by another match. The
 * match that triggered the render is skipped, so clearing a score really clears
 * the boxes instead of having the old value typed straight back in.
 */
function captureDrafts(root, discardFor) {
  const drafts = new Map();
  for (const input of root.querySelectorAll("input.score")) {
    if (input.value === "" || Number(input.dataset.matchId) === discardFor) continue;
    drafts.set(`${input.dataset.matchId}:${input.dataset.side}`, input.value);
  }
  return drafts;
}

function restoreDrafts(root, drafts) {
  for (const input of root.querySelectorAll("input.score")) {
    const draft = drafts.get(`${input.dataset.matchId}:${input.dataset.side}`);
    if (draft !== undefined && input.value === "") input.value = draft;
  }
}

/* ------------------------------------------------------------------ *
 * Standings and fairness
 * ------------------------------------------------------------------ */

export function renderStandings(dom, state) {
  const rows = computeStandings(state.teams, state.matches, state.settings);
  const complete = isComplete(state.matches);

  if (rows.length === 0) {
    dom.standingsBody.replaceChildren(el("tr", {}, el("td", { colspan: "10", class: "muted", text: "No teams yet." })));
  } else {
    dom.standingsBody.replaceChildren(...rows.map((row, index) => el("tr", {
      class: index === 0 && row.played > 0 ? "leader" : "",
    },
    ...[
      index + 1,
      row.name,
      row.played,
      row.points,
      row.wins,
      row.draws,
      row.losses,
      row.goalsFor,
      row.goalsAgainst,
      row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference,
    ].map((value, cell) => el(cell === 1 ? "th" : "td", {
      scope: cell === 1 ? "row" : false,
      class: cell === 1 ? "team-cell" : "",
      text: String(value),
    })))));
  }

  dom.rankingHint.textContent = `Points, then ${TIE_BREAKS[state.settings.tieBreak].toLowerCase()}. ${state.settings.winPoints} for a win, ${state.settings.drawPoints} for a draw.${complete ? " Final." : ""}`;
}

export function renderFairness(dom, state) {
  const rows = fairnessReport(state.teams, state.matches, state.settings);
  if (rows.length === 0 || state.matches.length === 0) {
    dom.fairnessBody.replaceChildren(el("tr", {}, el("td", { colspan: "4", class: "muted", text: "Nothing scheduled yet." })));
    return;
  }

  dom.fairnessBody.replaceChildren(...rows.map((row) => el("tr", {},
    el("th", { scope: "row", class: "team-cell", text: row.name }),
    el("td", { class: row.tableSpread > 1 ? "warn" : "", text: row.tables.join(" / ") }),
    el("td", { text: row.longestWait === 0 ? "none" : plural(row.longestWait, "slot") }),
    el("td", {
      text: row.nextSlot === null
        ? "done"
        : `slot ${row.nextSlot} · ${formatClock(slotWindow(row.nextSlot, state.settings).start)} · T${row.nextTable}`,
    }))));
}

/* ------------------------------------------------------------------ *
 * Settings form
 * ------------------------------------------------------------------ */

export function renderSettings(dom, state) {
  const { settings } = state;
  dom.tournamentTitle.value = settings.title;
  dom.tableCount.value = settings.tableCount;
  dom.startTime.value = settings.startTime;
  dom.matchMinutes.value = settings.matchMinutes;
  dom.breakMinutes.value = settings.breakMinutes;
  dom.winPoints.value = settings.winPoints;
  dom.drawPoints.value = settings.drawPoints;

  if (dom.tieBreak.options.length === 0) {
    dom.tieBreak.append(...Object.entries(TIE_BREAKS)
      .map(([value, label]) => el("option", { value, text: label })));
  }
  dom.tieBreak.value = settings.tieBreak;
}

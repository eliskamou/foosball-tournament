// The DOM stand-in has to be installed before app.js runs. Keep this import first.
import { answerConfirmWith, byId, clicked, confirmations, focused, settle, stored } from "./helpers/dom.js";
import test from "node:test";
import assert from "node:assert/strict";
import "../src/app.js";
import { STORAGE_KEY, normaliseState } from "../src/storage.js";

/**
 * These tests drive the one running app, so they build on each other in order —
 * the same way an evening in front of the screen does.
 */

const addTeams = (text) => {
  byId("teamName").value = text;
  byId("teamForm").dispatch("submit");
};
const matchCards = () => byId("slotList").querySelectorAll("article.match");
const slots = () => byId("slotList").querySelectorAll(".slot");
const teamRows = () => byId("teamList").children;
const pending = () => matchCards().filter((card) => card.dataset.state === "pending");
const enterScore = (card, home, away) => {
  const [homeField, awayField] = card.querySelectorAll("input.score");
  homeField.value = String(home);
  awayField.value = String(away);
  card.querySelector("form").dispatch("submit");
};

test("an empty tournament renders without teams or matches", () => {
  assert.equal(teamRows().length, 0);
  assert.match(byId("slotList").text, /appears here/);
  assert.equal(byId("undoButton").disabled, true);
});

test("several teams can be pasted in at once", () => {
  addTeams("Reds\nBlues\nGreens\nYellows");
  assert.equal(teamRows().length, 4);
  assert.equal(matchCards().length, 6);
  assert.equal(slots().length, 3);
  assert.match(byId("pageSubtitle").textContent, /4 teams/);
  assert.equal(byId("standingsBody").children.length, 4);
  assert.equal(byId("fairnessBody").children.length, 4);
});

test("the tournament is saved as soon as it exists", () => {
  assert.ok(stored()[STORAGE_KEY], "nothing was written to storage");
  assert.equal(JSON.parse(stored()[STORAGE_KEY]).teams.length, 4);
});

test("a repeated team name is refused with an explanation", () => {
  addTeams("reds");
  assert.equal(teamRows().length, 4);
  assert.match(byId("toast").textContent, /already added/);
});

test("saving a score updates the standings and enables undo", () => {
  enterScore(matchCards()[0], 10, 6);
  assert.equal(matchCards().filter((card) => card.dataset.state === "played").length, 1);
  assert.match(byId("standingsBody").text, /10/);
  assert.equal(byId("undoButton").disabled, false);
});

test("the cursor lands on the next match still to be played", () => {
  const field = focused();
  assert.ok(field, "nothing took focus");
  assert.match(field.className, /score/);
  assert.equal(field.dataset.side, "home");
});

test("a score that is not a number is refused", () => {
  enterScore(pending()[0], "abc", 1);
  assert.match(byId("toast").textContent, /whole numbers/);
  assert.equal(matchCards().filter((card) => card.dataset.state === "played").length, 1);
});

test("undo puts a score back the way it was", () => {
  byId("undoButton").dispatch("click");
  assert.equal(matchCards().every((card) => card.dataset.state === "pending"), true);
  assert.equal(byId("undoButton").disabled, true);
});

test("a team can be renamed everywhere at once", () => {
  const field = teamRows()[0].querySelector("input.team-name");
  field.dispatch("change", { target: { value: "The Reds" } });
  assert.match(byId("slotList").text, /The Reds/);
  assert.match(byId("standingsBody").text, /The Reds/);
});

test("renaming to a name in use, or to nothing, is refused", () => {
  const field = teamRows()[1].querySelector("input.team-name");
  field.dispatch("change", { target: { value: "the reds" } });
  assert.match(byId("toast").textContent, /already a team/);

  field.dispatch("change", { target: { value: "   " } });
  assert.match(byId("toast").textContent, /needs a name/);
});

test("changing a table by hand swaps places instead of double-booking one", () => {
  const card = matchCards()[0];
  const picker = card.querySelector("select.table-select");
  const otherTable = picker.options.find((option) => option.getAttribute("selected") === null);
  picker.dispatch("change", { target: { value: otherTable.getAttribute("value") } });

  assert.equal(byId("conflictBanner").hidden, true, byId("conflictBanner").textContent);
  assert.match(byId("slotList").text, /Placed by hand/);
  assert.equal(matchCards().length, 6);
});

test("a match can be dragged one slot earlier without breaking the schedule", () => {
  const card = matchCards().at(-1);
  card.querySelectorAll("button").find((button) => button.textContent.includes("Earlier")).dispatch("click");
  assert.equal(matchCards().length, 6);
  assert.equal(byId("conflictBanner").hidden, true, byId("conflictBanner").textContent);
});

test("re-balancing releases the hand placements", () => {
  byId("reoptimiseButton").dispatch("click");
  assert.match(byId("toast").textContent, /re-balanced/);
  assert.doesNotMatch(byId("slotList").text, /Placed by hand/);
});

test("a team can join once the tournament is under way", () => {
  enterScore(matchCards()[0], 7, 2);
  addTeams("Purples");
  assert.equal(teamRows().length, 5);
  assert.equal(matchCards().length, 10);
  assert.equal(matchCards().filter((card) => card.dataset.state === "played").length, 1, "the result was lost");
});

test("removing a team asks first and then rebuilds", () => {
  teamRows()[4].querySelectorAll("button")[0].dispatch("click");
  assert.ok(confirmations.some((message) => message.includes("Remove")));
  assert.equal(teamRows().length, 4);
  assert.equal(matchCards().length, 6);
});

test("a removal can be called off", () => {
  answerConfirmWith(false);
  teamRows()[0].querySelectorAll("button")[0].dispatch("click");
  assert.equal(teamRows().length, 4);
  answerConfirmWith(true);
});

test("settings change the title, the tables and the clock", () => {
  byId("tournamentTitle").value = "Friday Cup";
  byId("tableCount").value = "1";
  byId("startTime").value = "19:30";
  byId("matchMinutes").value = "8";
  byId("breakMinutes").value = "2";
  byId("winPoints").value = "3";
  byId("drawPoints").value = "1";
  byId("tieBreak").value = "wins";
  byId("settingsForm").dispatch("submit");

  assert.equal(byId("pageTitle").textContent, "Friday Cup");
  assert.equal(slots().length, 6, "one table means one match at a time");
  assert.match(byId("slotList").text, /19:30/);
  assert.match(byId("slotList").text, /19:40/, "the second slot is ten minutes later");
});

test("saving to a file offers a dated JSON download", () => {
  byId("exportButton").dispatch("click");
  assert.match(String(clicked().download), /^friday-cup-\d{4}-\d{2}-\d{2}\.json$/);
});

test("what is stored is exactly what comes back", () => {
  const saved = JSON.parse(stored()[STORAGE_KEY]);
  const reloaded = normaliseState(saved);
  const positions = (matches) => matches.map((match) => `${match.id}:${match.slot}:${match.table}:${match.homeScore}`).sort();
  assert.deepEqual(positions(reloaded.matches), positions(saved.matches));
  assert.deepEqual(reloaded.teams, saved.teams);
});

test("loading a file replaces the tournament", async () => {
  const file = { text: async () => JSON.stringify({
    teams: [{ id: 1, name: "Imported A" }, { id: 2, name: "Imported B" }],
    matches: [],
    settings: { title: "Imported Cup", tableCount: 2 },
  }) };
  byId("fileInput").dispatch("change", { target: { files: [file], value: "" } });
  await settle();

  assert.equal(byId("pageTitle").textContent, "Imported Cup");
  assert.equal(teamRows().length, 2);
  assert.equal(matchCards().length, 1);
});

test("a file that is not a tournament is reported, not swallowed", async () => {
  byId("fileInput").dispatch("change", { target: { files: [{ text: async () => "{ nonsense" }], value: "" } });
  await settle();
  assert.match(byId("toast").textContent, /could not be loaded/);
  assert.equal(teamRows().length, 2, "the open tournament was disturbed");
});

test("reset clears everything after confirming", () => {
  byId("resetButton").dispatch("click");
  assert.equal(teamRows().length, 0);
  assert.match(byId("slotList").text, /appears here/);
  assert.equal(stored()[STORAGE_KEY] === undefined || JSON.parse(stored()[STORAGE_KEY]).teams.length === 0, true);
});

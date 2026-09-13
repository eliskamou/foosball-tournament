# Foosball Tournament

Browser-based organiser for round-robin foosball tournaments. It generates the
fixture list, distributes matches across the available tables and time slots,
records scores and standings, and keeps the whole schedule editable while the
tournament is running.

Single static page: no build step, no dependencies, no account, no server. All
state lives in the browser.

## Why this exists

I organise foosball tournaments and evaluated the existing online tools first.
They were rejected on three counts:

- most are paid, or put the useful parts behind a subscription;
- they require an account before they will generate anything;
- the schedule is effectively immutable once generated — in particular the team
  list is fixed at creation time.

The third is the blocking one. In practice the inputs change *after* the
schedule exists:

| Situation | Requirement |
| --- | --- |
| A team arrives late and wants in | Add a team mid-tournament, keeping recorded results |
| A team leaves after two matches | Remove a team, keeping everyone else's results |
| A name was entered wrong | Rename at any point, everywhere it appears |
| A table frees up early | Reassign a match's table, or move it to another slot |
| Matches overrun | See how far behind the schedule is running |

The tools I tried handled these by regenerating from scratch, which discards
results. So the design constraint here is: **every input stays editable at any
point, and no edit discards a result that has already been recorded.**

## Features

- **Round-robin fixtures.** Every team plays every other team exactly once.
- **Balanced distribution.** The planner spreads each team's matches evenly
  through the session and across the tables, so idle time and table assignments
  are shared out rather than falling wherever the fixture order puts them.
- **Time slots with clock times.** Configurable start time, match length and
  break; each slot displays the time it is due to start.
- **Schedule tracking.** The header shows the current slot, how far ahead or
  behind the session is running — measured against when matches actually
  finished — and the projected finishing time.
- **Editable table assignments.** Per-match dropdown. Two matches in the same
  slot trade places, so a table cannot be double-booked.
- **Editable running order.** Move a match one slot earlier or later. If the
  target slot is full it swaps with a match there; the move is rejected if it
  would schedule a team against itself.
- **Add and remove teams mid-tournament.** Recorded results keep their slot,
  table and score. Only unplayed matches are replanned, and never into a slot
  that has already finished.
- **Standings** with configurable points per win and draw, and a selectable
  first tie-break.
- **Fairness report** giving the per-team table split and longest wait, so the
  distribution can be checked rather than assumed.
- **Persistence.** Autosave to `localStorage`, plus JSON export and import.
  Reopening a saved tournament reproduces the exact schedule, manual edits
  included.
- **Print layout** for the schedule.
- Responsive; light and dark themes.

## Scheduling algorithm

Fixtures come from the circle method, which pairs every team with every other in
an order where consecutive fixtures share no team. Fixtures are then placed by
earliest fit — the first slot with a free table where neither team is already
playing — which yields a schedule as short as the table count allows.

That is valid but not balanced, so a hill-climbing pass follows. It swaps two
matches, or moves one onto a free table, whenever this lowers a cost with two
terms:

- **Rest.** The gaps between one team's matches, including the wait before the
  first and after the last, each raised to the fourth power and summed. The gaps
  sum to a constant, so the score is minimised when they are equal. The fourth
  power rather than the square is deliberate: the search sums the cost of every
  team a swap touches, and under squares it will leave one team behind a long gap
  to make a marginal saving across three others.
- **Table balance.** The spread of a team's matches across the tables.

Played matches, and matches placed manually, are excluded from the search. That
exclusion is what makes the schedule safe to edit mid-tournament. The search is
deterministic: the same teams always produce the same schedule.

One case admits no even table split at all — four teams on two tables. The three
slots are forced, the 1-factorisation of K₄ is unique, and one team is always
confined to a single table. The test suite encodes this exception rather than
asserting a bound that cannot hold.

## Running

The app uses JavaScript modules, so it must be served rather than opened from
the file system:

```bash
npm start          # or: python3 -m http.server 8000
```

Then open <http://localhost:8000>. The page makes no network requests.

## Tests

Scheduling, standings, clock and storage rules run under Node's built-in test
runner, as does the app's own behaviour, driven through a small DOM stand-in in
`tests/helpers/dom.js`:

```bash
npm test
```

Requires Node 20 or newer. No test framework to install.

## Project structure

```
index.html            page structure
style.css             presentation, light and dark, plus a print layout
src/tournament.js     fixtures, scheduling, standings, fairness — no DOM
src/time.js           slot times, drift, projected finish
src/storage.js        validation, autosave, import and export
src/views.js          rendering
src/app.js            state and the actions behind each control
tests/                the rules above, and the app driven through a fake DOM
```

## Publishing

Static site with no build step, so GitHub Pages serves it unchanged: enable
Pages for the repository and point it at the branch root.

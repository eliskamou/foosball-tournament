/**
 * A very small stand-in for the browser, so that `app.js` — the file that turns
 * clicks into changes — can be tested by `node --test` without a real browser.
 *
 * It implements only what the app actually uses. Importing this module installs
 * the globals, so it has to be imported before `../src/app.js`.
 */

/** Every element `index.html` gives an id to. Kept in step with the markup. */
export const ELEMENT_IDS = [
  "pageTitle", "pageSubtitle", "statusCard", "teamCounter", "teamForm", "teamName",
  "teamList", "teamsHint", "settingsPanel", "settingsForm", "tournamentTitle",
  "tableCount", "startTime", "matchMinutes", "breakMinutes", "winPoints", "drawPoints",
  "tieBreak", "scheduleHint", "undoButton", "reoptimiseButton", "conflictBanner",
  "slotList", "standingsBody", "rankingHint", "fairnessBody", "saveHint", "exportButton",
  "importButton", "fileInput", "printButton", "resetButton", "toast",
];

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
  }

  get options() { return this.children.filter((child) => child.tagName === "OPTION"); }

  append(...nodes) { for (const node of nodes) if (node != null) this.children.push(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    // Real elements mirror a few attributes onto properties; the app relies on it.
    if (name === "value") this.value = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** Stand in for a user interaction. `overrides` fakes parts of the event. */
  dispatch(type, overrides = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ preventDefault() {}, target: this, ...overrides });
    }
    return this;
  }

  focus() { lastFocused = this; }
  blur() {}
  select() {}
  click() { lastClicked = this; this.dispatch("click"); }

  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  /** All the visible text, for asserting on what the organiser would read. */
  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)]
      .join(" ").replace(/\s+/g, " ").trim();
  }
}

/** Matches a single compound selector: `tag`, `.class` and `[attr="value"]`. */
function matches(node, selector) {
  const tag = /^[a-z]+/i.exec(selector)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;

  for (const [, className] of selector.matchAll(/\.([\w-]+)/g)) {
    if (!node.className.split(/\s+/).includes(className)) return false;
  }
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
    const actual = name.startsWith("data-")
      ? node.dataset[name.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())]
      : node.getAttribute(name);
    if (String(actual) !== value) return false;
  }
  return true;
}

const elements = new Map(ELEMENT_IDS.map((id) => {
  const element = new FakeElement(id.endsWith("Form") ? "form" : "div");
  element.id = id;
  return [id, element];
}));
elements.get("tieBreak").tagName = "SELECT";

const storage = new Map();
let lastFocused = null;
let lastClicked = null;
let confirmAnswer = true;

export const byId = (id) => elements.get(id);
export const focused = () => lastFocused;
export const clicked = () => lastClicked;
export const stored = () => Object.fromEntries(storage);
export const answerConfirmWith = (answer) => { confirmAnswer = answer; };
export const confirmations = [];

globalThis.document = {
  title: "",
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tagName) => new FakeElement(tagName),
};

globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

globalThis.window = {
  confirm: (message) => { confirmations.push(message); return confirmAnswer; },
  print: () => { lastClicked = "print"; },
};

// The toast timer and the status ticker would otherwise keep the test alive.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;

globalThis.Blob = class Blob {
  constructor(parts) { this.parts = parts; }
};
globalThis.URL = { createObjectURL: () => "blob:test", revokeObjectURL: () => {} };

/** Let queued promises settle without depending on the stubbed timers. */
export async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

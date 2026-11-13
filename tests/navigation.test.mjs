import test from "node:test";
import assert from "node:assert/strict";
import { activateAppView, resolveAppView } from "../js/navigation.js";

test("view routing uses the translator by default and supports browser history hashes", () => {
  assert.equal(resolveAppView(""), "translator");
  assert.equal(resolveAppView("#settings"), "settings");
  assert.equal(resolveAppView("#edo"), "edo");
  assert.equal(resolveAppView("#unknown"), "translator");
});

test("view activation exposes one panel and marks its navigation item", () => {
  const panels = ["translator", "settings", "edo"].map(name => ({
    dataset: { viewPanel: name }, hidden: true
  }));
  const links = ["translator", "settings", "edo"].map(name => ({
    dataset: { view: name }, attributes: {},
    setAttribute(key, value){ this.attributes[key] = value; },
    removeAttribute(key){ delete this.attributes[key]; }
  }));
  activateAppView(panels, links, "edo");
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, false]);
  assert.deepEqual(links.map(link => link.attributes["aria-current"] || null),
    [null, null, "page"]);
});

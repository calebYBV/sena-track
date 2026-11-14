import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateAppView, resolveAppView } from "../js/navigation.js";

test("view routing uses the translator by default and supports browser history hashes", () => {
  assert.equal(resolveAppView(""), "translator");
  assert.equal(resolveAppView("#settings"), "settings");
  assert.equal(resolveAppView("#edo"), "settings");
  assert.equal(resolveAppView("#unknown"), "translator");
});

test("view activation exposes one panel and marks its navigation item", () => {
  const panels = ["translator", "settings"].map(name => ({
    dataset: { viewPanel: name }, hidden: true
  }));
  const links = ["translator", "settings"].map(name => ({
    dataset: { view: name }, attributes: {},
    setAttribute(key, value){ this.attributes[key] = value; },
    removeAttribute(key){ delete this.attributes[key]; }
  }));
  activateAppView(panels, links, "settings");
  assert.deepEqual(panels.map(panel => panel.hidden), [true, false]);
  assert.deepEqual(links.map(link => link.attributes["aria-current"] || null),
    [null, "page"]);
});

test("the interface has only translator and settings views with comparison controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const views = [...html.matchAll(/data-view-panel="([^"]+)"/g)].map(match => match[1]);
  const navigationViews = [...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(views, ["translator", "settings"]);
  assert.deepEqual(navigationViews, ["translator", "settings"]);
  assert.doesNotMatch(html, /recognitionModeEdo|recognitionModeMediaPipe|name="recognitionMode"/);
  assert.doesNotMatch(html, /EDO activada/);
  assert.match(html, /id="filterModel"/);
  assert.match(html, /<option value="first">Primer orden<\/option>/);
  assert.match(html, /<option value="second">Segundo orden<\/option>/);
  assert.doesNotMatch(html, /<option value="off">/);
  assert.match(html, /id="edoContents"/);
  assert.match(html, /id="traceCoordinate"/);
  assert.match(html, /id="evalCaptureStart"/);
  assert.match(html, /id="evalTruth"/);
  assert.match(html, /id="compareVisual"/);
});

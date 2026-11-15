import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateAppView, mountEdoContents, resolveAppView } from "../js/navigation.js";

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

test("EDO template elements are validated and mounted before the comparison is initialized", () => {
  const comparison = { name: "comparison" };
  const settingsPanels = [{ name: "edo-settings" }, { name: "experimental-evaluation" }];
  const content = {
    cloneNode(){ return this; },
    querySelector(selector){
      if (selector === ".workspace-right") return comparison;
      if (selector.startsWith("#")) return selector === "#traceCoordinate" ? null : {};
      return null;
    },
    querySelectorAll(){ return settingsPanels; }
  };
  const operations = [];
  const document = {
    getElementById(id){
      return ({
        edoContents: { content },
        translatorView: { append(node){ operations.push(["translator", node]); } },
        settingsView: {
          insertBefore(node, before){ operations.push(["before-library", node, before]); },
          append(node){ operations.push(["settings", node]); }
        },
        librarySettings: { name: "library" }
      })[id] || null;
    }
  };
  mountEdoContents(document);
  assert.deepEqual(operations, [
    ["translator", comparison],
    ["before-library", settingsPanels[0], { name: "library" }],
    ["settings", settingsPanels[1]]
  ]);

  const missingReferenceDocument = {
    ...document,
    getElementById(id){
      if (id === "edoContents"){
        return {
          content: {
            ...content,
            querySelector(selector){
              return selector === "#evaluationReference" ? null : content.querySelector(selector);
            }
          }
        };
      }
      return document.getElementById(id);
    }
  };
  assert.throws(() => mountEdoContents(missingReferenceDocument), /#evaluationReference/);
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
  assert.doesNotMatch(html, /id="traceCoordinate"/);
  assert.match(html, /Seguimiento general en tiempo real/);
  assert.match(html, /desplazamientos RMS 2D/);
  assert.match(html, /Análisis EDO en tiempo real/);
  const edoTemplate = html.slice(html.indexOf('<template id="edoContents">'),
    html.indexOf('<section class="card white edo-settings"'));
  assert.equal([...edoTemplate.matchAll(/class="card white evaluation"/g)].length, 1);
  assert.ok(edoTemplate.indexOf("comparison-branches") < edoTemplate.indexOf("traceChart"));
  assert.ok(edoTemplate.indexOf("traceChart") < edoTemplate.indexOf("trackingMetricsTitle"));
  assert.ok(edoTemplate.indexOf("trackingMetricsTitle") < edoTemplate.indexOf("evaluation-capture"));
  assert.match(html, /id="evalCaptureStart"/);
  assert.match(html, /id="evalTruth"/);
  assert.match(html, /id="compareVisual"/);
});

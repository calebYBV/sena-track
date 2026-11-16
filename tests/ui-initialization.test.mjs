import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createUI } from "../js/ui.js";

const root = new URL("../", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");

class FakeElement {
  constructor(id){
    this.id = id;
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = {
      add(){},
      remove(){},
      toggle(){},
      contains(){ return false; }
    };
  }

  addEventListener(type, handler){
    const listeners = this.listeners.get(type) || [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  replaceChildren(...children){
    this.children = children;
    this.value = children[0]?.value || "";
  }

  add(child){ this.children.push(child); }
  setAttribute(name, value){ this.attributes.set(name, value); }
  getAttribute(name){ return this.attributes.get(name) ?? null; }
  getBoundingClientRect(){ return { width: 320, height: 108 }; }
  getContext(){ return chartContext; }
}

const chartContext = {
  setTransform(){},
  clearRect(){},
  fillRect(){},
  beginPath(){},
  moveTo(){},
  lineTo(){},
  stroke(){},
  fillText(){}
};

function installUI(html){
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const initialValues = {
    tol: "0.8", tolM: "0.7", dur: "2",
    filterModel: "first", filterTau: "0.06", filterZeta: "0.9",
    filterOmega: "14"
  };
  for (const [id, value] of Object.entries(initialValues)) elements.get(id).value = value;
  elements.get("speechEnabled").checked = true;
  elements.get("traceChart").getContext = () => chartContext;

  globalThis.Option = class {
    constructor(text, value){ this.text = text; this.value = value; }
  };
  globalThis.window = { devicePixelRatio: 1 };
  const video = new FakeElement("video");
  video.videoWidth = 640;
  video.videoHeight = 480;
  const dom = {
    $: id => elements.get(id) || null,
    video,
    canvas: new FakeElement("canvas"),
    ctx: chartContext,
    statusEl: new FakeElement("status"),
    signEl: new FakeElement("sign"),
    metaEl: new FakeElement("meta"),
    holdBar: new FakeElement("holdBar"),
    phraseEl: new FakeElement("phrase"),
    listEl: new FakeElement("list"),
    trainBar: new FakeElement("trainBar"),
    noteEl: new FakeElement("note"),
    countEl: new FakeElement("count"),
    bannerEl: new FakeElement("banner"),
    bannerText: new FakeElement("bannerText"),
    bannerBar: new FakeElement("bannerBar")
  };
  const state = {
    samples: [{ l: "Hola" }],
    motions: [{ l: "Adiós" }],
    phrase: "",
    filterConfig: {
      model: "first", tau: 0.06, zeta: 0.9, omegaN: 14, compareVisual: false
    },
    ambiguityConfig: { absoluteMargin: 0.04, relativeMargin: 0.08 }
  };
  const ui = createUI({
    state, dom,
    savePreferences: async () => {},
    deleteSign: async () => {}
  });
  return { elements, ui };
}

test("createUI initializes against every element in the current HTML", async () => {
  const html = await read("index.html");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const files = (await readdir(new URL("../js/", import.meta.url)))
    .filter(file => file.endsWith(".js"));
  const referencedIds = [];
  for (const file of files){
    const source = await read(`js/${file}`);
    for (const match of source.matchAll(/\$\(["']([^"']+)["']\)|getElementById\(["']([^"']+)["']\)/g)){
      referencedIds.push(match[1] || match[2]);
    }
  }
  assert.ok(referencedIds.length > 0);
  assert.deepEqual([...new Set(referencedIds.filter(id => !htmlIds.has(id)))], []);

  const { elements, ui } = installUI(html);
  const references = elements.get("evaluationReference");
  ui.refreshReferences();
  assert.deepEqual(references.children.map(option => option.value), ["", "Hola", "Adiós"]);
  assert.equal(elements.has("traceCoordinate"), false);
});

test("the general trace renders and reports motion using the current chart elements", async () => {
  const html = await read("index.html");
  const { elements, ui } = installUI(html);
  const first = { hands: { Left: [{ x: 0, y: 0 }] } };
  const second = { hands: { Left: [{ x: 0.1, y: 0 }] } };
  ui.updateCoordinateTrace(first, first, 0);
  ui.updateCoordinateTrace(second, second, 100);
  assert.match(elements.get("traceStatus").textContent, /1 región seguida/);
  assert.equal(elements.get("traceChart").width, 320);
  assert.match(await read("index.html"), /MediaPipe original frente a MediaPipe filtrado con EDO/);
});

test("the stability panel contains only displacement and vibration cards", async () => {
  const html = await read("index.html");
  const panel = html.match(/<section class="tracking-metrics"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel);
  assert.match(panel, /Estabilidad del seguimiento/);
  assert.match(panel, /Desplazamiento general/);
  assert.match(panel, /RMS 2D · % de escala\/s/);
  assert.match(panel, /Ventana estable · % de escala/);
  assert.equal([...panel.matchAll(/class="tracking-metric /g)].length, 2);
  assert.doesNotMatch(panel, /trackingLag|retardo temporal|desfase/);
  for (const id of ["displacementRawValue", "displacementFilteredValue",
    "displacementComparison", "vibrationRawValue", "vibrationFilteredValue",
    "vibrationReduction", "vibrationProgress", "vibrationProgressText"]){
    assert.match(panel, new RegExp(`id="${id}"`));
  }
});

test("tracking UI renders both branches, relative changes, and quiet-window progress", async () => {
  const html = await read("index.html");
  const { elements, ui } = installUI(html);
  assert.equal((html.match(/<article class="tracking-metric /g) || []).length, 2);
  assert.match(html, /trace-legend"><span>MediaPipe<\/span><span>MediaPipe \+ EDO<\/span>/);
  assert.match(html, /trace-explanation">Movimiento general de las coordenadas detectadas\./);
  const styles = await read("css/styles.css");
  assert.match(styles, /@media\(max-width:600px\)[\s\S]*?\.tracking-metric-grid\{grid-template-columns:1fr\}/);
  ui.updateTrackingMetrics({
    displacementRaw: 2,
    displacementFiltered: 2.4,
    displacementChange: -20,
    displacementAssessment: "Mayor desplazamiento observado con EDO",
    vibrationRaw: 0.12,
    vibrationFiltered: 0.08,
    vibrationReduction: 33.3,
    vibrationAssessment: "EDO reduce la vibración",
    vibrationRegionCount: 1,
    vibrationProgress: 60,
    quietReason: "Segmento estable: 60%.",
    status: "Analizando 1 región.",
    note: "Nota de análisis"
  });
  assert.equal(elements.get("displacementRawValue").textContent, "2.00");
  assert.equal(elements.get("displacementFilteredValue").textContent, "2.40");
  assert.match(elements.get("displacementComparison").textContent, /20\.0 % más desplazamiento/);
  assert.equal(elements.get("displacementAssessment").textContent, "");
  assert.equal(elements.get("vibrationRawValue").textContent, "0.120");
  assert.equal(elements.get("vibrationFilteredValue").textContent, "0.080");
  assert.match(elements.get("vibrationReduction").textContent, /33\.3 % menos vibración/);
  assert.equal(elements.get("stabilityAssessment").textContent, "1 región incluida");
  assert.equal(elements.get("vibrationProgress").value, 60);
  assert.equal(elements.get("vibrationProgress").getAttribute("aria-valuenow"), "60");

  ui.updateTrackingMetrics({
    displacementRaw: 0,
    displacementFiltered: 0,
    displacementChange: null,
    displacementAssessment: "Porcentaje no calculable: valor base demasiado pequeño",
    vibrationRaw: 0,
    vibrationFiltered: 0,
    vibrationReduction: null,
    vibrationAssessment: "Sin diferencia medible",
    vibrationRegionCount: 1,
    vibrationProgress: 100,
    quietReason: "Ventana quieta medida.",
    status: "Analizando 1 región.",
    note: "Nota de análisis"
  });
  assert.match(elements.get("displacementComparison").textContent, /valor base demasiado pequeñ/i);
  assert.equal(elements.get("vibrationReduction").textContent, "Sin diferencia medible");

  const idleMessage = "Inicia el reconocimiento para visualizar el análisis EDO.";
  ui.resetCoordinateTrace(idleMessage);
  ui.updateTrackingMetrics({
    displacementRaw: null,
    displacementFiltered: null,
    displacementChange: null,
    displacementAssessment: idleMessage,
    vibrationRaw: null,
    vibrationFiltered: null,
    vibrationReduction: null,
    vibrationAssessment: null,
    vibrationRegionCount: 0,
    vibrationProgress: 0,
    quietReason: idleMessage,
    status: idleMessage,
    note: "Nota de análisis"
  });
  assert.equal(elements.get("displacementRawValue").textContent, "—");
  assert.equal(elements.get("vibrationRawValue").textContent, "—");
  assert.equal(elements.get("vibrationProgress").value, 0);
  assert.equal(elements.get("stabilityAssessment").textContent, "");
  assert.equal(elements.get("vibrationProgressText").textContent, "");
  assert.equal(elements.get("vibrationReduction").textContent, idleMessage);
  assert.equal(elements.get("traceStatus").textContent, idleMessage);
  assert.equal(elements.get("trackingCalculationStatus").textContent, idleMessage);
});

test("the EDO template is mounted before createUI initializes its references", async () => {
  const app = await read("js/app.js");
  const html = await read("index.html");
  assert.ok(app.indexOf("mountEdoContents(document)") < app.indexOf("createUI("));
  assert.match(html, /id="evaluationReference"/);
  assert.match(html, /id="traceChart"/);
  assert.match(html, /id="traceStatus"/);
});

test("all application module imports use one versioned import map, including lazy modules", async () => {
  const html = await read("index.html");
  const mapMatch = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(mapMatch, "index.html must provide an import map");
  const imports = JSON.parse(mapMatch[1]).imports;
  const entryMatch = html.match(/<script type="module" src="([^"]+)"><\/script>/);
  assert.ok(entryMatch);
  const version = new URL(entryMatch[1], "https://example.test/").searchParams.get("v");
  assert.ok(version);
  const stylesheetMatch = html.match(/<link rel="stylesheet" href="([^"]+)">/);
  assert.ok(stylesheetMatch);
  assert.equal(
    new URL(stylesheetMatch[1], "https://example.test/").searchParams.get("v"),
    version
  );

  const files = (await readdir(new URL("../js/", import.meta.url)))
    .filter(file => file.endsWith(".js"));
  for (const file of files){
    const moduleKey = `./js/${file}`;
    assert.ok(imports[moduleKey], `${moduleKey} is missing from the import map`);
    assert.equal(
      new URL(imports[moduleKey], "https://example.test/").searchParams.get("v"),
      version,
      `${moduleKey} does not use the release version`
    );
    const source = await read(`js/${file}`);
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']/g)]
      .map(match => match[1]);
    for (const specifier of specifiers){
      const importedPath = path.posix.normalize(path.posix.join(
        "js", path.posix.dirname(file), specifier
      ));
      if (!importedPath.endsWith(".js")) continue;
      assert.ok(imports[`./${importedPath}`],
        `${file} imports ${specifier} without a version-map entry`);
    }
    assert.doesNotMatch(source, /traceCoordinate/);
  }
});

test("comparison output distinguishes unavailable references from a distance rejection", async () => {
  const html = await read("index.html");
  const { elements, ui } = installUI(html);
  elements.get("distanceReduction").parentElement = new FakeElement("distanceReductionParent");
  ui.updateComparison({
    detected: false,
    reason: "No existen referencias utilizables; 2 muestra(s) siguen pendientes de subida."
  });
  assert.equal(elements.get("filteredPrediction").textContent, "Sin referencias utilizables");

  ui.updateComparison({
    detected: false,
    reason: "No hay señas compatibles con los componentes detectados."
  });
  assert.equal(elements.get("filteredPrediction").textContent, "Sin señas compatibles");

  ui.updateComparison({
    detected: true,
    filteredPrediction: null
  });
  assert.equal(elements.get("filteredPrediction").textContent, "No identificada");
});

import {
  calculateDistanceDifference,
  DEFAULT_AMBIGUITY_CONFIG,
  normalizeAmbiguityConfig
} from "./recognition.js";
import {
  isCurrentRecognitionResult,
  selectActivePrediction,
  shouldAutoAppendPhrase
} from "./recognitionState.js";
import { countCapturesForLabel } from "./sampleCount.js";
import { FACE_BLENDSHAPES } from "./holistic.js";

export function createUI({ state, dom, savePreferences, deleteSign }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
let lastComparison = null;
const traceCanvas = $("traceChart");
const traceContext = traceCanvas.getContext("2d");
const traceSamples = [];
let lastTraceUpdate = -Infinity;
const HAND_POINT_NAMES = [
  "Muñeca", "Pulgar · base", "Pulgar · nudillo", "Pulgar · articulación", "Pulgar · punta",
  "Índice · base", "Índice · nudillo", "Índice · articulación", "Índice · punta",
  "Medio · base", "Medio · nudillo", "Medio · articulación", "Medio · punta",
  "Anular · base", "Anular · nudillo", "Anular · articulación", "Anular · punta",
  "Meñique · base", "Meñique · nudillo", "Meñique · articulación", "Meñique · punta"
];
const FACE_POINTS = [[1, "Cabeza · centro"], [10, "Cabeza · frente"], [152, "Cabeza · mentón"],
  [33, "Rostro · ojo izquierdo"], [263, "Rostro · ojo derecho"],
  [61, "Rostro · comisura izquierda"], [291, "Rostro · comisura derecha"]];
const FACE_GEOMETRY = [
  "Proporción frente-mentón", "Apertura ojo izquierdo", "Apertura ojo derecho",
  "Apertura párpado izquierdo", "Apertura párpado derecho", "Ancho de boca",
  "Apertura de boca", "Proporción de boca"
];
function addTraceOption(value, label){
  traceCanvas.previousElementSibling.add(new Option(label, value));
}
for (const side of ["Left", "Right"]){
  const sideName = side === "Left" ? "izquierda" : "derecha";
  HAND_POINT_NAMES.forEach((pointName, index) => {
    for (const axis of ["x", "y", "z"]){
      addTraceOption(`hand:${side}:${index}:${axis}`,
        `Mano ${sideName} · ${pointName} · ${axis}`);
    }
  });
}
for (const [index, label] of FACE_POINTS){
  for (const axis of ["x", "y", "z"]) addTraceOption(
    `face:${index}:${axis}`, `${label} · ${axis}`);
}
FACE_BLENDSHAPES.forEach((name, index) =>
  addTraceOption(`feature:${index}`, `Rostro · ${name} · puntuación`));
FACE_GEOMETRY.forEach((name, index) =>
  addTraceOption(`feature:${21 + index}`, `Rostro · ${name} · proporción`));
for (const [index, name] of [[29, "yaw"], [30, "pitch"], [31, "roll"]]){
  addTraceOption(`feature:${index}`, `Cabeza · ${name} / π`);
}
$("traceCoordinate").value = "hand:Left:0:x";

function traceValue(frame, selection){
  const [type, identity, pointIndex, axis] = selection.split(":");
  if (type === "hand"){
    const point = frame?.hands?.[identity]?.[Number(pointIndex)];
    return Number.isFinite(point?.[axis]) ? point[axis] : null;
  }
  if (type === "face"){
    const point = frame?.faceLandmarks?.[Number(identity)];
    return Number.isFinite(point?.[pointIndex]) ? point[pointIndex] : null;
  }
  const value = frame?.faceFeatures?.[Number(identity)];
  return Number.isFinite(value) ? value : null;
}

function drawCoordinateTrace(){
  const bounds = traceCanvas.getBoundingClientRect();
  if (!bounds.width) return;
  const ratio = window.devicePixelRatio || 1;
  traceCanvas.width = Math.round(bounds.width * ratio);
  traceCanvas.height = Math.round(132 * ratio);
  traceContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width, height = 132;
  const left = 36, right = width - 8, top = 8, bottom = height - 27;
  traceContext.clearRect(0, 0, width, height);
  traceContext.fillStyle = "#fbfeff";
  traceContext.fillRect(0, 0, width, height);
  traceContext.strokeStyle = "#dceaf2";
  traceContext.lineWidth = 1;
  for (let i = 0; i <= 3; i++){
    const y = top + (bottom - top) * i / 3;
    traceContext.beginPath();
    traceContext.moveTo(left, y);
    traceContext.lineTo(right, y);
    traceContext.stroke();
  }
  if (!traceSamples.length) return;
  const values = traceSamples.flatMap(sample =>
    [sample.raw, sample.filtered]).filter(Number.isFinite);
  if (!values.length) return;
  let minimum = Math.min(...values), maximum = Math.max(...values);
  if (maximum - minimum < 1e-9){
    minimum -= 0.01;
    maximum += 0.01;
  } else {
    const padding = (maximum - minimum) * 0.08;
    minimum -= padding;
    maximum += padding;
  }
  traceContext.fillStyle = "#54718a";
  traceContext.font = "10px sans-serif";
  traceContext.textAlign = "right";
  traceContext.fillText(maximum.toFixed(3), left - 4, top + 4);
  traceContext.fillText(minimum.toFixed(3), left - 4, bottom);
  const startTime = traceSamples[0].time;
  const endTime = traceSamples.at(-1).time;
  traceContext.textAlign = "left";
  traceContext.fillText(`-${((endTime - startTime) / 1000).toFixed(1)} s`, left, height - 4);
  traceContext.textAlign = "right";
  traceContext.fillText("0 s", right, height - 4);
  const drawLine = (key, color) => {
    traceContext.beginPath();
    traceContext.strokeStyle = color;
    traceContext.lineWidth = 1.8;
    traceSamples.forEach((sample, index) => {
      if (!Number.isFinite(sample[key])) return;
      const x = endTime > startTime
        ? left + (right - left) * (sample.time - startTime) / (endTime - startTime)
        : (left + right) / 2;
      const y = bottom - (sample[key] - minimum) / (maximum - minimum) * (bottom - top);
      if (index === 0 || !Number.isFinite(traceSamples[index - 1][key])) traceContext.moveTo(x, y);
      else traceContext.lineTo(x, y);
    });
    traceContext.stroke();
  };
  drawLine("raw", "#0c71c6");
  drawLine("filtered", "#67a938");
}

function updateCoordinateTrace(rawFrame, filteredFrame, timestamp){
  const selection = $("traceCoordinate").value;
  const raw = traceValue(rawFrame, selection);
  const filtered = traceValue(filteredFrame, selection);
  if (Number.isFinite(raw) && Number.isFinite(filtered)){
    traceSamples.push({ time: timestamp, raw, filtered });
    if (traceSamples.length > 90) traceSamples.shift();
    $("traceStatus").textContent = selection.startsWith("feature:")
      ? "Puntuación/proporción facial o ángulo de cabeza en π; eje horizontal: tiempo real reciente."
      : "Coordenada MediaPipe normalizada; eje horizontal: tiempo real reciente.";
  } else if (timestamp - lastTraceUpdate >= 500){
    $("traceStatus").textContent = "La coordenada seleccionada no está detectada en este momento.";
  }
  if (timestamp - lastTraceUpdate < 100) return;
  lastTraceUpdate = timestamp;
  drawCoordinateTrace();
}
$("traceCoordinate").addEventListener("change", () => {
  traceSamples.length = 0;
  $("traceStatus").textContent = "Esperando coordenadas de la opción seleccionada.";
  drawCoordinateTrace();
});
function setNote(t){ noteEl.textContent = t; }
function setSyncStatus(text, status = "saved"){
  const element = $("syncStatus");
  element.textContent = text;
  element.dataset.state = status;
  $("syncRetry").hidden = status !== "error" && status !== "pending";
}

function stability(r, timestamp = performance.now(), generation = state.recognitionGeneration){
  if (!isCurrentRecognitionResult(state, generation)) return;
  if (!state.recognitionEnabled) return;
  state.noHand = 0;
  state.noHandSince = null;
  if (r?.reason === "ambiguous"){
    state.cand = null; state.candCount = 0; state.candSince = null;
    holdBar.style.width = "0";
    signEl.textContent = "Reconocimiento ambiguo";
    signEl.className = "sign idle";
    metaEl.textContent = r.candidates?.length
      ? `Candidatas: ${r.candidates.join(" / ")}` : "";
    return;
  }
  const label = r ? r.label : null;
  if (!label){
    state.cand = null; state.candCount = 0; state.candSince = null;
    if (state.neutralSince === null || state.neutralSince === undefined){
      state.neutralSince = timestamp;
    }
    if (timestamp - state.neutralSince >= 500) state.committed = null;
    holdBar.style.width = "0";
    return;
  }
  state.neutralSince = null;
  if (label !== state.cand){
    state.cand = label;
    state.candCount = 0;
    state.candSince = timestamp;
  }
  state.candCount++;
  const confirmedForMs = timestamp - state.candSince;
  holdBar.style.width = Math.min(100, confirmedForMs / 450 * 100) + "%";
  if (confirmedForMs >= 450 && label !== state.committed){
    state.committed = label;
    addToPhrase(label);
  }
}
function lostHand(timestamp = performance.now()){
  if (state.noHandSince === null || state.noHandSince === undefined){
    state.noHandSince = timestamp;
  }
  state.noHand++;
  state.cand = null;
  state.candCount = 0;
  state.candSince = null;
  if (timestamp - state.noHandSince >= 500){
    state.committed = null;
    state.neutralSince = timestamp;
    return true;
  }
  holdBar.style.width = "0";
  return false;
}
function addToPhrase(label, generation = state.recognitionGeneration){
  if (!shouldAutoAppendPhrase(state, label, performance.now(), generation)) return false;
  const normalized = String(label).trim();
  if (normalized.length === 1) state.phrase += normalized;
  else state.phrase += (state.phrase && !state.phrase.endsWith(" ") ? " " : "") + normalized + " ";
  phraseEl.textContent = state.phrase;
  if ($("speechEnabled").checked &&
      document.querySelector('input[name="speechMode"]:checked')?.value === "automatic"){
    speakText(normalized);
  }
  return true;
}

function speakText(text){
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance !== "function"){
    setNote("La lectura en voz alta no está disponible en este navegador.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-419";
  window.speechSynthesis.speak(utterance);
}

function renderList(){
  const groups = new Map();
  for (const example of [...state.samples, ...state.motions]){
    if (!groups.has(example.l)) groups.set(example.l, []);
    groups.get(example.l).push(example);
  }
  listEl.innerHTML = "";
  if (!groups.size){
    listEl.innerHTML = '<li class="empty" style="background:none;padding:0">Tu biblioteca está vacía. Registra tu primera seña</li>';
    refreshReferences();
    return;
  }
  for (const [label, examples] of groups){
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "sign-info";
    const icon = document.createElement("span");
    icon.className = "sign-thumbnail";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "◇";
    const name = document.createElement("span"); name.className = "name"; name.textContent = label;
    const hasLegacy = examples.some(example => !example.components);
    const tag = document.createElement("span");
    tag.className = "tag" + (hasLegacy ? " legacy" : "");
    const hasPending = examples.some(example => example.syncStatus === "pending");
    tag.textContent = [
      hasLegacy ? "incluye señas anteriores" : "",
      hasPending ? "pendiente de sincronización" : ""
    ].filter(Boolean).join(" · ");
    const cnt = document.createElement("span"); cnt.className = "count-txt";
    cnt.textContent = `${countCapturesForLabel(examples, label)} capturas`;
    const b = document.createElement("button");
    b.className = "btn line";
    b.textContent = "Borrar";
    b.setAttribute("aria-label", `Borrar seña ${label}`);
    b.onclick = () => {
      void deleteSign(label, "all").catch(error => {
        console.error("No se pudo eliminar la seña.", error);
        setSyncStatus(`No se pudo preparar la eliminación: ${error.message}`, "error");
      });
    };
    li.className = "sign-item";
    info.append(name, tag, cnt);
    li.append(icon, info, b); listEl.appendChild(li);
  }
  refreshReferences();
}

/* ---------- Controles ---------- */
$("btnSpace").onclick = () => { state.phrase += " "; phraseEl.textContent = state.phrase; };
$("btnBack").onclick = () => { state.phrase = state.phrase.slice(0, -1); phraseEl.textContent = state.phrase; };
$("btnClear").onclick = () => { state.phrase = ""; phraseEl.textContent = ""; };
$("btnSpeak").onclick = () => {
  if (!state.phrase.trim() || !$("speechEnabled").checked) return;
  speakText(state.phrase.trim());
};
$("btnStopSpeech").onclick = () => {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
};
function bindRange(id, valId, fmt){
  const el = $(id), out = $(valId);
  const upd = () => out.textContent = fmt(+el.value);
  el.oninput = upd; upd();
  el.addEventListener("change", () => { void savePreferences(); });
}
function refreshGeneralControls(){
  $("tolVal").textContent = Number($("tol").value).toFixed(2);
  $("tolMVal").textContent = Number($("tolM").value).toFixed(2);
  $("durVal").textContent = `${Number($("dur").value).toFixed(1)} s`;
  $("btnSpeak").disabled = !$("speechEnabled").checked;
}
 $("speechEnabled").addEventListener("change", () => {
  refreshGeneralControls();
  void savePreferences();
});
bindRange("tol", "tolVal", v => v.toFixed(2));
bindRange("tolM", "tolMVal", v => v.toFixed(2));
bindRange("dur", "durVal", v => v.toFixed(1) + " s");

const filterControls = [
  ["filterModel", "model"],
  ["filterTau", "tau"],
  ["filterZeta", "zeta"],
  ["filterOmega", "omegaN"],
  ["compareVisual", "compareVisual"]
];
function refreshFilterControls(){
  const config = state.filterConfig;
  $("filterModel").value = config.model;
  $("filterTau").value = config.tau;
  $("filterZeta").value = config.zeta;
  $("filterOmega").value = config.omegaN;
  $("compareVisual").checked = config.compareVisual;
  $("filterTauValue").textContent = `${Number(config.tau).toFixed(2)} s`;
  $("filterZetaValue").textContent = Number(config.zeta).toFixed(1);
  $("filterOmegaValue").textContent = `${Number(config.omegaN).toFixed(0)} rad/s`;
  $("tauControl").hidden = config.model !== "first";
  $("zetaControl").hidden = config.model !== "second";
  $("omegaControl").hidden = config.model !== "second";
  $("firstEquation").hidden = config.model !== "first";
  $("secondEquation").hidden = config.model !== "second";
  $("firstCalculation").hidden = config.model !== "first";
  $("secondCalculation").hidden = config.model !== "second";
  $("activeModelName").textContent = config.model === "first" ? "Filtro de primer orden" :
    "Modelo de segundo orden amortiguado";
  $("settingsModelName").textContent = $("activeModelName").textContent;
  $("filterModelDescription").textContent = config.model === "first"
    ? "Acerca gradualmente las coordenadas filtradas a las mediciones de MediaPipe para reducir vibraciones y saltos."
    : "Considera la posición y la velocidad del punto filtrado para ajustar cómo acelera o frena al seguir las mediciones.";
  $("rawBranchLabel").textContent = "MediaPipe · comparación";
  $("filteredBranchLabel").textContent = "MediaPipe + EDO · reconocimiento";
  $("compareVisualLabel").textContent = "Superponer coordenadas originales y EDO (más carga gráfica)";
}
for (const [id, key] of filterControls){
  const update = persist => {
    const element = $(id);
    state.filterConfig[key] = id === "compareVisual" ? element.checked :
      (key === "model" ? element.value : Number(element.value));
    refreshFilterControls();
    if (key !== "compareVisual") state.onFilterChange?.();
    if (persist) void savePreferences();
  };
  if (id === "filterTau" || id === "filterZeta" || id === "filterOmega"){
    $(id).addEventListener("input", () => {
      const value = Number($(id).value);
      if (key === "tau") $("filterTauValue").textContent = `${value.toFixed(2)} s`;
      if (key === "zeta") $("filterZetaValue").textContent = value.toFixed(1);
      if (key === "omegaN") $("filterOmegaValue").textContent = `${value.toFixed(0)} rad/s`;
    });
    $(id).addEventListener("change", () => update(true));
  } else $(id).addEventListener("change", () => update(true));
}
function refreshAmbiguityControls(){
  const config = normalizeAmbiguityConfig(state.ambiguityConfig || DEFAULT_AMBIGUITY_CONFIG);
  state.ambiguityConfig = config;
  $("ambiguityAbsolute").value = String(config.absoluteMargin);
  $("ambiguityRelative").value = String(config.relativeMargin);
  $("ambiguityAbsoluteValue").value = config.absoluteMargin.toFixed(2);
  $("ambiguityRelativeValue").value = config.relativeMargin.toFixed(2);
}
for (const [id, key] of [
  ["ambiguityAbsolute", "absoluteMargin"],
  ["ambiguityRelative", "relativeMargin"]
]){
  $(id).addEventListener("input", () => {
    state.ambiguityConfig = normalizeAmbiguityConfig({
      ...state.ambiguityConfig,
      [key]: Number($(id).value)
    });
    refreshAmbiguityControls();
  });
  $(id).addEventListener("change", () => { void savePreferences(); });
}
refreshAmbiguityControls();
function refreshReferences(){
  const select = $("evaluationReference");
  const selected = select.value;
  const labels = new Set([...state.samples, ...state.motions]
    .filter(example => example.syncStatus !== "pending")
    .map(example => example.l));
  select.replaceChildren(new Option("Candidata de la rama principal", ""));
  for (const label of labels) select.add(new Option(label, label));
  if (labels.has(selected)) select.value = selected;
}
$("evaluationReference").addEventListener("change", renderComparison);
refreshFilterControls();

function setEvaluationEnabled(enabled){
  const panel = $("evaluationPanel");
  panel.classList.toggle("is-disabled", !enabled);
  panel.setAttribute("aria-disabled", String(!enabled));
  $("evaluationReference").disabled = !enabled;
  $("compareVisual").disabled = !enabled;
  for (const id of ["filterModel", "filterTau", "filterZeta", "filterOmega"]) $(id).disabled = !enabled;
  if (!enabled){
    lastComparison = null;
    $("distanceReduction").parentElement.classList.remove("is-positive", "is-negative", "is-neutral");
    $("referenceLabel").textContent = "Disponible al utilizar el Traductor";
    $("rawPrediction").textContent = "—";
    $("filteredPrediction").textContent = "—";
    $("rawDistance").textContent = "—";
    $("filteredDistance").textContent = "—";
    $("distanceReduction").textContent = "No disponible";
    $("comparisonStatus").textContent = "Disponible al utilizar el Traductor";
    $("comparisonNote").textContent = "Las capturas de entrenamiento no se contabilizan como pruebas.";
    updateTrackingMetrics({
      rawVibration: null, filteredVibration: null, vibrationReduction: null, lagMs: null,
      note: "Métricas disponibles durante el reconocimiento, no durante la captura de ejemplos."
    });
  } else {
    lastComparison = null;
    renderComparison();
  }
}
function predictionText(prediction){
  if (prediction?.reason === "ambiguous") return "Ambigua";
  return prediction?.label || "No identificada";
}
function renderComparison(){
  if ($("evaluationPanel").getAttribute("aria-disabled") === "true") return;
  const result = lastComparison;
  const reductionReadout = $("distanceReduction").parentElement;
  reductionReadout.classList.remove("is-positive", "is-negative", "is-neutral");
  reductionReadout.setAttribute("aria-label", "Diferencia de distancia no disponible");
  $("rawPrediction").textContent = predictionText(result?.rawPrediction);
  $("filteredPrediction").textContent = predictionText(result?.filteredPrediction);
  $("rawDistance").textContent = "—";
  $("filteredDistance").textContent = "—";
  $("distanceReduction").textContent = "No disponible";
  if (!result?.detected){
    const requested = $("evaluationReference").value;
    $("referenceLabel").textContent = requested ? `Seña seleccionada: ${requested}` : "Referencia candidata: uso libre";
    $("comparisonStatus").textContent = result?.reason || "Muestra las partes requeridas para comparar.";
    $("comparisonNote").textContent = "La comparación experimental se actualiza durante el reconocimiento activo; MediaPipe puede incluir procesamiento interno.";
    return;
  }
  if (result.reason){
    $("comparisonStatus").textContent = "Comparación no disponible";
    $("comparisonNote").textContent = result.reason;
    return;
  }
  const requested = $("evaluationReference").value;
  const mainPrediction = selectActivePrediction(result.filteredPrediction);
  const reference = requested || mainPrediction?.label ||
    result.filteredPrediction?.label || result.rawPrediction?.label;
  $("referenceLabel").textContent = requested
    ? `Seña seleccionada por el usuario: ${requested}`
    : reference ? `Referencia candidata: ${reference}` : "Referencia candidata: aún no identificada";
  if (!reference){
    $("comparisonStatus").textContent = "Comparación no disponible";
    $("comparisonNote").textContent = "Selecciona una seña de referencia o realiza una seña que tenga ejemplos guardados.";
    return;
  }
  const rawDistance = result.rawDistances?.[reference];
  const filteredDistance = result.filteredDistances?.[reference];
  if (Number.isFinite(rawDistance)) $("rawDistance").textContent = rawDistance.toFixed(4);
  if (Number.isFinite(filteredDistance)) $("filteredDistance").textContent = filteredDistance.toFixed(4);
  if (!Number.isFinite(rawDistance) || !Number.isFinite(filteredDistance)){
    $("comparisonStatus").textContent = result.referenceFilterMismatch
      ? "Comparación no disponible para esta referencia."
      : "Guarda ejemplos de esta seña para calcular la comparación.";
    $("comparisonNote").textContent = result.referenceFilterMismatch
      ? "La referencia no se pudo emparejar o regenerar con el filtro activo. Se conserva por compatibilidad cuando es posible, pero esta comparación no está disponible; vuelve a capturar la seña."
      : requested
      ? "No hay ejemplos guardados de la seña seleccionada en esta modalidad."
      : "La candidata no confirma la intención del usuario.";
    return;
  }
  const difference = calculateDistanceDifference(rawDistance, filteredDistance);
  if (difference === null){
    $("distanceReduction").textContent = "No disponible";
    reductionReadout.classList.add("is-neutral");
    reductionReadout.setAttribute("aria-label", "Diferencia de distancia no disponible");
    $("comparisonStatus").textContent = "Comparación no disponible.";
  } else {
    $("distanceReduction").textContent =
      `${difference > 0 ? "+" : ""}${difference.toFixed(4)} unidades`;
    reductionReadout.classList.add(difference > 0 ? "is-positive" : difference < 0 ? "is-negative" : "is-neutral");
    reductionReadout.setAttribute("aria-label", difference > 0
      ? `La distancia EDO es menor en ${difference.toFixed(4)} unidades`
      : difference < 0
        ? `La distancia EDO es mayor en ${Math.abs(difference).toFixed(4)} unidades`
        : "Las distancias son iguales");
    $("comparisonStatus").textContent = difference > 0 ? "EDO quedó más cerca de esta referencia" :
      difference < 0 ? "EDO quedó más lejos de esta referencia" : "Las distancias son iguales";
  }
  const notes = [];
  notes.push("MediaPipe + EDO controla el reconocimiento; la rama MediaPipe sin filtro solo se calcula para comparar.");
  notes.push("Ambas ramas usan el mismo cuadro y el mismo ejemplo guardado; la distancia no mide exactitud.");
  if (!requested) notes.push("La candidata no confirma la intención del usuario.");
  if (!requested && result.rawPrediction?.label && result.filteredPrediction?.label &&
      result.rawPrediction.label !== result.filteredPrediction.label){
    notes.push(`Las ramas discrepan: sin EDO predice “${result.rawPrediction.label}” y con EDO “${result.filteredPrediction.label}”.`);
  }
  if (result.legacyReference){
    notes.push("La referencia incluye ejemplos heredados de manos sin datos faciales; vuelve a capturarlos si quieres añadir rostro o ambas manos.");
  }
  if (result.referenceFilterMismatch){
    notes.push("Algunas referencias heredadas o no regenerables se conservan cuando es posible, pero su procesamiento histórico no se puede verificar y no permite una comparación experimental justa. Vuelve a capturarlas para generar referencias coherentes.");
  }
  notes.push("Una reducción de distancia no garantiza un reconocimiento correcto.");
  $("comparisonNote").textContent = notes.join(" ");
}
function updateComparison(comparison){
  lastComparison = comparison;
  renderComparison();
}
function updateTrackingMetrics(metrics){
  $("vibrationReduction").textContent = metrics.vibrationReduction == null
    ? "No calculable" : `${metrics.vibrationReduction.toFixed(1)}%`;
  $("vibrationDistances").textContent = metrics.rawVibration == null || metrics.filteredVibration == null
    ? "Esperando un segmento quieto"
    : `${metrics.rawVibration.toFixed(5)} / ${metrics.filteredVibration.toFixed(5)} longitudes de palma/cuadro`;
  $("trackingLag").textContent = metrics.lagMs == null
    ? "No calculable" : `${metrics.lagMs.toFixed(0)} ms · estimación`;
  const assessment = $("stabilityAssessment");
  assessment.textContent = metrics.rawVibration == null || metrics.filteredVibration == null
    ? "Sin datos suficientes para comparar estabilidad"
    : metrics.filteredVibration < metrics.rawVibration
      ? "EDO mejora la estabilidad observada en este segmento"
      : metrics.filteredVibration > metrics.rawVibration
        ? "EDO empeora la estabilidad observada en este segmento"
        : "Sin cambio medible de estabilidad en este segmento";
  $("trackingMetricNote").textContent = metrics.note;
}

function clearForUser(){
  state.phrase = "";
  phraseEl.textContent = "";
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  $("label").value = "";
  $("trainProgressLabel").textContent = "Listo para capturar";
  $("trainProgressCount").textContent = "";
  $("trainBar").style.width = "0";
  $("trainBar").parentElement.setAttribute("aria-valuemax",
    String(Number($("dur").value) * 1000));
  $("trainBar").parentElement.setAttribute("aria-valuenow", "0");
  $("trainHint").textContent = "El sistema analizará una secuencia y elegirá automáticamente la representación adecuada.";
  state.cand = null;
  state.candCount = 0;
  state.candSince = null;
  state.committed = null;
  state.noHand = 0;
  state.noHandSince = null;
  state.neutralSince = null;
  state.recognitionEnabled = false;
  state.lastRecognitionLabel = null;
  state.lastRecognitionAt = 0;
  signEl.textContent = "Sin mano";
  signEl.className = "sign idle";
  metaEl.textContent = "";
  holdBar.style.width = "0";
  setNote("");
  renderList();
  setEvaluationEnabled(true);
  updateComparison({ detected: false });
}

/* ---------- Lectura en pantalla ---------- */
function showLocked(text, meta, ok, ms = 2500){
  signEl.textContent = text; signEl.className = "sign" + (ok ? "" : " idle"); metaEl.textContent = meta || "";
  state.readoutLock = performance.now() + ms;
}
function show(r){
  if (performance.now() < state.readoutLock) return;
  if (r?.reason === "ambiguous"){
    signEl.textContent = "Reconocimiento ambiguo";
    signEl.className = "sign idle";
    metaEl.textContent = r.candidates?.length
      ? `Candidatas: ${r.candidates.join(" / ")}` : "";
    return;
  }
  if (!r){ signEl.textContent = "Seña no reconocida"; signEl.className = "sign idle"; metaEl.textContent = ""; return; }
  signEl.textContent = r.label; signEl.className = "sign";
  metaEl.textContent = r.src + (r.conf != null
    ? ` · Puntuación del reconocedor: ${Math.round(r.conf * 100)}% (no es probabilidad validada)` : "");
}
function showNoHand(){
  if (performance.now() < state.readoutLock) return;
  signEl.textContent = "Sin mano"; signEl.className = "sign idle"; metaEl.textContent = "";
}


return { setNote, stability, lostHand, addToPhrase, renderList, showLocked, show, showNoHand,
  updateComparison, updateTrackingMetrics, setEvaluationEnabled, refreshReferences, refreshFilterControls,
  updateCoordinateTrace, setSyncStatus, clearForUser, refreshGeneralControls, refreshAmbiguityControls };
}

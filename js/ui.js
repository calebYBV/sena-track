import { calculateDistanceReduction } from "./recognition.js";
import { countUniqueCaptures } from "./sampleCount.js";

export function createUI({ state, dom, savePreferences, deleteSign }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const HOLD = 15, CAPTURE_FRAMES = 40;
let lastComparison = null;
function setNote(t){ noteEl.textContent = t; }
function setSyncStatus(text, status = "saved"){
  const element = $("syncStatus");
  element.textContent = text;
  element.dataset.state = status;
  $("syncRetry").hidden = status !== "error" && status !== "pending";
}

function stability(r){
  state.noHand = 0;
  const label = r ? r.label : null;
  if (label !== state.cand){ state.cand = label; state.candCount = 0; }
  state.candCount++;
  holdBar.style.width = label ? Math.min(100, state.candCount / HOLD * 100) + "%" : "0";
  if (label && state.candCount === HOLD && label !== state.committed){
    state.committed = label;
    addToPhrase(label);
  }
}
function lostHand(){
  if (++state.noHand > 8){ state.committed = null; state.cand = null; state.candCount = 0; return true; }
  holdBar.style.width = "0";
  return false;
}
function addToPhrase(label){
  if (label.length === 1) state.phrase += label;
  else state.phrase += (state.phrase && !state.phrase.endsWith(" ") ? " " : "") + label + " ";
  phraseEl.textContent = state.phrase;
  if ($("speechEnabled").checked &&
      document.querySelector('input[name="speechMode"]:checked')?.value === "automatic"){
    speakText(label);
  }
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
  const groups = {};
  state.samples.forEach(s => { const k = "s|" + s.l; (groups[k] ||= { l: s.l, t: "s", n: 0 }).n++; });
  state.motions.forEach(m => { const k = "m|" + m.l; (groups[k] ||= { l: m.l, t: "m", n: 0 }).n++; });
  listEl.innerHTML = "";
  const items = Object.values(groups);
  if (!items.length){
    listEl.innerHTML = '<li class="empty" style="background:none;padding:0">Tu biblioteca está vacía. Registra tu primera seña</li>';
    refreshReferences();
    return;
  }
  items.forEach(g => {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "sign-info";
    const icon = document.createElement("span");
    icon.className = `sign-thumbnail ${g.t === "m" ? "motion" : ""}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = g.t === "m" ? "↔" : "◇";
    const name = document.createElement("span"); name.className = "name"; name.textContent = g.l;
    const examples = g.t === "s" ? state.samples : state.motions;
    const hasLegacy = examples.some(example => example.l === g.l && !example.components);
    const tag = document.createElement("span"); tag.className = "tag " + g.t + (hasLegacy ? " legacy" : "");
    const hasPending = examples.some(example => example.l === g.l && example.syncStatus === "pending");
    tag.textContent = (g.t === "s" ? "Fija" : "Movimiento") +
      (hasLegacy ? " · antigua, solo manos" : "") + (hasPending ? " · pendiente" : "");
    const cnt = document.createElement("span"); cnt.className = "count-txt";
    const captureCount = countUniqueCaptures(examples);
    cnt.textContent = g.t === "s"
      ? `${captureCount} capturas`
      : `${captureCount} grabaciones`;
    const b = document.createElement("button"); b.className = "btn line"; b.textContent = "Borrar";
    b.onclick = () => {
      void deleteSign(g.l, g.t).catch(error => {
        console.error("No se pudo eliminar la seña.", error);
        setSyncStatus(`No se pudo preparar la eliminación: ${error.message}`, "error");
      });
    };
    li.className = "sign-item";
    info.append(name, tag, cnt);
    li.append(icon, info, b); listEl.appendChild(li);
  });
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
  $("offDescription").hidden = config.model !== "off";
  $("firstCalculation").hidden = config.model !== "first";
  $("secondCalculation").hidden = config.model !== "second";
  $("offCalculation").hidden = config.model !== "off";
  $("activeModelName").textContent = config.model === "first" ? "Filtro de primer orden" :
    config.model === "second" ? "Modelo de segundo orden amortiguado" : "Filtro EDO desactivado";
  $("settingsModelName").textContent = $("activeModelName").textContent;
  $("filterModelDescription").textContent = config.model === "first"
    ? "Acerca gradualmente las coordenadas filtradas a las mediciones de MediaPipe para reducir vibraciones y saltos."
    : config.model === "second"
      ? "Considera la posición y la velocidad del punto filtrado para ajustar cómo acelera o frena al seguir las mediciones."
      : "Desactivado: coordenadas directas de MediaPipe, sin filtro adicional de la aplicación.";
  $("rawBranchLabel").textContent = "Sin EDO";
  $("filteredBranchLabel").textContent = config.model === "off" ? "Con EDO (desactivado)" : "Con EDO";
}
for (const [id, key] of filterControls){
  const update = persist => {
    const element = $(id);
    state.filterConfig[key] = id === "compareVisual" ? element.checked :
      (key === "model" ? element.value : Number(element.value));
    refreshFilterControls();
    state.onFilterChange?.();
    if (persist) void savePreferences();
  };
  if (id === "filterTau" || id === "filterZeta" || id === "filterOmega"){
    $(id).addEventListener("input", () => update(false));
    $(id).addEventListener("change", () => update(true));
  } else $(id).addEventListener("change", () => update(true));
}
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
  return prediction?.label || "No identificada";
}
function renderComparison(){
  if ($("evaluationPanel").getAttribute("aria-disabled") === "true") return;
  const result = lastComparison;
  const reductionReadout = $("distanceReduction").parentElement;
  reductionReadout.classList.remove("is-positive", "is-negative", "is-neutral");
  reductionReadout.setAttribute("aria-label", "Reducción de distancia no disponible");
  $("rawPrediction").textContent = predictionText(result?.rawPrediction);
  $("filteredPrediction").textContent = predictionText(result?.filteredPrediction);
  $("rawDistance").textContent = "—";
  $("filteredDistance").textContent = "—";
  $("distanceReduction").textContent = "No disponible";
  if (!result?.detected){
    const requested = $("evaluationReference").value;
    $("referenceLabel").textContent = requested ? `Seña seleccionada: ${requested}` : "Referencia candidata: uso libre";
    $("comparisonStatus").textContent = "Muestra las partes requeridas para comparar.";
    $("comparisonNote").textContent = "La salida sin EDO es la de MediaPipe y puede incluir procesamiento interno.";
    return;
  }
  if (result.reason){
    $("comparisonStatus").textContent = "Comparación no disponible";
    $("comparisonNote").textContent = result.reason;
    return;
  }
  const requested = $("evaluationReference").value;
  const mainPrediction = state.filterConfig.model === "off" ? result.rawPrediction : result.filteredPrediction;
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
    $("comparisonStatus").textContent = "Guarda ejemplos de esta seña para calcular la comparación.";
    $("comparisonNote").textContent = requested
      ? "No hay ejemplos guardados de la seña seleccionada en esta modalidad."
      : "La candidata no confirma la intención del usuario.";
    return;
  }
  const reduction = calculateDistanceReduction(rawDistance, filteredDistance);
  if (reduction === null){
    $("distanceReduction").textContent = "No disponible";
    reductionReadout.classList.add("is-neutral");
    reductionReadout.setAttribute("aria-label", "Reducción de distancia no disponible");
    $("comparisonStatus").textContent = "La comparación no está disponible: la distancia sin EDO es prácticamente cero.";
  } else {
    $("distanceReduction").textContent = `${reduction.toFixed(1)}%`;
    reductionReadout.classList.add(reduction > 0 ? "is-positive" : reduction < 0 ? "is-negative" : "is-neutral");
    reductionReadout.setAttribute("aria-label", reduction > 0
      ? `EDO acercó a la referencia: ${reduction.toFixed(1)} por ciento`
      : reduction < 0
        ? `EDO alejó de la referencia: ${reduction.toFixed(1)} por ciento`
        : "EDO no cambió la distancia a la referencia");
    $("comparisonStatus").textContent = reduction > 0 ? "EDO acercó a la referencia" :
      reduction < 0 ? "EDO alejó de la referencia" : "EDO no cambió la distancia";
  }
  const notes = [];
  notes.push("Raw y EDO se comparan con el mismo ejemplo guardado; el color indica distancia, no un acierto validado.");
  if (!requested) notes.push("La candidata no confirma la intención del usuario.");
  if (!requested && result.rawPrediction?.label && result.filteredPrediction?.label &&
      result.rawPrediction.label !== result.filteredPrediction.label){
    notes.push(`Las ramas discrepan: sin EDO predice “${result.rawPrediction.label}” y con EDO “${result.filteredPrediction.label}”.`);
  }
  if (result.legacyReference){
    notes.push("La referencia incluye ejemplos heredados de manos sin datos faciales; vuelve a capturarlos si quieres añadir rostro o ambas manos.");
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
  $("trainBar").parentElement.setAttribute("aria-valuemax", "40");
  $("trainBar").parentElement.setAttribute("aria-valuenow", "0");
  $("trainHint").textContent = "Captura varios cuadros para guardar un ejemplo.";
  state.cand = null;
  state.candCount = 0;
  state.committed = null;
  state.noHand = 0;
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
  setSyncStatus, clearForUser, refreshGeneralControls };
}

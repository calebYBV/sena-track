export function createTraining({ state, dom, ui, storage, recognition }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { setNote, renderList, showLocked, addToPhrase, updateComparison, setEvaluationEnabled } = ui;
const { saveAll } = storage;
const { toSequencePair, classifyMotion, motionDistances } = recognition;
const N_STEPS = 24, CAPTURE_FRAMES = 40;
function setCaptureProgress(label, current, total, detail = ""){
  $("trainProgressLabel").textContent = label;
  $("trainProgressCount").textContent = detail || `${Math.round(current)} / ${Math.round(total)}`;
  const progress = $("trainBar").parentElement;
  progress.setAttribute("aria-valuemax", String(total));
  progress.setAttribute("aria-valuenow", String(Math.min(total, Math.max(0, current))));
  $("trainBar").style.width = `${total > 0 ? Math.min(100, Math.max(0, current / total * 100)) : 0}%`;
}
function startMotion(purpose, label){
  if (!state.ready || state.motion || state.capState) return;
  if (purpose === "recognize" && !state.motions.length){
    setNote("Primero enseña al menos una seña con movimiento (tipo “Con movimiento”).");
    return;
  }
  setNote("");
  if (purpose === "train") setEvaluationEnabled(false);
  if (purpose === "train") setCaptureProgress("Preparando movimiento", 0, parseFloat($("dur").value) * 1000, "0 cuadros");
  state.motion = {
    purpose, label, phase: "count", frames: [], ms: parseFloat($("dur").value) * 1000,
    t0: 0, captureStartedAt: null, capturedAt: new Date().toISOString()
  };
  refreshButtons();
  let n = purpose === "train" ? 3 : 2;
  const step = () => {
    if (!state.motion) return;
    if (n > 0){
      countEl.textContent = n;
      countEl.classList.add("on");
      if (purpose === "train") setCaptureProgress(`Prepárate… ${n}`, 0, state.motion.ms, "0 cuadros");
      n--;
      setTimeout(step, 800);
    }
    else {
      countEl.classList.remove("on");
      state.onRecordingStart?.();
      state.motion.phase = "rec"; state.motion.t0 = performance.now();
      if (purpose === "train") setCaptureProgress("Grabando movimiento", 0, state.motion.ms, "0 cuadros");
      bannerText.textContent = purpose === "train" ? "Grabando “" + label + "”" : "Haz la seña";
      bannerBar.style.width = "0"; bannerEl.classList.add("on");
    }
  };
  step();
}
function tickMotion(res){
  if (state.motion.phase === "count"){ signEl.textContent = "Prepárate"; signEl.className = "sign idle"; metaEl.textContent = ""; return; }
  signEl.textContent = "Grabando…"; signEl.className = "sign"; metaEl.textContent = "";
  if (res){
    state.motion.frames.push({
      rawLm: res.rawLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z })),
      lm: res.filteredLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z })),
      hand: res.handedness[0][0].categoryName,
      time: res.timestamp,
      handCount: res.handCount,
      faceAvailable: res.faceAvailable
    });
    if (state.motion.purpose === "train"){
      const elapsed = Math.min(state.motion.ms, performance.now() - state.motion.t0);
      setCaptureProgress("Grabando movimiento", elapsed, state.motion.ms,
        `${state.motion.frames.length} cuadros`);
    }
  }
  const el = performance.now() - state.motion.t0;
  bannerBar.style.width = Math.min(100, el / state.motion.ms * 100) + "%";
  if (el >= state.motion.ms) finishMotion();
}
function finishMotion(){
  const m = state.motion; state.motion = null;
  bannerEl.classList.remove("on"); countEl.classList.remove("on");
  state.cand = null; state.candCount = 0; state.committed = null; state.noHand = 0; state.readoutLock = 0;
  const pairedFrames = {
    raw: m.frames.map(frame => ({ lm: frame.rawLm, hand: frame.hand, time: frame.time })),
    filtered: m.frames.map(frame => ({ lm: frame.lm, hand: frame.hand, time: frame.time }))
  };
  const sequences = toSequencePair(pairedFrames.raw, pairedFrames.filtered,
    video.videoWidth / video.videoHeight, N_STEPS);
  if (!sequences){
    setNote("No detecté movimiento. Mantén la mano visible y haz la seña un poco más amplia.");
    if (m.purpose === "recognize"){
      updateComparison({ detected: true, reason: "No hubo una secuencia de movimiento suficiente para comparar." });
    } else {
      const elapsed = m.frames.length
        ? Math.min(m.ms, Math.max(0, m.frames.at(-1).time - m.t0))
        : 0;
      setCaptureProgress("Movimiento insuficiente", elapsed, m.ms, `${m.frames.length} cuadros`);
    }
  } else if (m.purpose === "train"){
    const handCounts = m.frames.map(frame => frame.handCount || 1);
    const leftCount = m.frames.filter(frame => frame.hand === "Left").length;
    const captureMeta = {
      handCount: Math.max(1, ...handCounts),
      faceAvailable: m.frames.some(frame => frame.faceAvailable),
      mediapipeModel: `hand_landmarker_float16_v1${m.frames.some(frame => frame.faceAvailable) ? ";face_landmarker_float16_v1" : ""}`,
      coordinateSpace: "mediapipe-normalized-image-v1",
      width: video.videoWidth,
      height: video.videoHeight,
      handedness: leftCount > m.frames.length / 2 ? "Left" : "Right",
      mirroredDisplay: true,
      capturedAt: m.capturedAt
    };
    state.motions.push({ l: m.label, s: sequences.filtered, r: sequences.raw,
      source: "paired-raw-and-filtered-v1", filter: { ...state.filterConfig },
      captureMeta,
      rawFrames: m.frames.map(frame => ({ lm: frame.rawLm.map(point => [point.x, point.y, point.z]),
        hand: frame.hand, time: frame.time })) });
    void saveAll().catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
    renderList();
    const n = state.motions.filter(x => x.l === m.label).length;
    $("trainHint").textContent = `Listo: “${m.label}” guardada (${n} ${n === 1 ? "grabación" : "grabaciones"}). Graba unas 5 veces para que la reconozca mejor.`;
    setCaptureProgress("Captura completada", m.ms, m.ms, `${m.frames.length} cuadros`);
  } else {
    const raw = classifyMotion(sequences.raw, "raw");
    const filtered = classifyMotion(sequences.filtered, "filtered");
    const main = state.filterConfig.model === "off" ? raw : filtered;
    const rawDistances = motionDistances(sequences.raw, "raw");
    const filteredDistances = motionDistances(sequences.filtered, "filtered");
    const ref = $("evaluationReference").value || main?.label;
    const examples = state.motions.filter(example => example.l === ref);
    updateComparison({ kind: "motion", detected: true, rawPrediction: raw, filteredPrediction: filtered,
      rawDistances, filteredDistances, hasReference: examples.length > 0,
      legacyReference: examples.some(example => !example.r || !example.source) });
    if (main){
      const score = main.conf == null ? "" : ` · Puntuación del reconocedor: ${Math.round(main.conf * 100)}% (no es probabilidad validada)`;
      showLocked(main.label, main.src + score, true); addToPhrase(main.label);
    }
    else showLocked("No la reconozco", "", false);
  }
  setEvaluationEnabled(true);
  refreshButtons();
}

/* ---------- Entrenamiento ---------- */
const kind = () => document.querySelector("input[name=kind]:checked").value;
const HINTS = {
  static: "Haz la seña con la mano casi quieta y muévela un poco mientras captura. Repite 2 o 3 veces.",
  motion: "Tras la cuenta regresiva haz el movimiento completo una sola vez. Graba 5 veces o más."
};
function refreshKind(){
  const selectedKind = kind();
  $("btnTrain").textContent = selectedKind === "static" ? "Capturar seña" : "Grabar movimiento";
  $("trainHint").textContent = HINTS[selectedKind];
  if (!state.capState && !state.motion){
    setCaptureProgress(selectedKind === "static" ? "Listo para capturar" : "Listo para grabar",
      0, selectedKind === "static" ? CAPTURE_FRAMES : parseFloat($("dur").value) * 1000, "");
  }
}
document.querySelectorAll("input[name=kind]").forEach(r => r.onchange = refreshKind);

function refreshButtons(){
  const busy = !state.ready || !!(state.motion || state.capState);
  $("btnTrain").disabled = busy;
  $("btnMotion").disabled = busy;
  document.querySelectorAll('input[name="kind"]').forEach(input => { input.disabled = busy; });
}
function capture(f){
  if (state.capState.phase !== "rec") return;
  state.capState.captured.push({
    l: state.capState.label,
    f: f.filtered.map(v => +v.toFixed(4)),
    r: f.raw.map(v => +v.toFixed(4)),
    lm: f.rawLandmarks.map(point => [point.x, point.y, point.z]),
    t: f.time,
    source: "paired-raw-and-filtered-v1",
    filter: { ...state.filterConfig },
    captureId: state.capState.captureId,
    captureTimeMs: f.time - state.capState.startedAt,
    captureMeta: {
      handCount: f.handCount,
      faceAvailable: f.faceAvailable,
      mediapipeModel: `hand_landmarker_float16_v1${f.faceAvailable ? ";face_landmarker_float16_v1" : ""}`,
      coordinateSpace: "mediapipe-normalized-image-v1",
      width: video.videoWidth,
      height: video.videoHeight,
      handedness: f.handedness,
      mirroredDisplay: true,
      capturedAt: state.capState.capturedAt
    }
  });
  state.capState.left--;
  const captured = CAPTURE_FRAMES - state.capState.left;
  setCaptureProgress("Capturando seña", captured, CAPTURE_FRAMES);
  if (state.capState.left <= 0){
    state.samples.push(...state.capState.captured);
    void saveAll().catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
    renderList();
    $("trainHint").textContent = `Listo: “${state.capState.label}” guardada. Repite para mejorar la precisión o enseña otra seña.`;
    setCaptureProgress("Captura completada", CAPTURE_FRAMES, CAPTURE_FRAMES);
    state.capState = null; refreshButtons();
    setEvaluationEnabled(true);
  }
}
function resetTracking(){
  if (state.motion?.phase === "rec"){
    state.motion.frames = [];
    state.motion.t0 = performance.now();
    bannerBar.style.width = "0";
  }
  if (state.capState?.phase === "rec"){
    state.capState.captured = [];
    state.capState.left = CAPTURE_FRAMES;
    setCaptureProgress("Se perdió la mano; reiniciando", 0, CAPTURE_FRAMES);
    $("trainHint").textContent = "Se perdió la mano; reiniciando la captura.";
  }
}
$("btnTrain").onclick = () => {
  if (!state.ready || state.motion || state.capState) return;
  const label = $("label").value.trim();
  if (!label){ $("trainHint").textContent = "Escribe primero el nombre de la seña."; $("label").focus(); return; }
  if (kind() === "motion"){ startMotion("train", label); return; }
  setCaptureProgress("Preparando captura", 0, CAPTURE_FRAMES);
  state.capState = {
    label, phase: "count", left: CAPTURE_FRAMES, captured: [],
    captureId: crypto.randomUUID(), startedAt: 0, capturedAt: null
  };
  setEvaluationEnabled(false);
  $("btnTrain").disabled = true;
  $("btnMotion").disabled = true;
  let n = 3;
  const tick = () => {
    if (!state.capState) return;
    if (n > 0){
      $("trainHint").textContent = `Prepara la mano… ${n}`;
      setCaptureProgress(`Prepárate… ${n}`, 0, CAPTURE_FRAMES);
      n--;
      setTimeout(tick, 800);
    }
    else {
      state.onRecordingStart?.();
      $("trainHint").textContent = "Capturando… muévela un poco.";
      setCaptureProgress("Capturando seña", 0, CAPTURE_FRAMES);
      state.capState.startedAt = performance.now();
      state.capState.capturedAt = new Date().toISOString();
      state.capState.phase = "rec";
    }
  };
  tick();
};
$("btnMotion").onclick = () => startMotion("recognize");
document.addEventListener("keydown", e => {
  if (e.code === "Space" && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.target.tagName)){
    e.preventDefault(); startMotion("recognize");
  }
});


return { startMotion, tickMotion, capture, refreshKind, refreshButtons, resetTracking };
}

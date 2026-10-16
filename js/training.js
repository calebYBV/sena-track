import { extractHolisticFeatures } from "./holistic.js";
import { SAMPLE_FORMAT_VERSION } from "./sampleFormat.js";

export function createTraining({ state, dom, ui, storage, recognition }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { setNote, renderList, showLocked, addToPhrase, updateComparison, setEvaluationEnabled } = ui;
const { saveAll } = storage;
const { toSequencePair, classifyFrame, holisticDistances, meanDescriptors,
  resampleDescriptors } = recognition;
const N_STEPS = 24, CAPTURE_FRAMES = 40;
const components = () => ({
  left: $("requireLeft").checked,
  right: $("requireRight").checked,
  face: $("requireFace").checked
});
function hasRequiredParts(presence, required){
  return (!required.left || presence.Left) &&
    (!required.right || presence.Right) &&
    (!required.face || presence.face && presence.faceFeatures);
}
function asStoredFrame(frame, time, presence){
  const hands = {};
  for (const side of ["Left", "Right"]){
    if (presence[side] && frame.hands[side]){
      hands[side] = frame.hands[side].map(({ x, y, z }) => [x, y, z]);
    }
  }
  const stored = { time, presence: { ...presence }, hands };
  if (presence.face){
    stored.faceLandmarks = frame.faceLandmarks.map(({ x, y, z }) => [x, y, z]);
  }
  if (presence.faceFeatures){
    stored.faceFeatures = frame.faceFeatures.slice();
  }
  return stored;
}
function legacyMotionPair(frames, aspect){
  const counts = new Map();
  for (const frame of frames){
    if (frame.rawLm && frame.hand) counts.set(frame.hand, (counts.get(frame.hand) || 0) + 1);
  }
  const hand = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!hand) return null;
  const raw = frames.filter(frame => frame.rawLm && frame.hand === hand)
    .map(frame => ({ lm: frame.rawLm, hand, time: frame.time }));
  const filtered = frames.filter(frame => frame.lm && frame.hand === hand)
    .map(frame => ({ lm: frame.lm, hand, time: frame.time }));
  if (raw.length < 8 || filtered.length !== raw.length) return null;
  return toSequencePair(raw, filtered, aspect, N_STEPS);
}
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
  if (purpose === "recognize" && !state.motions.some(sample => sample.syncStatus !== "pending")){
    setNote("Primero enseña al menos una seña con movimiento (tipo “Con movimiento”).");
    return;
  }
  setNote("");
  if (purpose === "train") setEvaluationEnabled(false);
  if (purpose === "train") setCaptureProgress("Preparando movimiento", 0, parseFloat($("dur").value) * 1000, "0 cuadros");
  state.motion = {
    purpose, label, phase: "count", frames: [], ms: parseFloat($("dur").value) * 1000,
    t0: 0, captureStartedAt: null, capturedAt: new Date().toISOString(),
    components: purpose === "train" ? components() : null
  };
  if (purpose === "train" && !state.motion.components.left &&
      !state.motion.components.right && !state.motion.components.face){
    state.motion = null;
    setNote("Selecciona al menos una mano o el rostro como componente requerido.");
    return;
  }
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
  const missingTrainingParts = state.motion.purpose === "train" &&
    (!res || !hasRequiredParts(res.presence, state.motion.components));
  if (missingTrainingParts){
    signEl.textContent = "Mano o rostro requerido fuera de cámara";
    signEl.className = "sign idle";
    metaEl.textContent = "";
    setNote("Mano o rostro requerido fuera de cámara");
  } else {
    signEl.textContent = "Grabando…"; signEl.className = "sign"; metaEl.textContent = "";
  }
  if (!res) state.motion.incomplete = true;
  if (res){
    state.motion.frames.push({
      rawFrame: res.rawFrame,
      filteredFrame: res.filteredFrame,
      presence: res.presence,
      rawLm: res.rawLandmarks?.map(p => ({ x: p.x, y: p.y, z: p.z })),
      lm: res.filteredLandmarks?.map(p => ({ x: p.x, y: p.y, z: p.z })),
      hand: res.hand,
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
  const required = m.components;
  const captureComplete = !m.incomplete && m.frames.length >= 8 &&
    (!required || m.frames.every(frame => hasRequiredParts(frame.presence, required)));
  const aspect = video.videoWidth / video.videoHeight;
  const rawSequence = required && captureComplete
    ? m.frames.map(frame => extractHolisticFeatures(frame.rawFrame, aspect, required)) : [];
  const filteredSequence = required && captureComplete
    ? m.frames.map(frame => extractHolisticFeatures(frame.filteredFrame, aspect, required)) : [];
  const sequenceValid = rawSequence.length >= 8 && rawSequence.every(Boolean) && filteredSequence.every(Boolean);
  if (m.purpose === "train" && sequenceValid){
    const handCounts = m.frames.map(frame => frame.handCount || 0);
    const leftCount = m.frames.filter(frame => frame.hand === "Left").length;
    const captureMeta = {
      handCount: Math.max(0, ...handCounts),
      faceAvailable: m.frames.some(frame => frame.faceAvailable),
      mediapipeModel: `hand_landmarker_float16_v1${m.frames.some(frame => frame.faceAvailable) ? ";face_landmarker_float16_v1;face-blendshapes-v1" : ""}`,
      coordinateSpace: "mediapipe-normalized-image-v1",
      width: video.videoWidth,
      height: video.videoHeight,
      handedness: required.left && !required.right ? "Left" : required.right && !required.left ? "Right" : null,
      mirroredDisplay: true,
      capturedAt: m.capturedAt
    };
    const storedFrames = field => m.frames.map(frame =>
      asStoredFrame(frame[field], frame.time - m.t0, frame.presence));
    const sample = {
      l: m.label, kind: "motion", formatVersion: SAMPLE_FORMAT_VERSION,
      components: required, source: "paired-raw-and-filtered-v2",
      filter: { ...state.filterConfig }, captureMeta,
      rawFrames: storedFrames("rawFrame"), filteredFrames: storedFrames("filteredFrame"),
      rawHolisticSequence: resampleDescriptors(rawSequence, N_STEPS,
        m.frames.map(frame => frame.time - m.t0)),
      filteredHolisticSequence: resampleDescriptors(filteredSequence, N_STEPS,
        m.frames.map(frame => frame.time - m.t0)),
      syncStatus: "pending"
    };
    const legacyPair = legacyMotionPair(m.frames, aspect);
    if (legacyPair){ sample.s = legacyPair.filtered; sample.r = legacyPair.raw; }
    state.motions.push(sample);
    void saveAll().then(saved => {
      $("trainHint").textContent = saved
        ? `Listo: “${m.label}” guardada en Supabase. Graba unas 5 veces para mejorar la comparación.`
        : `“${m.label}” pendiente de sincronización; todavía no se usa para reconocer.`;
      renderList();
    }).catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
    renderList();
    $("trainHint").textContent = `Captura lista para guardar “${m.label}”.`;
    setCaptureProgress("Captura completada", m.ms, m.ms, `${m.frames.length} cuadros`);
  } else if (m.purpose === "recognize" && captureComplete){
    const rawFrame = {
      rawFrames: m.frames.map(frame => frame.rawFrame),
      filteredFrames: m.frames.map(frame => frame.filteredFrame),
      rawLegacySequence: null, filteredLegacySequence: null
    };
    const pair = legacyMotionPair(m.frames, aspect);
    if (pair){
      rawFrame.rawLegacySequence = pair.raw;
      rawFrame.filteredLegacySequence = pair.filtered;
    }
    const raw = classifyFrame(rawFrame, "raw", "motion");
    const filtered = classifyFrame(rawFrame, "filtered", "motion");
    const main = state.filterConfig.model === "off" ? raw : filtered;
    const rawDistances = holisticDistances(rawFrame, "raw", "motion");
    const filteredDistances = holisticDistances(rawFrame, "filtered", "motion");
    const ref = $("evaluationReference").value || main?.label;
    const examples = state.motions.filter(example => example.l === ref);
    updateComparison({ kind: "motion", detected: true, rawPrediction: raw, filteredPrediction: filtered,
      rawDistances, filteredDistances, hasReference: examples.length > 0,
      legacyReference: examples.some(example => !example.components) });
    if (main){
      const score = main.conf == null ? "" : ` · Puntuación del reconocedor: ${Math.round(main.conf * 100)}% (no es probabilidad validada)`;
      showLocked(main.label, main.src + score, true); addToPhrase(main.label);
    } else {
      const missingParts = m.incomplete || m.frames.some(frame =>
        state.motions.some(sample => sample.components &&
          !hasRequiredParts(frame.presence, sample.components)));
      const message = missingParts
        ? "Mano o rostro requerido fuera de cámara" : "Seña no reconocida";
      if (missingParts) setNote(message);
      showLocked(message, "", false);
    }
  } else {
    const missingParts = m.incomplete || (required
      ? m.frames.some(frame => !hasRequiredParts(frame.presence, required))
      : m.frames.some(frame => state.motions.some(sample => sample.components &&
        !hasRequiredParts(frame.presence, sample.components))));
    setNote(missingParts
      ? "Mano o rostro requerido fuera de cámara"
      : "No se capturó una secuencia sincronizada suficiente; seña no reconocida.");
    if (m.purpose === "recognize"){
      const message = missingParts ? "Mano o rostro requerido fuera de cámara" : "Seña no reconocida";
      updateComparison({ detected: true, reason: missingParts ? message : undefined });
      showLocked(message, "", false);
    } else {
      setCaptureProgress("Captura incompleta", 0, m.ms, `${m.frames.length} cuadros`);
    }
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
  const required = components();
  $("trainHint").textContent = selectedKind === "static" && required.face &&
    !required.left && !required.right
    ? "Mantén la cabeza en cuadro y realiza la expresión que define la seña."
    : selectedKind === "static" && required.face
      ? "Mantén en cuadro las manos y el rostro; realiza la configuración y expresión de la seña."
      : HINTS[selectedKind];
  if (!state.capState && !state.motion){
    setCaptureProgress(selectedKind === "static" ? "Listo para capturar" : "Listo para grabar",
      0, selectedKind === "static" ? CAPTURE_FRAMES : parseFloat($("dur").value) * 1000, "");
  }
}
document.querySelectorAll("input[name=kind]").forEach(r => r.onchange = refreshKind);
for (const id of ["requireLeft", "requireRight", "requireFace"]){
  $(id).addEventListener("change", refreshKind);
}

function refreshButtons(){
  const busy = !state.ready || !!(state.motion || state.capState);
  $("btnTrain").disabled = busy;
  $("btnMotion").disabled = busy;
  document.querySelectorAll('input[name="kind"]').forEach(input => { input.disabled = busy; });
  for (const id of ["requireLeft", "requireRight", "requireFace"]) $(id).disabled = busy;
}
function capture(f){
  if (state.capState.phase !== "rec") return;
  const capture = state.capState;
  if (!hasRequiredParts(f.presence, capture.components)){
    capture.rawFrames = [];
    capture.filteredFrames = [];
    capture.rawDescriptors = [];
    capture.filteredDescriptors = [];
    capture.startedAt = f.time;
    capture.left = CAPTURE_FRAMES;
    setCaptureProgress("Falta un componente requerido", 0, CAPTURE_FRAMES);
    setNote("Mano o rostro requerido fuera de cámara");
    return;
  }
  capture.rawFrames ||= [];
  capture.filteredFrames ||= [];
  capture.rawDescriptors ||= [];
  capture.filteredDescriptors ||= [];
  capture.rawFrames.push(asStoredFrame(f.rawFrame, f.time - capture.startedAt, f.presence));
  capture.filteredFrames.push(asStoredFrame(f.filteredFrame, f.time - capture.startedAt, f.presence));
  const aspect = video.videoWidth / video.videoHeight;
  capture.rawDescriptors.push(extractHolisticFeatures(f.rawFrame, aspect, capture.components));
  capture.filteredDescriptors.push(extractHolisticFeatures(f.filteredFrame, aspect, capture.components));
  state.capState.left--;
  const captured = CAPTURE_FRAMES - state.capState.left;
  setCaptureProgress("Capturando seña", captured, CAPTURE_FRAMES);
  if (state.capState.left <= 0){
    const sample = {
      l: capture.label,
      kind: "static",
      formatVersion: SAMPLE_FORMAT_VERSION,
      components: capture.components,
      h: recognition.meanDescriptors(capture.filteredDescriptors),
      rh: recognition.meanDescriptors(capture.rawDescriptors),
      rawFrames: capture.rawFrames,
      filteredFrames: capture.filteredFrames,
      source: "paired-raw-and-filtered-v2",
      filter: { ...state.filterConfig },
      captureMeta: {
        handCount: Math.max(...capture.rawFrames.map(frame =>
          Number(frame.presence.Left) + Number(frame.presence.Right))),
        faceAvailable: capture.rawFrames.some(frame => frame.presence.face),
        mediapipeModel: `hand_landmarker_float16_v1${capture.components.face ? ";face_landmarker_float16_v1;face-blendshapes-v1" : ""}`,
        coordinateSpace: "mediapipe-normalized-image-v1",
        width: video.videoWidth,
        height: video.videoHeight,
        handedness: capture.components.left && !capture.components.right ? "Left" :
          capture.components.right && !capture.components.left ? "Right" : null,
        mirroredDisplay: true,
        capturedAt: capture.capturedAt
      },
      syncStatus: "pending"
    };
    state.samples.push(sample);
    void saveAll().then(saved => {
      $("trainHint").textContent = saved
        ? `Listo: “${capture.label}” guardada en Supabase.`
        : `“${capture.label}” pendiente de sincronización; todavía no se usa para reconocer.`;
      renderList();
    }).catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
    renderList();
    $("trainHint").textContent = `Captura lista para guardar “${capture.label}”.`;
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
    state.capState.rawFrames = [];
    state.capState.filteredFrames = [];
    state.capState.rawDescriptors = [];
    state.capState.filteredDescriptors = [];
    state.capState.left = CAPTURE_FRAMES;
    state.capState.startedAt = performance.now();
    setCaptureProgress("Se perdió un componente; reiniciando", 0, CAPTURE_FRAMES);
    $("trainHint").textContent = "Se perdió un componente requerido; reiniciando la captura.";
    setNote("Mano o rostro requerido fuera de cámara");
  }
}
$("btnTrain").onclick = () => {
  if (!state.ready || state.motion || state.capState) return;
  const label = $("label").value.trim();
  if (!label){ $("trainHint").textContent = "Escribe primero el nombre de la seña."; $("label").focus(); return; }
  const required = components();
  if (!required.left && !required.right && !required.face){
    $("trainHint").textContent = "Selecciona al menos una mano o el rostro como componente requerido.";
    return;
  }
  if (kind() === "motion"){ startMotion("train", label); return; }
  setCaptureProgress("Preparando captura", 0, CAPTURE_FRAMES);
  state.capState = {
    label, phase: "count", left: CAPTURE_FRAMES, captured: [], components: required,
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

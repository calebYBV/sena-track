import { extractHolisticFeatures } from "./holistic.js";
import {
  isCurrentRecognitionResult,
  isRecognitionActive,
  resetRecognitionForFilterChange,
  selectActivePrediction,
  selectUnifiedPrediction
} from "./recognitionState.js";
import { SAMPLE_FORMAT_VERSION } from "./sampleFormat.js";
import { analyzeUnifiedCapture } from "./unifiedCapture.js";

export function createTraining({ state, dom, ui, storage, recognition }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { setNote, renderList, showLocked, addToPhrase, updateComparison, setEvaluationEnabled } = ui;
const { saveAll } = storage;
const { toSequencePair, classifyFrame, meanDescriptors,
  holisticMotionSequence } = recognition;
const N_STEPS = 24;

function clearRecognitionTimers(){
  for (const timer of state.recognitionTimers){ clearTimeout(timer); }
  state.recognitionTimers.clear();
}

function scheduleRecognitionTimeout(callback, delay){
  const timer = setTimeout(() => {
    state.recognitionTimers.delete(timer);
    callback();
  }, delay);
  state.recognitionTimers.add(timer);
}

function setRecognitionEnabled(enabled){
  state.recognitionEnabled = !!enabled;
  if (!state.recognitionEnabled){
    clearRecognitionTimers();
    state.motion = null;
    state.cand = null; state.candCount = 0; state.committed = null;
    state.candSince = null; state.neutralSince = null; state.noHandSince = null;
    state.readoutLock = 0;
  }
}
function filterMetadata(config){
  return {
    ...config,
    method: config.model === "first" ? "explicit-euler-substeps-tau-quarter" :
      config.model === "second" ? "semi-implicit-euler-substeps-conservative" : "disabled",
    version: 1
  };
}
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
  setNote("");
  if (purpose === "recognize"){
    state.recognitionEnabled = true;
    state.motion = {
      purpose, phase: "rec", frames: [], lastEvaluatedAt: 0, lastComparedAt: 0,
      armed: true, unrecognizedSince: 0, segmentActive: false
    };
    refreshButtons();
    state.readoutLock = 0;
    signEl.textContent = "Reconocimiento activo";
    signEl.className = "sign idle";
    metaEl.textContent = "Señas estáticas, dinámicas y faciales habilitadas.";
    return;
  }
  if (purpose === "train") setEvaluationEnabled(false);
  if (purpose === "train") setCaptureProgress("Preparando movimiento", 0, parseFloat($("dur").value) * 1000, "0 cuadros");
  state.motion = {
    purpose, label, phase: "count", frames: [], ms: parseFloat($("dur").value) * 1000,
    t0: 0, captureStartedAt: null, captureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    components: purpose === "train" ? components() : null
  };
  if (purpose === "train" && !state.motion.components.left &&
      !state.motion.components.right && !state.motion.components.face){
    state.motion = null;
    setNote("Selecciona al menos una mano o el rostro como componente requerido.");
    return;
  }
  refreshButtons();
  let n = 3;
  const step = () => {
    if (!state.motion) return;
    if (n > 0){
      countEl.textContent = n;
      countEl.classList.add("on");
      setCaptureProgress(`Prepárate… ${n}`, 0, state.motion.ms, "0 cuadros");
      n--;
      scheduleRecognitionTimeout(step, 800);
    }
    else {
      countEl.classList.remove("on");
      state.onRecordingStart?.();
      state.motion.phase = "rec"; state.motion.t0 = performance.now();
      setCaptureProgress("Grabando movimiento", 0, state.motion.ms, "0 cuadros");
      bannerText.textContent = "Grabando “" + label + "”";
      bannerBar.style.width = "0"; bannerEl.classList.add("on");
    }
  };
  step();
}
function recognizeMotion(res){
  const motion = state.motion;
  const generation = res?.recognitionGeneration ?? state.recognitionGeneration;
  if (!isCurrentRecognitionResult(state, generation)) return;
  if (!res){
    motion.frames = [];
    motion.lastEvaluatedAt = 0;
    motion.segmentActive = false;
    motion.unrecognizedSince ||= performance.now();
    ui.stability(null, performance.now(), generation);
    signEl.textContent = "Esperando una seña";
    signEl.className = "sign idle";
    metaEl.textContent = "";
    return;
  }
  const lastFrame = motion.frames.at(-1);
  if (lastFrame && res.timestamp - lastFrame.time > 250){
    motion.frames = [];
    motion.lastEvaluatedAt = 0;
    motion.segmentActive = false;
  }
  motion.frames.push({
    rawFrame: res.rawFrame,
    filteredFrame: res.filteredFrame,
    rawLm: res.rawLandmarks?.map(point => ({ x: point.x, y: point.y, z: point.z })),
    lm: res.filteredLandmarks?.map(point => ({ x: point.x, y: point.y, z: point.z })),
    hand: res.hand,
    time: res.timestamp
  });
  const aspect = video.videoWidth / video.videoHeight;
  const evaluationTime = res.timestamp;
  const analysisInterval = motion.armed ? 180 : 100;
  const comparisonDue = res.timestamp - motion.lastComparedAt >= 200;
  let staticRaw = null, staticFiltered = null;
  let staticMain;
  if (comparisonDue){
    staticRaw = classifyFrame(res.rawFrame, "raw", "static");
    staticFiltered = classifyFrame(res.filteredFrame, "filtered", "static");
    staticMain = selectActivePrediction(staticFiltered);
  } else {
    staticMain = classifyFrame(res.filteredFrame, "filtered", "static");
  }
  if (res.timestamp - motion.lastEvaluatedAt < analysisInterval){
    if (!motion.segmentActive) ui.stability(staticMain, evaluationTime, generation);
    return;
  }
  motion.lastEvaluatedAt = res.timestamp;
  if (comparisonDue){
    motion.lastComparedAt = res.timestamp;
    const { rawDistances: staticRawDistances, filteredDistances: staticFilteredDistances } =
      recognition.pairedHolisticDistances({
        rawFrame: res.rawFrame,
        filteredFrame: res.filteredFrame
      }, "static");
    const staticReference = $("evaluationReference").value || staticMain?.label;
    const staticExamples = state.samples.filter(example => example.l === staticReference);
    updateComparison({
      kind: "static", detected: true, rawPrediction: staticRaw,
      filteredPrediction: staticFiltered,
      rawDistances: staticRawDistances, filteredDistances: staticFilteredDistances,
      hasReference: staticExamples.length > 0,
      legacyReference: staticExamples.some(example => !example.components),
      referenceFilterMismatch: staticExamples.some(recognition.hasFilterReferenceMismatch)
    });
  }

  if (!motion.armed){
    motion.frames = motion.frames.slice(-10);
    const tail = motion.frames.map(frame => ({ ...frame.rawFrame, time: frame.time }));
    const quiet = tail.length >= 8 && state.motions.every(sample => {
      if (sample.syncStatus === "pending") return true;
      const required = sample.components || {
        left: sample.captureMeta?.handedness
          ? sample.captureMeta.handedness === "Left" : res.hand === "Left",
        right: sample.captureMeta?.handedness
          ? sample.captureMeta.handedness === "Right" : res.hand === "Right",
        face: false
      };
      const analysis = analyzeUnifiedCapture(tail, required, aspect);
      return analysis.reason !== "missing-required-components" && !analysis.motionDetected;
    });
    if (quiet){
      motion.unrecognizedSince ||= res.timestamp;
      if (res.timestamp - motion.unrecognizedSince >= 500){
        motion.armed = true;
        motion.segmentActive = false;
        motion.frames = [motion.frames.at(-1)];
        motion.unrecognizedSince = 0;
      }
    } else motion.unrecognizedSince = 0;
    ui.stability(staticMain, evaluationTime, generation);
    return;
  }

  const frames = motion.frames;
  if (frames.length < 8){
    ui.stability(staticMain, evaluationTime, generation);
    return;
  }
  const rawFrames = frames.map(frame => ({ ...frame.rawFrame, time: frame.time }));
  const motionAnalyses = state.motions
    .filter(sample => sample.syncStatus !== "pending")
    .map(sample => {
      const required = sample.components || {
        left: sample.captureMeta?.handedness
          ? sample.captureMeta.handedness === "Left" : res.hand === "Left",
        right: sample.captureMeta?.handedness
          ? sample.captureMeta.handedness === "Right" : res.hand === "Right",
        face: false
      };
      return analyzeUnifiedCapture(rawFrames, required, aspect);
    });
  const motionDetected = motionAnalyses.some(result => result.motionDetected);
  if (motionDetected) motion.segmentActive = true;
  if (motion.segmentActive){
    const durationLimitMs = parseFloat($("dur").value) * 1000;
    const segmentDuration = frames.at(-1).time - frames[0].time;
    if (segmentDuration > durationLimitMs){
      motion.armed = false;
      motion.segmentActive = false;
      motion.frames = [];
      motion.unrecognizedSince = 0;
      signEl.textContent = "Movimiento demasiado largo o incompleto";
      signEl.className = "sign idle";
      metaEl.textContent = "";
      return;
    }
    state.cand = null; state.candCount = 0; state.candSince = null;
    holdBar.style.width = "0";
    if (motionAnalyses.some(result => result.kind === "motion")){
      const t0 = frames[0].time;
      const query = {
        rawFrames: frames.map(frame => ({ ...frame.rawFrame, time: frame.time - t0 })),
        filteredFrames: frames.map(frame => ({ ...frame.filteredFrame, time: frame.time - t0 })),
        rawLegacySequence: null,
        filteredLegacySequence: null
      };
      const pair = legacyMotionPair(frames.map(frame => ({ ...frame, time: frame.time - t0 })),
        aspect);
      if (pair){
        query.rawLegacySequence = pair.raw;
        query.filteredLegacySequence = pair.filtered;
      }
      const rawMotion = classifyFrame(query, "raw", "motion");
      const filteredMotion = classifyFrame(query, "filtered", "motion");
      const motionMain = selectActivePrediction(filteredMotion);
      const selected = selectUnifiedPrediction(staticMain, motionMain);
      const { rawDistances, filteredDistances } = recognition.pairedHolisticDistances(query, "motion");
      const reference = $("evaluationReference").value || selected?.label;
      const examples = state.motions.filter(example => example.l === reference);
      updateComparison({
        kind: "motion", detected: true, rawPrediction: rawMotion,
        filteredPrediction: filteredMotion, rawDistances, filteredDistances,
        hasReference: examples.length > 0,
        legacyReference: examples.some(example => !example.components),
        referenceFilterMismatch: examples.some(recognition.hasFilterReferenceMismatch)
      });
      if (selected?.reason === "ambiguous"){
        ui.stability(selected, evaluationTime, generation);
      } else if (selected?.label){
        if (!isCurrentRecognitionResult(state, generation)) return;
        state.committed = selected.label;
        const score = selected.conf == null ? "" :
          ` · Puntuación del reconocedor: ${Math.round(selected.conf * 100)}% (no es probabilidad validada)`;
        showLocked(selected.label, `${selected.src || "seña guardada"}${score}`, true);
        addToPhrase(selected.label, generation);
      } else {
        signEl.textContent = "Movimiento completo sin coincidencia";
        signEl.className = "sign idle";
        metaEl.textContent = "";
      }
      motion.armed = false;
      motion.segmentActive = false;
      motion.frames = [];
      motion.unrecognizedSince = 0;
      return;
    }
    if (motionAnalyses.some(result => result.reason === "incomplete-motion")){
      signEl.textContent = "Movimiento en curso";
      signEl.className = "sign idle";
      metaEl.textContent = "";
      return;
    }
  }

  const duration = parseFloat($("dur").value) * 1000;
  const cutoff = res.timestamp - duration;
  while (motion.frames.length > 8 && motion.frames[1].time < cutoff){
    motion.frames.shift();
  }
  ui.stability(staticMain, evaluationTime, generation);
  if (performance.now() >= state.readoutLock){
    signEl.textContent = staticMain?.label || "Esperando una seña";
    signEl.className = staticMain?.label ? "sign" : "sign idle";
    metaEl.textContent = staticMain?.src || "";
  }
}
function tickMotion(res){
  if (state.motion.purpose === "recognize"){
    recognizeMotion(res);
    return;
  }
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
    m.frames.every(frame => hasRequiredParts(frame.presence, required));
  const aspect = video.videoWidth / video.videoHeight;
  const rawSequence = captureComplete
    ? holisticMotionSequence(m.frames.map(frame => ({
      ...frame.rawFrame, time: frame.time - m.t0
    })), required, aspect) : null;
  const filteredSequence = captureComplete
    ? holisticMotionSequence(m.frames.map(frame => ({
      ...frame.filteredFrame, time: frame.time - m.t0
    })), required, aspect) : null;
  const sequenceValid = !!rawSequence && !!filteredSequence;
  if (sequenceValid){
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
      components: required, source: "paired-raw-and-filtered-v2", captureId: m.captureId,
      filter: filterMetadata(state.filterConfig), captureMeta,
      rawFrames: storedFrames("rawFrame"), filteredFrames: storedFrames("filteredFrame"),
      rawHolisticSequence: rawSequence,
      filteredHolisticSequence: filteredSequence,
      syncStatus: "pending"
    };
    const legacyPair = legacyMotionPair(m.frames, aspect);
    if (legacyPair){ sample.s = legacyPair.filtered; sample.r = legacyPair.raw; }
    state.motions.push(sample);
    recognition.prepareFilteredReferences(state.filterConfig);
    void saveAll().then(saved => {
      $("trainHint").textContent = saved
        ? `Listo: “${m.label}” guardada en Supabase. Graba unas 5 veces para mejorar la comparación.`
        : `“${m.label}” pendiente de sincronización; todavía no se usa para reconocer.`;
      renderList();
    }).catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
    renderList();
    $("trainHint").textContent = `Captura lista para guardar “${m.label}”.`;
    setCaptureProgress("Captura completada", m.ms, m.ms, `${m.frames.length} cuadros`);
  } else {
    const missingParts = m.incomplete ||
      m.frames.some(frame => !hasRequiredParts(frame.presence, required));
    setNote(missingParts
      ? "Mano o rostro requerido fuera de cámara"
      : "No se capturó una secuencia sincronizada suficiente; seña no reconocida.");
    setCaptureProgress("Captura incompleta", 0, m.ms, `${m.frames.length} cuadros`);
  }
  setEvaluationEnabled(true);
  refreshButtons();
}

/* ---------- Entrenamiento ---------- */
function refreshKind(){
  $("btnTrain").textContent = "Capturar seña";
  $("trainHint").textContent =
    "Mantén la postura o realiza el movimiento completo; el sistema analizará la secuencia automáticamente.";
  if (!state.capState && !state.motion){
    setCaptureProgress("Listo para capturar", 0, parseFloat($("dur").value) * 1000, "");
  }
}
for (const id of ["requireLeft", "requireRight", "requireFace"]){
  $(id).addEventListener("change", refreshKind);
}

function refreshButtons(){
  const recognitionActive = isRecognitionActive(state);
  const capturing = !!state.capState || state.motion?.purpose === "train";
  $("btnTrain").disabled = !state.ready || capturing || recognitionActive;
  $("btnMotion").disabled = !state.ready || capturing;
  $("btnMotion").textContent = recognitionActive
    ? "Detener reconocimiento" : "Iniciar reconocimiento";
  $("btnMotion").setAttribute("aria-pressed", String(recognitionActive));
  for (const id of ["requireLeft", "requireRight", "requireFace"]){
    $(id).disabled = !state.ready || capturing || recognitionActive;
  }
}
function capture(f){
  if (state.capState.phase !== "rec") return;
  const capture = state.capState;
  if (!hasRequiredParts(f.presence, capture.components)){
    capture.rawFrames = [];
    capture.filteredFrames = [];
    capture.startedAt = f.time;
    setCaptureProgress("Falta un componente requerido", 0, capture.ms);
    setNote("Mano o rostro requerido fuera de cámara");
    return;
  }
  capture.rawFrames ||= [];
  capture.filteredFrames ||= [];
  capture.rawFrames.push(asStoredFrame(f.rawFrame, f.time - capture.startedAt, f.presence));
  capture.filteredFrames.push(asStoredFrame(f.filteredFrame, f.time - capture.startedAt, f.presence));
  const elapsed = f.time - capture.startedAt;
  setCaptureProgress("Capturando seña", elapsed, capture.ms,
    `${capture.rawFrames.length} cuadros`);
  if (elapsed >= capture.ms) finishUnifiedCapture(capture);
}

function finishUnifiedCapture(capture){
  const aspect = video.videoWidth / video.videoHeight;
  const analysis = analyzeUnifiedCapture(capture.rawFrames, capture.components, aspect);
  state.capState = null;
  setEvaluationEnabled(true);
  refreshButtons();
  if (!analysis.kind){
    setNote(analysis.reason === "incomplete-motion"
      ? "Movimiento incompleto: vuelve a capturar la seña y mantenla estable al terminar."
      : analysis.reason === "missing-required-components"
        ? "Falta un componente requerido; la captura no se guardó."
        : "No se pudo analizar una secuencia válida; la captura no se guardó.");
    setCaptureProgress("Captura incompleta", 0, capture.ms, `${capture.rawFrames.length} cuadros`);
    return;
  }
  const rawDescriptors = capture.rawFrames.map(frame =>
    extractHolisticFeatures(frame, aspect, capture.components));
  const filteredDescriptors = capture.filteredFrames.map(frame =>
    extractHolisticFeatures(frame, aspect, capture.components));
  if (rawDescriptors.some(descriptor => !descriptor) ||
      filteredDescriptors.some(descriptor => !descriptor)){
    setNote("La captura perdió características requeridas; no se guardó.");
    setCaptureProgress("Captura incompleta", 0, capture.ms, `${capture.rawFrames.length} cuadros`);
    return;
  }
  const captureMeta = {
    handCount: Math.max(0, ...capture.rawFrames.map(frame =>
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
  };
  const common = {
    l: capture.label,
    kind: analysis.kind,
    formatVersion: SAMPLE_FORMAT_VERSION,
    captureId: capture.captureId,
    components: capture.components,
    rawFrames: capture.rawFrames,
    filteredFrames: capture.filteredFrames,
    source: "paired-raw-and-filtered-v2",
    filter: filterMetadata(state.filterConfig),
    captureMeta,
    syncStatus: "pending"
  };
  let sample;
  if (analysis.kind === "motion"){
    const rawSequence = holisticMotionSequence(
      capture.rawFrames, capture.components, aspect);
    const filteredSequence = holisticMotionSequence(
      capture.filteredFrames, capture.components, aspect);
    if (!rawSequence || !filteredSequence){
      setNote("No se pudo derivar la trayectoria EDO; la captura no se guardó.");
      setCaptureProgress("Captura incompleta", 0, capture.ms, `${capture.rawFrames.length} cuadros`);
      return;
    }
    sample = {
      ...common,
      rawHolisticSequence: rawSequence,
      filteredHolisticSequence: filteredSequence,
      captureAnalysis: {
        motionDetected: true,
        settledAtEnd: analysis.settledAtEnd,
        travel: analysis.travel,
        handShapeChange: analysis.handShapeChange,
        facialChange: analysis.facialChange
      }
    };
    state.motions.push(sample);
  } else {
    sample = {
      ...common,
      h: recognition.meanDescriptors(filteredDescriptors),
      rh: recognition.meanDescriptors(rawDescriptors)
    };
    state.samples.push(sample);
  }
  recognition.prepareFilteredReferences(state.filterConfig);
  void saveAll().then(saved => {
    $("trainHint").textContent = saved
      ? `Listo: “${capture.label}” guardada en Supabase.`
      : `“${capture.label}” pendiente de sincronización; todavía no se usa para reconocer.`;
    renderList();
  }).catch(error => setNote(`No se pudo guardar la captura: ${error.message}`));
  renderList();
  $("trainHint").textContent = analysis.kind === "motion"
    ? `Se detectó una trayectoria completa para “${capture.label}”.`
    : `Se detectó una postura estable para “${capture.label}”.`;
  setCaptureProgress("Captura completada", capture.ms, capture.ms,
    `${capture.rawFrames.length} cuadros`);
}
function resetTracking(){
  if (state.motion?.phase === "rec"){
    state.motion.frames = [];
    state.motion.t0 = performance.now();
    state.motion.lastEvaluatedAt = 0;
    state.motion.unrecognizedSince = 0;
    state.motion.armed = true;
    bannerBar.style.width = "0";
  }
  if (state.capState?.phase === "rec"){
    state.capState.rawFrames = [];
    state.capState.filteredFrames = [];
    state.capState.startedAt = performance.now();
    setCaptureProgress("Se perdió un componente; reiniciando",
      0, state.capState.ms);
    $("trainHint").textContent = "Se perdió un componente requerido; reiniciando la captura.";
    setNote("Mano o rostro requerido fuera de cámara");
  }
}
function resetForFilterChange(){
  resetRecognitionForFilterChange(state);
  if (state.recognitionEnabled){
    signEl.textContent = "Reconocimiento activo";
    signEl.className = "sign idle";
    metaEl.textContent = "Esperando una seña con el filtro actualizado.";
  }
  holdBar.style.width = "0";
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
  const durationMs = parseFloat($("dur").value) * 1000;
  setCaptureProgress("Preparando captura", 0, durationMs);
  state.capState = {
    label, phase: "count", ms: durationMs, components: required,
    captureId: crypto.randomUUID(), startedAt: 0, capturedAt: null,
    rawFrames: [], filteredFrames: []
  };
  setEvaluationEnabled(false);
  $("btnTrain").disabled = true;
  $("btnMotion").disabled = true;
  let n = 3;
  const tick = () => {
    if (!state.capState) return;
    if (n > 0){
      $("trainHint").textContent = `Prepara la mano… ${n}`;
      setCaptureProgress(`Prepárate… ${n}`, 0, durationMs);
      n--;
      scheduleRecognitionTimeout(tick, 800);
    }
    else {
      state.onRecordingStart?.();
      $("trainHint").textContent = "Captura la postura o realiza el movimiento completo.";
      setCaptureProgress("Capturando seña", 0, durationMs);
      state.capState.startedAt = performance.now();
      state.capState.capturedAt = new Date().toISOString();
      state.capState.phase = "rec";
    }
  };
  tick();
};
$("btnMotion").onclick = () => {
  if (state.recognitionEnabled || state.motion?.purpose === "recognize"){
    setRecognitionEnabled(false);
    state.motion = null;
    state.cand = null; state.candCount = 0; state.committed = null;
    state.readoutLock = 0;
    showLocked("Reconocimiento detenido", "", false);
    refreshButtons();
    return;
  }
  startMotion("recognize");
};
document.addEventListener("keydown", e => {
  if (e.code === "Space" && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.target.tagName)){
    e.preventDefault();
    $("btnMotion").click();
  }
});


return {
  startMotion, tickMotion, capture, refreshKind, refreshButtons, resetTracking,
  resetForFilterChange
};
}

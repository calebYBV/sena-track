import { HandLandmarker, FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { createEdoFilter, calculateVibrationReduction, estimateTrackingLag } from "./filters.js";
import { extractFaceFeatures } from "./holistic.js";
import {
  isCurrentRecognitionResult,
  selectActivePrediction
} from "./recognitionState.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_FACE = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export function createCamera({ state, dom, ui, training, recognition, evaluationCapture }){
const { $, video, canvas, ctx, statusEl } = dom;
const { renderList, show, stability, showNoHand, lostHand, updateComparison,
  updateTrackingMetrics, setNote, setEvaluationEnabled } = ui;
const { refreshKind, refreshButtons, capture, tickMotion, resetTracking } = training;
const { compareStaticFrames } = recognition;
let landmarker = null, faceLandmarker = null, drawing = null, stream = null;
let started = false, frameId = null, startToken = 0, missingFrames = 0;
let lastFrameError = null;
let activeHand = null, lastTime = -1;
const edo = createEdoFilter();
let lastComparisonAt = -Infinity;
let lastTrackingMetricUpdateAt = -Infinity;
let trackingDiagnosticsActive = false;
let lastTrackingMetricNote = null;
let previousMeasurement = null;
let quietMeasurements = [];
let movingMeasurements = [];

function stepDisplacement(previous, current, aspect, palmSize){
  let sum = 0;
  for (let i = 0; i < current.length; i++){
    const dx = (current[i].x - previous[i].x) * aspect;
    const dy = current[i].y - previous[i].y;
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / current.length) / palmSize;
}

function updateTrackingDiagnostics(raw, filtered, timestamp){
  trackingDiagnosticsActive = true;
  lastTrackingMetricNote = null;
  const aspect = video.videoWidth / video.videoHeight;
  const palmSize = Math.max(0.01, Math.hypot(
    (raw[9].x - raw[0].x) * aspect, raw[9].y - raw[0].y
  ));
  if (previousMeasurement){
    const dt = (timestamp - previousMeasurement.time) / 1000;
    if (dt > 0){
      const rawStep = stepDisplacement(previousMeasurement.raw, raw, aspect, palmSize);
      const filteredStep = stepDisplacement(previousMeasurement.filtered, filtered, aspect, palmSize);
      if (rawStep / dt < 0.18){
        quietMeasurements.push({ raw: rawStep, filtered: filteredStep });
        if (quietMeasurements.length > 120) quietMeasurements.shift();
      } else quietMeasurements = [];

      const rawWrist = raw[0], filteredWrist = filtered[0];
      if (rawStep / dt >= 0.18){
        movingMeasurements.push({ raw: rawWrist, filtered: filteredWrist, time: timestamp, aspect });
        if (movingMeasurements.length > 90) movingMeasurements.shift();
      } else movingMeasurements = [];
    }
  }
  previousMeasurement = {
    raw: raw.map(point => ({ x: point.x, y: point.y })),
    filtered: filtered.map(point => ({ x: point.x, y: point.y })),
    time: timestamp
  };
  if (timestamp - lastTrackingMetricUpdateAt < 200) return;
  lastTrackingMetricUpdateAt = timestamp;
  const hasQuietRun = quietMeasurements.length >= 15;
  const rawVibration = hasQuietRun
    ? Math.sqrt(quietMeasurements.reduce((sum, item) => sum + item.raw ** 2, 0) / quietMeasurements.length) : null;
  const filteredVibration = hasQuietRun
    ? Math.sqrt(quietMeasurements.reduce((sum, item) => sum + item.filtered ** 2, 0) / quietMeasurements.length) : null;
  const vibrationReduction = calculateVibrationReduction(rawVibration, filteredVibration);
  const lagMs = estimateTrackingLag(movingMeasurements);
  updateTrackingMetrics({
    rawVibration, filteredVibration, vibrationReduction, lagMs,
    note: "Mano seguida: vibración = RMS del desplazamiento de sus 21 landmarks entre cuadros consecutivos, normalizado por el tamaño de palma raw (longitudes de palma/cuadro); se compara tras ≥15 cuadros con velocidad raw <0,18 longitudes de palma/s. Retardo = desfase de máxima correlación (≥0,6) de velocidades x/y de muñeca, hasta 10 cuadros; ms estimados, no tiempo de cómputo ni de confirmación."
  });
}

function resetTrackingDiagnostics(note = "Métricas reiniciadas al perder la mano o iniciar una captura."){
  previousMeasurement = null;
  quietMeasurements = [];
  movingMeasurements = [];
  lastTrackingMetricUpdateAt = -Infinity;
  if (!trackingDiagnosticsActive && lastTrackingMetricNote === note) return;
  trackingDiagnosticsActive = false;
  lastTrackingMetricNote = note;
  updateTrackingMetrics({
    rawVibration: null, filteredVibration: null, vibrationReduction: null, lagMs: null,
    note
  });
}

function releaseMedia(){
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  landmarker?.close();
  faceLandmarker?.close();
  landmarker = null;
  faceLandmarker = null;
  drawing = null;
  edo.reset();
  activeHand = null;
}

function stop(){
  const interruptedCapture = !!state.capState || state.motion?.purpose === "train";
  startToken++;
  started = false;
  state.ready = false;
  state.recognitionEnabled = false;
  state.motion = null;
  state.capState = null;
  state.cand = null;
  state.candCount = 0;
  state.candSince = null;
  state.committed = null;
  state.noHand = 0;
  state.noHandSince = null;
  state.neutralSince = null;
  state.readoutLock = 0;
  for (const timer of state.recognitionTimers){ clearTimeout(timer); }
  state.recognitionTimers.clear();
  missingFrames = 0;
  lastTime = -1;
  lastFrameError = null;
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null;
  releaseMedia();
  evaluationCapture.cancel("Cámara detenida; la captura de evaluación no se guardó.");
  resetTrackingDiagnostics("Cámara inactiva; datos de seguimiento no disponibles.");
  setEvaluationEnabled(true);
  if (interruptedCapture) setNote("Captura cancelada al salir del Traductor; no se guardó.");
  refreshButtons();
  statusEl.className = "status";
  statusEl.textContent = "Cámara inactiva. Vuelve al Traductor para iniciarla.";
  statusEl.classList.remove("hidden");
  $("cameraIndicator").classList.remove("is-active", "has-error");
  $("cameraIndicatorText").textContent = "Cámara inactiva";
}

function resetFilters(){
  edo.reset();
  lastComparisonAt = -Infinity;
  resetTrackingDiagnostics("Métricas reiniciadas por cambio de filtro.");
}

function resetFilterHistory(){
  edo.reset();
  lastComparisonAt = -Infinity;
  resetTrackingDiagnostics("Métricas reiniciadas al comenzar una captura.");
}

window.addEventListener("pagehide", stop);

function drawFace(timestamp, activeIdentities){
  if (!faceLandmarker) return null;
  const result = faceLandmarker.detectForVideo(video, timestamp);
  if (!result.faceLandmarks.length) return null;
  const raw = result.faceLandmarks[0].map(({ x, y, z }) => ({ x, y, z }));
  const filtered = edo.process(raw, "face", timestamp, state.filterConfig);
  activeIdentities.push("face");
  drawing.drawConnectors(filtered, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: "#f2b705", lineWidth: 2 });
  if (state.filterConfig.compareVisual){
    drawing.drawLandmarks(raw, { color: "#74e4ff", fillColor: "#74e4ff", radius: 1, lineWidth: 1 });
    drawing.drawLandmarks(filtered, { color: "#86e750", fillColor: "#86e750", radius: 1, lineWidth: 1 });
  }
  const matrixData = result.facialTransformationMatrixes?.[0]?.data;
  const matrix = matrixData ? Array.from(matrixData) : null;
  const blendshapes = result.faceBlendshapes?.[0]?.categories;
  const rawFeatures = extractFaceFeatures(raw, blendshapes, matrix,
    video.videoWidth / video.videoHeight);
  const filteredFeatures = rawFeatures
    ? edo.process(rawFeatures.map(value => ({ x: value, y: 0, z: 0 })),
      "face:features", timestamp, state.filterConfig).map(point => point.x)
    : null;
  if (filteredFeatures) activeIdentities.push("face:features");
  return { rawLandmarks: raw, filteredLandmarks: filtered,
    rawFeatures, filteredFeatures };
}

function chooseHand(results){
  const identities = results.handedness.map(hand => hand[0].categoryName);
  let index = activeHand === null ? -1 : identities.indexOf(activeHand);
  if (index < 0 && identities.length){
    index = results.handedness.reduce((best, hand, i) =>
      hand[0].score > results.handedness[best][0].score ? i : best, 0);
    const next = identities[index];
    if (activeHand !== null && activeHand !== next){
      state.cand = null; state.candCount = 0; state.committed = null; state.noHand = 0;
      resetTrackingDiagnostics("Métricas reiniciadas al cambiar la mano seguida.");
      const recording = !!(state.motion || state.capState);
      resetTracking();
      if (recording) setNote(state.motion?.purpose === "recognize"
        ? "Cambió la mano seguida; reinicié la ventana de reconocimiento."
        : "Cambió la mano seguida; reinicié la captura para no mezclar trayectorias.");
    }
    activeHand = next;
  }
  if (index < 0) return null;
  return index;
}

function compareStatic(track, timestamp){
  const rawFrame = track.rawFrame;
  const filteredFrame = track.filteredFrame;
  if (timestamp - lastComparisonAt < 200){
    const prediction = recognition.classifyFrame(filteredFrame, "filtered", "static");
    return { rawPrediction: null, filteredPrediction: prediction };
  }
  lastComparisonAt = timestamp;
  const { rawPrediction, filteredPrediction, rawDistances, filteredDistances } =
    compareStaticFrames(rawFrame, filteredFrame);
  const requested = $("evaluationReference").value;
  const mainPrediction = selectActivePrediction(filteredPrediction);
  const reference = requested || mainPrediction?.label;
  const examples = state.samples.filter(sample => sample.l === reference);
  updateComparison({
    kind: "static", detected: true, rawPrediction, filteredPrediction, rawDistances, filteredDistances,
    hasReference: examples.length > 0,
    legacyReference: examples.some(sample => !sample.components),
    referenceFilterMismatch: examples.some(recognition.hasFilterReferenceMismatch)
  });
  return { rawPrediction, filteredPrediction };
}

/* ---------- Bucle principal ---------- */
function processFrame(){
  if (video.readyState >= 2 && video.currentTime !== lastTime){
    if (!["first", "second"].includes(state.filterConfig.model)){
      throw new RangeError("El reconocimiento requiere un filtro EDO de primer o segundo orden.");
    }
    const timestamp = performance.now();
    const recognitionGeneration = state.recognitionGeneration;
    const results = landmarker.detectForVideo(video, timestamp);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const activeIdentities = [];
    const handTracks = {};
    results.handedness.forEach((hand, index) => {
      const side = hand[0].categoryName;
      if (!["Left", "Right"].includes(side)) return;
      const identity = `hand:${side}`;
      activeIdentities.push(identity);
      const rawLandmarks = results.landmarks[index].map(({ x, y, z }) => ({ x, y, z }));
      const filteredLandmarks = edo.process(rawLandmarks, identity, timestamp, state.filterConfig);
      handTracks[side] = { hand: side, rawLandmarks, filteredLandmarks };
    });
    const selectedIndex = chooseHand(results);
    const selected = selectedIndex === null ? null : handTracks[results.handedness[selectedIndex][0].categoryName];
    const face = drawFace(timestamp, activeIdentities);
    const rawFrame = {
      hands: Object.fromEntries(Object.entries(handTracks).map(([side, track]) => [side, track.rawLandmarks])),
      faceLandmarks: face?.rawLandmarks,
      faceFeatures: face?.rawFeatures
    };
    const filteredFrame = {
      hands: Object.fromEntries(Object.entries(handTracks).map(([side, track]) => [side, track.filteredLandmarks])),
      faceLandmarks: face?.filteredLandmarks,
      faceFeatures: face?.filteredFeatures
    };
    ui.updateCoordinateTrace(rawFrame, filteredFrame, timestamp);
    const presence = {
      Left: !!handTracks.Left,
      Right: !!handTracks.Right,
      face: !!face?.rawLandmarks && !!face?.filteredLandmarks,
      faceFeatures: !!face?.rawFeatures && !!face?.filteredFeatures
    };
    const requiredMissing = state.samples.some(sample => sample.syncStatus !== "pending" &&
      sample.components && ((sample.components.left && !presence.Left) ||
        (sample.components.right && !presence.Right) ||
        (sample.components.face && !presence.faceFeatures)));
    $("componentStatus").textContent =
      `Mano izquierda: ${presence.Left ? "detectada" : "fuera de cámara"} · ` +
      `Mano derecha: ${presence.Right ? "detectada" : "fuera de cámara"} · ` +
      `Rostro: ${presence.face ? "detectado" : "fuera de cámara"}`;
    const isCapturing = !!state.capState;
    if (isCapturing){
      capture({
        rawFrame, filteredFrame, presence,
        time: timestamp,
        handCount: results.landmarks.length,
        faceAvailable: presence.face
      });
    }
    evaluationCapture.captureFrame(rawFrame, presence, timestamp);
    if (selected || face){
      missingFrames = 0;
      for (const track of Object.values(handTracks)){
        const activeLandmarks = track.filteredLandmarks;
        const comparisonLandmarks = track.rawLandmarks;
        drawing.drawConnectors(activeLandmarks, HandLandmarker.HAND_CONNECTIONS, { color: "#86e750", lineWidth: 4 });
        const filteredColor = state.filterConfig.compareVisual ? "#86e750" : "#ffffff";
        drawing.drawLandmarks(activeLandmarks, {
          color: filteredColor,
          fillColor: state.filterConfig.compareVisual ? filteredColor : "#0c71c6",
          radius: 4,
          lineWidth: 2
        });
        if (state.filterConfig.compareVisual){
          drawing.drawLandmarks(comparisonLandmarks, { color: "#74e4ff", fillColor: "#74e4ff", radius: 2, lineWidth: 1 });
        }
      }
      if (state.motion){
        if (state.motion.purpose === "recognize"){
          if (selected) updateTrackingDiagnostics(
            selected.rawLandmarks, selected.filteredLandmarks, timestamp);
          else resetTrackingDiagnostics(
            "No disponible: vibración y retraso requieren una mano detectada.");
        }
        tickMotion({
          rawFrame, filteredFrame, presence,
          rawLandmarks: selected?.rawLandmarks, filteredLandmarks: selected?.filteredLandmarks,
          hand: selected?.hand,
          timestamp,
          recognitionGeneration,
          handCount: results.landmarks.length,
          faceAvailable: presence.face
        });
      } else if (!isCapturing && state.recognitionEnabled){
        if (selected){
          updateTrackingDiagnostics(selected.rawLandmarks, selected.filteredLandmarks, timestamp);
        } else {
          resetTrackingDiagnostics("No disponible: vibración y retraso requieren una mano detectada.");
        }
        const predictions = compareStatic({
          ...selected, rawFrame, filteredFrame
        }, timestamp);
        const mainPrediction = selectActivePrediction(predictions.filteredPrediction);
        if (!mainPrediction?.label && requiredMissing){
          $("sign").textContent = "Mano o rostro requerido fuera de cámara";
          $("sign").className = "sign idle";
          $("meta").textContent = "";
          state.cand = null; state.candCount = 0; state.committed = null;
          holdBar.style.width = "0";
          updateComparison({ detected: false, reason: "Mano o rostro requerido fuera de cámara" });
          edo.retain(activeIdentities);
          lastTime = video.currentTime;
          return;
        }
        if (isCurrentRecognitionResult(state, recognitionGeneration)){
          show(mainPrediction);
          stability(mainPrediction, timestamp, recognitionGeneration);
        }
      } else if (!isCapturing){
        $("sign").textContent = "Reconocimiento detenido";
        $("sign").className = "sign idle";
        $("meta").textContent = "Inicia reconocimiento para detectar señas.";
        state.cand = null; state.candCount = 0; state.committed = null;
        holdBar.style.width = "0";
      }
    } else {
      if (missingFrames === 0){
        resetTracking();
        resetTrackingDiagnostics();
        state.cand = null; state.candCount = 0; state.committed = null;
      }
      const trainingCaptureMissing = (state.motion?.purpose === "train" &&
        state.motion.phase === "rec") || state.capState?.phase === "rec";
      const missingMessage = requiredMissing || trainingCaptureMissing
        ? "Mano o rostro requerido fuera de cámara" : "Seña no reconocida";
      $("sign").textContent = missingMessage;
      $("sign").className = "sign idle";
      $("meta").textContent = "";
      updateComparison({ detected: false, reason: requiredMissing ? missingMessage : undefined });
      if (state.motion) tickMotion(null);
      if (lostHand()) state.cand = null;
      if (requiredMissing || trainingCaptureMissing){
        $("sign").textContent = missingMessage;
        $("sign").className = "sign idle";
        $("meta").textContent = "";
      } else showNoHand();
      missingFrames++;
    }
    edo.retain(activeIdentities);
    lastTime = video.currentTime;
  }
}

function loop(){
  frameId = null;
  if (!started || !state.ready) return;
  try {
    processFrame();
    if (lastFrameError){
      if ($("note").textContent === lastFrameError) setNote("");
      lastFrameError = null;
      $("cameraIndicator").classList.remove("has-error");
      $("cameraIndicator").classList.add("is-active");
      $("cameraIndicatorText").textContent = "Cámara activa";
    }
  } catch (error){
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Error de seguimiento; intentando recuperar: ${detail}`;
    if (lastFrameError !== message){
      console.error("Falló el procesamiento de un cuadro de cámara; el bucle seguirá activo.", error);
      lastFrameError = message;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    edo.reset();
    resetTrackingDiagnostics();
    resetTracking();
    activeHand = null;
    missingFrames = 0;
    state.cand = null;
    state.candCount = 0;
    state.committed = null;
    setNote(message);
    $("cameraIndicator").classList.add("has-error");
    $("cameraIndicatorText").textContent = "Recuperando seguimiento";
  } finally {
    if (started && state.ready) frameId = requestAnimationFrame(loop);
  }
}

/* ---------- Arranque ---------- */
function fail(msg){
  stop();
  statusEl.textContent = msg;
  statusEl.className = "status error";
  $("cameraIndicator").classList.add("has-error");
  $("cameraIndicatorText").textContent = "Cámara no disponible";
}

async function start(){
  if (started) return;
  started = true;
  statusEl.className = "status";
  statusEl.textContent = "Cargando modelo y cámara…";
  statusEl.classList.remove("hidden");
  $("cameraIndicator").classList.remove("has-error");
  $("cameraIndicator").classList.remove("is-active");
  $("cameraIndicatorText").textContent = "Iniciando cámara";
  const token = ++startToken;
  renderList(); refreshKind();
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640, max: 960 },
        height: { ideal: 480, max: 720 },
        facingMode: "user"
      },
      audio: false
    });
    if (token !== startToken){ cameraStream.getTracks().forEach(track => track.stop()); return; }
    stream = cameraStream;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
      video.srcObject = stream;
    });
    await video.play();
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  } catch (e) {
    if (token !== startToken) return;
    let msg;
    if (!navigator.mediaDevices) msg = "El navegador no permite cámara en esta dirección. Abre la página desde http://localhost:8000 o desde https.";
    else if (window.self !== window.top) msg = "La cámara está bloqueada porque la página está dentro de otra (vista previa). Ábrela en una pestaña propia desde http://localhost:8000.";
    else if (e.name === "NotAllowedError") msg = "El permiso de cámara fue denegado. Pulsa el ícono de candado junto a la dirección, permite la cámara y recarga.";
    else if (e.name === "NotFoundError") msg = "No se encontró ninguna cámara conectada.";
    else if (e.name === "NotReadableError") msg = "Otra aplicación (Zoom, Meet, Teams…) o pestaña está usando la cámara. Ciérrala y recarga.";
    else msg = "No pude usar la cámara (" + e.name + "). Recarga e intenta de nuevo.";
    return fail(msg);
  }
  if (token !== startToken) return;
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    if (token !== startToken) return;
    const handOptions = delegate => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO", numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.65
    });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, handOptions("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, handOptions("CPU")); }
    if (token !== startToken){ releaseMedia(); return; }
    const faceOptions = delegate => ({
      baseOptions: { modelAssetPath: MODEL_FACE, delegate },
      runningMode: "VIDEO", numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.65
    });
    try { faceLandmarker = await FaceLandmarker.createFromOptions(fileset, faceOptions("GPU")); }
    catch {
      try { faceLandmarker = await FaceLandmarker.createFromOptions(fileset, faceOptions("CPU")); }
      catch { faceLandmarker = null; }
    }
    if (token !== startToken){ releaseMedia(); return; }
    drawing = new DrawingUtils(ctx);
  } catch (e) {
    if (token !== startToken) return;
    return fail("No se pudo cargar el modelo de MediaPipe. Revisa tu conexión a internet y recarga.");
  }
  if (token !== startToken) return;
  if (!faceLandmarker) $("faceStatus").textContent =
    "No se pudo cargar el modelo facial; el seguimiento del rostro está desactivado.";
  state.ready = true;
  refreshButtons();
  statusEl.classList.add("hidden");
  $("cameraIndicator").classList.add("is-active");
  $("cameraIndicatorText").textContent = "Cámara activa";
  frameId = requestAnimationFrame(loop);
}

return { start, stop, resetFilters, resetFilterHistory };
}

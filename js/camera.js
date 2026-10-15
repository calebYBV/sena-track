import { HandLandmarker, FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { createEdoFilter, calculateVibrationReduction, estimateTrackingLag } from "./filters.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_FACE = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export function createCamera({ state, dom, ui, training, recognition }){
const { $, video, canvas, ctx, statusEl } = dom;
const { renderList, show, stability, showNoHand, lostHand, updateComparison,
  updateTrackingMetrics, setNote } = ui;
const { refreshKind, refreshButtons, capture, tickMotion, resetTracking } = training;
const { features, classify, ruleSign, staticDistances } = recognition;
let landmarker = null, faceLandmarker = null, drawing = null, stream = null;
let started = false, frameId = null, startToken = 0, missingFrames = 0;
let activeHand = null, lastTime = -1;
const edo = createEdoFilter();
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
  const hasQuietRun = quietMeasurements.length >= 15;
  const rawVibration = hasQuietRun
    ? Math.sqrt(quietMeasurements.reduce((sum, item) => sum + item.raw ** 2, 0) / quietMeasurements.length) : null;
  const filteredVibration = hasQuietRun
    ? Math.sqrt(quietMeasurements.reduce((sum, item) => sum + item.filtered ** 2, 0) / quietMeasurements.length) : null;
  const vibrationReduction = calculateVibrationReduction(rawVibration, filteredVibration);
  const lagMs = estimateTrackingLag(movingMeasurements);
  updateTrackingMetrics({
    rawVibration, filteredVibration, vibrationReduction, lagMs,
    note: "Mano quieta: velocidad raw < 0,18 longitudes de palma/s durante al menos 15 cuadros. Retraso: correlación temporal de la trayectoria de muñeca; no es tiempo de cómputo ni de confirmación."
  });
}

function resetTrackingDiagnostics(){
  previousMeasurement = null;
  quietMeasurements = [];
  movingMeasurements = [];
  updateTrackingMetrics({
    rawVibration: null, filteredVibration: null, vibrationReduction: null, lagMs: null,
    note: "Métricas reiniciadas al perder la mano o iniciar una captura."
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
  startToken++;
  started = false;
  state.ready = false;
  state.motion = null;
  state.capState = null;
  state.cand = null;
  state.candCount = 0;
  state.committed = null;
  state.noHand = 0;
  state.readoutLock = 0;
  missingFrames = 0;
  lastTime = -1;
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null;
  releaseMedia();
  resetTrackingDiagnostics();
  setEvaluationEnabled(true);
  refreshButtons();
  $("cameraIndicator").classList.remove("is-active", "has-error");
  $("cameraIndicatorText").textContent = "Cámara inactiva";
}

function resetFilters(){
  edo.reset();
  resetTrackingDiagnostics();
}

function resetFilterHistory(){
  edo.reset();
  resetTrackingDiagnostics();
}

window.addEventListener("pagehide", stop);

function drawFace(timestamp, activeIdentities){
  if (!faceLandmarker) return false;
  const result = faceLandmarker.detectForVideo(video, timestamp);
  if (!result.faceLandmarks.length) return false;
  const raw = result.faceLandmarks[0].map(({ x, y, z }) => ({ x, y, z }));
  const filtered = edo.process(raw, "face", timestamp, state.filterConfig);
  activeIdentities.push("face");
  drawing.drawConnectors(filtered, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#ffffff33", lineWidth: 1 });
  drawing.drawConnectors(filtered, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: "#f2b705", lineWidth: 2 });
  if (state.filterConfig.compareVisual && state.filterConfig.model !== "off"){
    drawing.drawLandmarks(raw, { color: "#74e4ff", fillColor: "#0c71c6", radius: 1, lineWidth: 1 });
  }
  return true;
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
      const recording = !!(state.motion || state.capState);
      resetTracking();
      if (recording) setNote("Cambió la mano seguida; reinicié la captura para no mezclar trayectorias.");
    }
    activeHand = next;
  }
  if (index < 0) return null;
  return index;
}

function compareStatic(track){
  const rawFeatures = features(track.rawLandmarks, track.hand);
  const filteredFeatures = features(track.filteredLandmarks, track.hand);
  let rawPrediction = classify(rawFeatures, "raw");
  let filteredPrediction = classify(filteredFeatures, "filtered");
  if ($("rules").checked){
    rawPrediction ||= ruleSign(track.rawLandmarks);
    filteredPrediction ||= ruleSign(track.filteredLandmarks);
  }
  const rawDistances = staticDistances(rawFeatures, "raw");
  const filteredDistances = staticDistances(filteredFeatures, "filtered");
  const requested = $("evaluationReference").value;
  const mainPrediction = state.filterConfig.model === "off" ? rawPrediction : filteredPrediction;
  const reference = requested || mainPrediction?.label;
  const examples = state.samples.filter(sample => sample.l === reference);
  updateComparison({
    kind: "static", detected: true, rawPrediction, filteredPrediction, rawDistances, filteredDistances,
    hasReference: examples.length > 0, ruleOnly: mainPrediction?.src === "gesto básico",
    legacyReference: examples.some(sample => !sample.r || !sample.source)
  });
  return { rawFeatures, filteredFeatures, rawPrediction, filteredPrediction };
}

/* ---------- Bucle principal ---------- */
function loop(){
  frameId = null;
  if (!started || !state.ready) return;
  if (video.readyState >= 2 && video.currentTime !== lastTime){
    lastTime = video.currentTime;
    const timestamp = performance.now();
    const results = landmarker.detectForVideo(video, timestamp);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const activeIdentities = [];
    const handTracks = results.handedness.map((hand, index) => {
      const identity = `hand:${hand[0].categoryName}`;
      activeIdentities.push(identity);
      const rawLandmarks = results.landmarks[index].map(({ x, y, z }) => ({ x, y, z }));
      const filteredLandmarks = edo.process(rawLandmarks, identity, timestamp, state.filterConfig);
      return { hand: hand[0].categoryName, rawLandmarks, filteredLandmarks };
    });
    const selectedIndex = chooseHand(results);
    if (selectedIndex !== null){
      missingFrames = 0;
      const selected = {
        ...handTracks[selectedIndex],
        handedness: results.handedness[selectedIndex],
        timestamp
      };
      for (const track of handTracks){
        drawing.drawConnectors(track.filteredLandmarks, HandLandmarker.HAND_CONNECTIONS, { color: "#86e750", lineWidth: 4 });
        drawing.drawLandmarks(track.filteredLandmarks, { color: "#ffffff", fillColor: "#0c71c6", radius: 4, lineWidth: 2 });
        if (state.filterConfig.compareVisual && state.filterConfig.model !== "off"){
          drawing.drawLandmarks(track.rawLandmarks, { color: "#74e4ff", fillColor: "#0c71c6", radius: 2, lineWidth: 1 });
        }
      }
      const faceAvailable = drawFace(timestamp, activeIdentities);
      if (state.motion){
        tickMotion({
          rawLandmarks: selected.rawLandmarks,
          filteredLandmarks: selected.filteredLandmarks,
          handedness: [selected.handedness],
          timestamp,
          handCount: results.landmarks.length,
          faceAvailable
        });
      } else if (state.capState){
        capture({
          raw: features(selected.rawLandmarks, selected.hand),
          filtered: features(selected.filteredLandmarks, selected.hand),
          rawLandmarks: selected.rawLandmarks,
          time: timestamp,
          handCount: results.landmarks.length,
          faceAvailable,
          handedness: selected.hand
        });
      } else {
        updateTrackingDiagnostics(selected.rawLandmarks, selected.filteredLandmarks, timestamp);
        const predictions = compareStatic(selected);
        const mainPrediction = state.filterConfig.model === "off"
          ? predictions.rawPrediction : predictions.filteredPrediction;
        show(mainPrediction); stability(mainPrediction);
      }
    } else {
      drawFace(timestamp, activeIdentities);
      if (missingFrames === 0){
        resetTracking();
        resetTrackingDiagnostics();
        state.cand = null; state.candCount = 0; state.committed = null;
      }
      updateComparison({ detected: false });
      if (state.motion) tickMotion(null);
      showNoHand();
      if (lostHand()) state.cand = null;
      missingFrames++;
    }
    edo.retain(activeIdentities);
  }
  if (started) frameId = requestAnimationFrame(loop);
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
  $("cameraIndicator").classList.remove("has-error");
  $("cameraIndicator").classList.remove("is-active");
  $("cameraIndicatorText").textContent = "Iniciando cámara";
  const token = ++startToken;
  renderList(); refreshKind();
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false
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

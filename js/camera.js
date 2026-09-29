import { HandLandmarker, FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_FACE = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export function createCamera({ state, dom, ui, training, recognition }) {
const { $, video, canvas, ctx, statusEl } = dom;
const { renderList, show, stability, showNoHand, lostHand } = ui;
const { refreshKind, refreshButtons, capture, tickMotion } = training;
const { features, classify, ruleSign } = recognition;
let landmarker = null, faceLandmarker = null, drawing = null, stream = null;
let started = false, frameId = null, startToken = 0, missingFrames = 0;
let smoothState = {};

function smoothHand(landmarks, label, alpha = 0.45){
  const previous = smoothState[label];
  if (!previous){
    smoothState[label] = landmarks.map(point => ({ x: point.x, y: point.y, z: point.z }));
    return smoothState[label];
  }
  const current = landmarks.map((point, index) => ({
    x: previous[index].x + alpha * (point.x - previous[index].x),
    y: previous[index].y + alpha * (point.y - previous[index].y),
    z: previous[index].z + alpha * (point.z - previous[index].z)
  }));
  smoothState[label] = current;
  return current;
}

function releaseMedia(){
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  landmarker?.close();
  faceLandmarker?.close();
  landmarker = null;
  faceLandmarker = null;
  drawing = null;
}

function stop(){
  startToken++;
  started = false;
  state.ready = false;
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null;
  releaseMedia();
}

window.addEventListener("pagehide", stop);

/* ---------- Bucle principal ---------- */
let lastTime = -1;
function loop(){
  frameId = null;
  if (!started || !state.ready) return;
  if (video.readyState >= 2 && video.currentTime !== lastTime){
    lastTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const has = res.landmarks.length > 0;
    let smoothed = [];
    if (has){
      missingFrames = 0;
      smoothed = res.landmarks.map((lm, index) => smoothHand(lm, res.handedness[index][0].categoryName));
      smoothed.forEach(lm => {
      drawing.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#86e750", lineWidth: 4 });
      drawing.drawLandmarks(lm, { color: "#ffffff", fillColor: "#0c71c6", radius: 4, lineWidth: 2 });
      });
    }
    if (faceLandmarker){
      const face = faceLandmarker.detectForVideo(video, performance.now());
      if (face.faceLandmarks.length > 0){
        const landmarks = face.faceLandmarks[0];
        drawing.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#ffffff33", lineWidth: 1 });
        drawing.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: "#f2b705", lineWidth: 2 });
      }
    }
    if (state.motion){
      tickMotion(has ? { landmarks: smoothed, handedness: res.handedness } : null);
    } else if (has){
      const lm = smoothed[0];
      const f = features(lm, res.handedness[0][0].categoryName);
      if (state.capState) {
        capture(f);
      } else {
      let r = classify(f);
      if (!r && $("rules").checked) r = ruleSign(lm);
      show(r); stability(r);
      }
    } else {
      showNoHand();
      if (lostHand()) smoothState = {};
      if (++missingFrames > 8) smoothState = {};
    }
  }
  if (started) frameId = requestAnimationFrame(loop);
}

/* ---------- Arranque ---------- */
function fail(msg){
  stop();
  statusEl.textContent = msg;
  statusEl.className = "status error";
}

async function start(){
  if (started) return;
  started = true;
  const token = ++startToken;
  renderList(); refreshKind();
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720, facingMode: "user" }, audio: false });
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
    const opts = d => ({ baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.6 });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
    const faceOpts = d => ({ baseOptions: { modelAssetPath: MODEL_FACE, delegate: d }, runningMode: "VIDEO", numFaces: 1 });
    try { faceLandmarker = await FaceLandmarker.createFromOptions(fileset, faceOpts("GPU")); }
    catch {
      try { faceLandmarker = await FaceLandmarker.createFromOptions(fileset, faceOpts("CPU")); }
      catch { faceLandmarker = null; }
    }
    drawing = new DrawingUtils(ctx);
  } catch (e) {
    return fail("No se pudo cargar el modelo de MediaPipe. Revisa tu conexión a internet y recarga.");
  }
  if (token !== startToken) return;
  state.ready = true;
  refreshButtons();
  statusEl.classList.add("hidden");
  frameId = requestAnimationFrame(loop);
}

return { start, stop };
}

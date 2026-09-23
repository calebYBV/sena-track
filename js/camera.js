import { HandLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export function createCamera({ state, dom, ui, training, recognition }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { renderList, show, stability, showNoHand, lostHand } = ui;
const { refreshKind, refreshButtons, capture, tickMotion } = training;
const { features, classify, ruleSign } = recognition;
let landmarker = null, drawing = null, stream = null, started = false;
/* ---------- Bucle principal ---------- */
let lastTime = -1;
function loop(){
  if (video.readyState >= 2 && video.currentTime !== lastTime){
    lastTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const has = res.landmarks.length > 0;
    if (has){
      const lm = res.landmarks[0];
      drawing.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#86e750", lineWidth: 4 });
      drawing.drawLandmarks(lm, { color: "#ffffff", fillColor: "#0c71c6", radius: 4, lineWidth: 2 });
    }
    if (state.motion){
      tickMotion(has ? res : null);
    } else if (has){
      const lm = res.landmarks[0];
      const f = features(lm, res.handedness[0][0].categoryName);
      if (state.capState) {
        capture(f);
      } else {
      let r = classify(f);
      if (!r && $("rules").checked) r = ruleSign(lm);
      show(r); stability(r);
      }
    } else {
      showNoHand(); lostHand();
    }
  }
  requestAnimationFrame(loop);
}

/* ---------- Arranque ---------- */
function fail(msg){
  stream?.getTracks().forEach(track => track.stop()); statusEl.textContent = msg; statusEl.className = "status error"; }

async function start(){
  if (started) return;
  started = true;
  renderList(); refreshKind();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720, facingMode: "user" }, audio: false });
    const loaded = new Promise(r => video.onloadedmetadata = r);
    video.srcObject = stream;
    await loaded;
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
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const opts = d => ({ baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: "VIDEO", numHands: 1 });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
    drawing = new DrawingUtils(ctx);
  } catch (e) {
    return fail("No se pudo cargar el modelo de MediaPipe. Revisa tu conexión a internet y recarga.");
  }
  state.ready = true;
  refreshButtons();
  statusEl.classList.add("hidden");
  loop();
}

return { start };
}

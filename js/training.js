export function createTraining({ state, dom, ui, storage, recognition }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { setNote, renderList, showLocked, addToPhrase } = ui;
const { saveAll } = storage;
const { toSequence, classifyMotion } = recognition;
const N_STEPS = 24, CAPTURE_FRAMES = 40;
function startMotion(purpose, label){
  if (!state.ready || state.motion || state.capState) return;
  if (purpose === "recognize" && !state.motions.length){
    setNote("Primero enseña al menos una seña con movimiento (tipo “Con movimiento”).");
    return;
  }
  setNote("");
  state.motion = { purpose, label, phase: "count", frames: [], ms: parseFloat($("dur").value) * 1000, t0: 0 };
  refreshButtons();
  let n = purpose === "train" ? 3 : 2;
  const step = () => {
    if (!state.motion) return;
    if (n > 0){ countEl.textContent = n; countEl.classList.add("on"); n--; setTimeout(step, 800); }
    else {
      countEl.classList.remove("on");
      state.motion.phase = "rec"; state.motion.t0 = performance.now();
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
      lm: res.landmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z })),
      hand: res.handedness[0][0].categoryName
    });
  }
  const el = performance.now() - state.motion.t0;
  bannerBar.style.width = Math.min(100, el / state.motion.ms * 100) + "%";
  if (el >= state.motion.ms) finishMotion();
}
function finishMotion(){
  const m = state.motion; state.motion = null;
  bannerEl.classList.remove("on"); countEl.classList.remove("on");
  state.cand = null; state.candCount = 0; state.committed = null; state.noHand = 0; state.readoutLock = 0;
  const seq = toSequence(m.frames, video.videoWidth / video.videoHeight, N_STEPS);
  if (!seq){
    setNote("No detecté movimiento. Mantén la mano visible y haz la seña un poco más amplia.");
  } else if (m.purpose === "train"){
    state.motions.push({ l: m.label, s: seq }); saveAll(); renderList();
    const n = state.motions.filter(x => x.l === m.label).length;
    $("trainHint").textContent = `Listo: “${m.label}” guardada (${n} ${n === 1 ? "grabación" : "grabaciones"}). Graba unas 5 veces para que la reconozca mejor.`;
  } else {
    const r = classifyMotion(seq);
    if (r){ showLocked(r.label, r.src + ` · ${Math.round(r.conf * 100)}% seguro`, true); addToPhrase(r.label); }
    else showLocked("No la reconozco", "", false);
  }
  refreshButtons();
}

/* ---------- Entrenamiento ---------- */
const kind = () => document.querySelector("input[name=kind]:checked").value;
const HINTS = {
  static: "Haz la seña con la mano casi quieta y muévela un poco mientras captura. Repite 2 o 3 veces.",
  motion: "Tras la cuenta regresiva haz el movimiento completo una sola vez. Graba 5 veces o más."
};
function refreshKind(){
  $("btnTrain").textContent = kind() === "static" ? "Capturar seña" : "Grabar movimiento";
  $("trainHint").textContent = HINTS[kind()];
}
document.querySelectorAll("input[name=kind]").forEach(r => r.onchange = refreshKind);

function refreshButtons(){
  const busy = !state.ready || !!(state.motion || state.capState);
  $("btnTrain").disabled = busy;
  $("btnMotion").disabled = busy;
}
function capture(f){
  if (state.capState.phase !== "rec") return;
  state.samples.push({ l: state.capState.label, f: f.map(v => +v.toFixed(4)) });
  state.capState.left--;
  trainBar.style.width = ((CAPTURE_FRAMES - state.capState.left) / CAPTURE_FRAMES * 100) + "%";
  if (state.capState.left <= 0){
    saveAll(); renderList();
    $("trainHint").textContent = `Listo: “${state.capState.label}” guardada. Repite para mejorar la precisión o enseña otra seña.`;
    state.capState = null; refreshButtons();
    setTimeout(() => trainBar.style.width = "0", 600);
  }
}
$("btnTrain").onclick = () => {
  if (!state.ready || state.motion || state.capState) return;
  const label = $("label").value.trim();
  if (!label){ $("trainHint").textContent = "Escribe primero el nombre de la seña."; $("label").focus(); return; }
  if (kind() === "motion"){ startMotion("train", label); return; }
  state.capState = { label, phase: "count", left: CAPTURE_FRAMES };
  $("btnTrain").disabled = true;
  $("btnMotion").disabled = true;
  let n = 3;
  const tick = () => {
    if (n > 0){ $("trainHint").textContent = `Prepara la mano… ${n}`; n--; setTimeout(tick, 800); }
    else { $("trainHint").textContent = "Capturando… muévela un poco."; state.capState = { label, phase: "rec", left: CAPTURE_FRAMES }; }
  };
  tick();
};
$("btnMotion").onclick = () => startMotion("recognize");
document.addEventListener("keydown", e => {
  if (e.code === "Space" && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.target.tagName)){
    e.preventDefault(); startMotion("recognize");
  }
});


return { startMotion, tickMotion, capture, refreshKind, refreshButtons };
}

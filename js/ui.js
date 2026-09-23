export function createUI({ state, dom, saveAll }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const HOLD = 15, CAPTURE_FRAMES = 40;
function setNote(t){ noteEl.textContent = t; }

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
  if (++state.noHand > 8){ state.committed = null; state.cand = null; state.candCount = 0; }
  holdBar.style.width = "0";
}
function addToPhrase(label){
  if (label.length === 1) state.phrase += label;
  else state.phrase += (state.phrase && !state.phrase.endsWith(" ") ? " " : "") + label + " ";
  phraseEl.textContent = state.phrase;
}

function renderList(){
  const groups = {};
  state.samples.forEach(s => { const k = "s|" + s.l; (groups[k] ||= { l: s.l, t: "s", n: 0 }).n++; });
  state.motions.forEach(m => { const k = "m|" + m.l; (groups[k] ||= { l: m.l, t: "m", n: 0 }).n++; });
  listEl.innerHTML = "";
  const items = Object.values(groups);
  if (!items.length){ listEl.innerHTML = '<li class="empty" style="background:none;padding:0">Aún no has enseñado ninguna seña.</li>'; return; }
  items.forEach(g => {
    const li = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("span"); name.className = "name"; name.textContent = g.l;
    const tag = document.createElement("span"); tag.className = "tag " + g.t; tag.textContent = g.t === "s" ? "Fija" : "Movimiento";
    const cnt = document.createElement("span"); cnt.className = "count-txt";
    cnt.textContent = g.t === "s" ? `${Math.max(1, Math.round(g.n / CAPTURE_FRAMES))} capturas` : `${g.n} grabaciones`;
    info.append(name, tag, cnt);
    const b = document.createElement("button"); b.className = "btn line"; b.textContent = "Borrar";
    b.onclick = () => {
      if (g.t === "s") state.samples = state.samples.filter(s => s.l !== g.l);
      else state.motions = state.motions.filter(m => m.l !== g.l);
      saveAll(); renderList();
    };
    li.append(info, b); listEl.appendChild(li);
  });
}

/* ---------- Controles ---------- */
$("btnSpace").onclick = () => { state.phrase += " "; phraseEl.textContent = state.phrase; };
$("btnBack").onclick = () => { state.phrase = state.phrase.slice(0, -1); phraseEl.textContent = state.phrase; };
$("btnClear").onclick = () => { state.phrase = ""; phraseEl.textContent = ""; };
$("btnSpeak").onclick = () => {
  if (!state.phrase.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(state.phrase.trim()); u.lang = "es-419";
  speechSynthesis.speak(u);
};
function bindRange(id, valId, fmt){
  const el = $(id), out = $(valId);
  const upd = () => out.textContent = fmt(+el.value);
  el.oninput = upd; upd();
}
bindRange("tol", "tolVal", v => v.toFixed(2));
bindRange("tolM", "tolMVal", v => v.toFixed(2));
bindRange("dur", "durVal", v => v.toFixed(1) + " s");

/* ---------- Lectura en pantalla ---------- */
function showLocked(text, meta, ok, ms = 2500){
  signEl.textContent = text; signEl.className = "sign" + (ok ? "" : " idle"); metaEl.textContent = meta || "";
  state.readoutLock = performance.now() + ms;
}
function show(r){
  if (performance.now() < state.readoutLock) return;
  if (!r){ signEl.textContent = "No la reconozco"; signEl.className = "sign idle"; metaEl.textContent = ""; return; }
  signEl.textContent = r.label; signEl.className = "sign";
  metaEl.textContent = r.src + (r.conf != null ? ` · ${Math.round(r.conf * 100)}% seguro` : "");
}
function showNoHand(){
  if (performance.now() < state.readoutLock) return;
  signEl.textContent = "Sin mano"; signEl.className = "sign idle"; metaEl.textContent = "";
}


return { setNote, stability, lostHand, addToPhrase, renderList, showLocked, show, showNoHand };
}

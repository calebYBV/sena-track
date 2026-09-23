export function createStorage({ state, dom, ui }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const { setNote, renderList } = ui;
const STORE_KEY = "senas_mediapipe_v2", OLD_KEY = "senas_mediapipe_v1", N_STEPS = 24;
function loadAll(){
  try { const d = JSON.parse(localStorage.getItem(STORE_KEY)); if (d && Array.isArray(d.s)) return { s: d.s, m: d.m || [] }; } catch {}
  try { const o = JSON.parse(localStorage.getItem(OLD_KEY)); if (Array.isArray(o)) return { s: o, m: [] }; } catch {}
  return { s: [], m: [] };
}
function saveAll(){
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ s: state.samples, m: state.motions })); }
  catch { setNote("No se pudo guardar en el navegador. Exporta tus señas para no perderlas."); }
}
$("btnExport").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 2, static: state.samples, motion: state.motions })], { type: "application/json" }));
  a.download = "mis-senas.json"; a.click(); URL.revokeObjectURL(a.href);
};
$("btnImport").onclick = () => $("file").click();
$("file").onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const st = Array.isArray(data) ? data : (data.static || []);
    const mo = Array.isArray(data) ? [] : (data.motion || []);
    const okS = st.every(s => s.l && Array.isArray(s.f) && s.f.length === 63);
    const okM = mo.every(m => m.l && Array.isArray(m.s) && m.s.length === N_STEPS && m.s.every(v => v.length === 65));
    if (okS && okM){ state.samples = state.samples.concat(st); state.motions = state.motions.concat(mo); saveAll(); renderList(); setNote("Señas importadas."); }
    else alert("El archivo no tiene el formato esperado.");
  } catch { alert("No se pudo leer el archivo."); }
  e.target.value = "";
};
$("btnReset").onclick = () => {
  if (confirm("¿Borrar todas las señas que has enseñado?")){ state.samples = []; state.motions = []; saveAll(); renderList(); }
};


return { loadAll, saveAll };
}

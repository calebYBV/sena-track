export function createRecognition({ state, dom }) {
const { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar, phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar } = dom;
const K = 5;
/* PURE-START */
const POS_W = 2;           // peso de la trayectoria de la muñeca frente a la forma de la mano

function shapeFeatures(lm, ar, flip){
  const w = lm[0];
  const pts = lm.map(p => [(p.x - w.x) * ar * flip, p.y - w.y, (p.z - w.z) * ar]);
  const s = Math.max(...pts.map(p => Math.hypot(p[0], p[1], p[2]))) || 1;
  return pts.flat().map(v => v / s);
}
function dist(a, b){
  let s = 0;
  for (let i = 0; i < a.length; i++){ const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
function resample(vecs, n){
  const out = [], L = vecs.length;
  for (let t = 0; t < n; t++){
    const x = t * (L - 1) / (n - 1), i = Math.floor(x), j = Math.min(L - 1, i + 1), f = x - i;
    out.push(vecs[i].map((v, k) => v + (vecs[j][k] - v) * f));
  }
  return out;
}
/* Convierte una grabación (lista de frames) en una secuencia de N_STEPS vectores.
   Recorta las partes en que la mano está quieta. Devuelve null si no hubo movimiento. */
function toSequence(frames, ar, n = 24, thr = 0.035){
  if (frames.length < 8) return null;
  const left = frames.filter(f => f.hand === "Left").length;
  const flip = left > frames.length / 2 ? -1 : 1;
  const shapes = frames.map(f => shapeFeatures(f.lm, ar, flip));
  const wr = frames.map(f => [f.lm[0].x * ar * flip, f.lm[0].y]);
  const hsz = frames.reduce((a, f) => a + Math.hypot((f.lm[9].x - f.lm[0].x) * ar, f.lm[9].y - f.lm[0].y), 0) / frames.length || 0.1;
  const e = frames.map((_, i) => {
    if (i === 0) return 0;
    const dw = Math.hypot(wr[i][0] - wr[i - 1][0], wr[i][1] - wr[i - 1][1]) / hsz;
    return dw + 0.25 * dist(shapes[i], shapes[i - 1]);
  });
  const sm = e.map((_, i) => ((e[i - 1] ?? e[i]) + e[i] + (e[i + 1] ?? e[i])) / 3);
  let a = sm.findIndex(v => v > thr);
  if (a < 0) return null;
  let b = sm.length - 1 - [...sm].reverse().findIndex(v => v > thr);
  if (b - a < 5) return null;
  a = Math.max(0, a - 3); b = Math.min(frames.length - 1, b + 3);
  const vecs = [];
  for (let i = a; i <= b; i++){
    const px = (wr[i][0] - wr[a][0]) / hsz * POS_W;
    const py = (wr[i][1] - wr[a][1]) / hsz * POS_W;
    vecs.push([...shapes[i], px, py]);
  }
  return resample(vecs, n).map(v => v.map(x => +x.toFixed(3)));
}
/* Distancia DTW normalizada entre dos secuencias */
function dtw(a, b){
  const n = a.length, m = b.length, INF = 1e9;
  let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++){
    cur[0] = INF;
    for (let j = 1; j <= m; j++){
      cur[j] = dist(a[i - 1], b[j - 1]) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}
/* ---------- Señas fijas: KNN ---------- */
function features(lm, hand){
  return shapeFeatures(lm, video.videoWidth / video.videoHeight, hand === "Left" ? -1 : 1);
}
function classify(f){
  if (!state.samples.length) return null;
  const ds = state.samples.map(s => [dist(f, s.f), s.l]).sort((a, b) => a[0] - b[0]).slice(0, K);
  if (ds[0][0] > parseFloat($("tol").value)) return null;
  const votes = {}; let total = 0;
  for (const [d, l] of ds){ const w = 1 / (d + 0.05); votes[l] = (votes[l] || 0) + w; total += w; }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const conf = best[1] / total;
  if (conf < 0.55) return null;
  return { label: best[0], conf, src: "seña fija" };
}

/* ---------- Gestos básicos por reglas ---------- */
function ruleSign(lm){
  const ar = video.videoWidth / video.videoHeight;
  const P = lm.map(p => [p.x * ar, p.y]);
  const d = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]);
  const [idx, mid, ring, pink] = [8, 12, 16, 20].map(t => d(t, 0) > d(t - 2, 0) * 1.05);
  const thumb = d(4, 17) > d(2, 17) * 1.15;
  const thumbUp = thumb && P[4][1] < P[5][1];
  let label = null;
  if (idx && mid && ring && pink && thumb) label = "Hola";
  else if (!idx && !mid && !ring && !pink) label = thumbUp ? "Bien" : "Puño";
  else if (idx && mid && !ring && !pink) label = "Paz";
  else if (idx && !mid && !ring && !pink && !thumb) label = "Uno";
  else if (thumb && idx && !mid && !ring && pink) label = "Te quiero";
  return label ? { label, conf: null, src: "gesto básico" } : null;
}

/* ---------- Señas con movimiento: DTW ---------- */
function classifyMotion(seq){
  if (!state.motions.length) return null;
  const tol = parseFloat($("tolM").value);
  const best = {};
  for (const m of state.motions){
    const d = dtw(seq, m.s);
    if (best[m.l] === undefined || d < best[m.l]) best[m.l] = d;
  }
  const arr = Object.entries(best).sort((a, b) => a[1] - b[1]);
  const [label, d1] = arr[0];
  if (d1 > tol) return null;
  const conf = arr.length > 1 ? arr[1][1] / (d1 + arr[1][1]) : Math.max(0, 1 - d1 / tol);
  return { label, conf, src: "seña con movimiento" };
}


return { features, classify, ruleSign, classifyMotion, toSequence };
}

export function calculateDistanceReduction(rawDistance, filteredDistance){
  if (!Number.isFinite(rawDistance) || !Number.isFinite(filteredDistance) || rawDistance <= 1e-9) return null;
  return 100 * (rawDistance - filteredDistance) / rawDistance;
}

export function createRecognition({ state, dom }){
const { $, video } = dom;
const K = 5;
const POS_W = 2;

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
function sequenceWindow(frames, ar, thr){
  if (frames.length < 8) return null;
  const left = frames.filter(f => f.hand === "Left").length;
  const flip = left > frames.length / 2 ? -1 : 1;
  const shapes = frames.map(f => shapeFeatures(f.lm, ar, flip));
  const wr = frames.map(f => [f.lm[0].x * ar * flip, f.lm[0].y]);
  const hsz = frames.reduce((a, f) => a + Math.hypot((f.lm[9].x - f.lm[0].x) * ar, f.lm[9].y - f.lm[0].y), 0) / frames.length || 0.1;
  const energy = frames.map((_, i) => {
    if (i === 0) return 0;
    const dw = Math.hypot(wr[i][0] - wr[i - 1][0], wr[i][1] - wr[i - 1][1]) / hsz;
    return dw + 0.25 * dist(shapes[i], shapes[i - 1]);
  });
  const smoothed = energy.map((_, i) => ((energy[i - 1] ?? energy[i]) + energy[i] + (energy[i + 1] ?? energy[i])) / 3);
  let start = smoothed.findIndex(v => v > thr);
  if (start < 0) return null;
  let end = smoothed.length - 1 - [...smoothed].reverse().findIndex(v => v > thr);
  if (end - start < 5) return null;
  return { start: Math.max(0, start - 3), end: Math.min(frames.length - 1, end + 3) };
}
function sequenceFromWindow(frames, ar, n, window){
  const left = frames.slice(window.start, window.end + 1).filter(f => f.hand === "Left").length;
  const flip = left > (window.end - window.start + 1) / 2 ? -1 : 1;
  const shapes = frames.map(f => shapeFeatures(f.lm, ar, flip));
  const wr = frames.map(f => [f.lm[0].x * ar * flip, f.lm[0].y]);
  const hsz = frames.reduce((a, f) => a + Math.hypot((f.lm[9].x - f.lm[0].x) * ar, f.lm[9].y - f.lm[0].y), 0) / frames.length || 0.1;
  const vecs = [];
  for (let i = window.start; i <= window.end; i++){
    const px = (wr[i][0] - wr[window.start][0]) / hsz * POS_W;
    const py = (wr[i][1] - wr[window.start][1]) / hsz * POS_W;
    vecs.push([...shapes[i], px, py]);
  }
  return resample(vecs, n).map(v => v.map(x => +x.toFixed(3)));
}
function toSequence(frames, ar, n = 24, thr = 0.035){
  const window = sequenceWindow(frames, ar, thr);
  return window ? sequenceFromWindow(frames, ar, n, window) : null;
}
function toSequencePair(rawFrames, filteredFrames, ar, n = 24, thr = 0.035){
  if (rawFrames.length !== filteredFrames.length) throw new RangeError("Las secuencias raw y filtrada deben estar sincronizadas.");
  if (rawFrames.some((frame, index) =>
    frame.hand !== filteredFrames[index].hand || frame.time !== filteredFrames[index].time)){
    throw new RangeError("Las secuencias deben conservar la misma mano y los mismos tiempos de origen.");
  }
  const window = sequenceWindow(rawFrames, ar, thr);
  if (!window) return null;
  return {
    raw: sequenceFromWindow(rawFrames, ar, n, window),
    filtered: sequenceFromWindow(filteredFrames, ar, n, window)
  };
}
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
function features(lm, hand){
  return shapeFeatures(lm, video.videoWidth / video.videoHeight, hand === "Left" ? -1 : 1);
}
function references(sample, branch){
  return branch === "raw" ? (sample.r || sample.f) : sample.f;
}
function staticDistances(f, branch){
  const best = {};
  for (const sample of state.samples){
    const reference = references(sample, branch);
    if (!Array.isArray(reference) || reference.length !== f.length) continue;
    const distance = dist(f, reference);
    if (best[sample.l] === undefined || distance < best[sample.l]) best[sample.l] = distance;
  }
  return best;
}
function classify(f, branch = "filtered"){
  const ds = [];
  for (const sample of state.samples){
    const reference = references(sample, branch);
    if (Array.isArray(reference) && reference.length === f.length){
      ds.push([dist(f, reference), sample.l]);
    }
  }
  ds.sort((a, b) => a[0] - b[0]);
  ds.length = Math.min(ds.length, K);
  if (!ds.length || ds[0][0] > parseFloat($("tol").value)) return null;
  const votes = {}; let total = 0;
  for (const [distance, label] of ds){ const weight = 1 / (distance + 0.05); votes[label] = (votes[label] || 0) + weight; total += weight; }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const score = best[1] / total;
  if (score < 0.55) return null;
  return { label: best[0], conf: score, src: "seña fija" };
}
function ruleSign(lm){
  const ar = video.videoWidth / video.videoHeight;
  const P = lm.map(p => [p.x * ar, p.y]);
  const d = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]);
  const [idx, mid, ring, pink] = [8, 12, 16, 20].map(t => d(t, 0) > d(t - 2, 0) * 1.05);
  const thumb = d(4, 17) > d(2, 17) * 1.15;
  const thumbUp = thumb && P[4][1] < P[5][1];
  let label = null;
  if (idx && mid && ring && pink && thumb) label = "Hola";
  else if (idx && mid && ring && pink && !thumb) label = "Cuatro";
  else if (!idx && !mid && !ring && !pink) label = thumbUp ? "Bien" : "Puño";
  else if (idx && mid && ring && !pink && !thumb) label = "Tres";
  else if (idx && mid && !ring && !pink) label = "Dos";
  else if (idx && !mid && !ring && !pink && thumb) label = "L";
  else if (idx && !mid && !ring && !pink && !thumb) label = "Uno";
  else if (thumb && idx && !mid && !ring && pink) label = "Te quiero";
  return label ? { label, conf: null, src: "gesto básico" } : null;
}
function motionReferences(motion, branch){
  return branch === "raw" ? (motion.r || motion.s) : motion.s;
}
function motionDistances(seq, branch){
  const best = {};
  for (const motion of state.motions){
    const reference = motionReferences(motion, branch);
    if (!Array.isArray(reference)) continue;
    const distance = dtw(seq, reference);
    if (best[motion.l] === undefined || distance < best[motion.l]) best[motion.l] = distance;
  }
  return best;
}
function classifyMotion(seq, branch = "filtered"){
  const tol = parseFloat($("tolM").value);
  const best = motionDistances(seq, branch);
  const arr = Object.entries(best).sort((a, b) => a[1] - b[1]);
  if (!arr.length) return null;
  const [label, distance] = arr[0];
  if (distance > tol) return null;
  const score = arr.length > 1 ? arr[1][1] / (distance + arr[1][1]) : Math.max(0, 1 - distance / tol);
  return { label, conf: score, src: "seña con movimiento" };
}

return { features, classify, ruleSign, classifyMotion, toSequence, toSequencePair,
  staticDistances, motionDistances, calculateDistanceReduction };
}

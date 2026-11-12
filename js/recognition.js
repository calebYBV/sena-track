import { addMotionTrajectory, extractHolisticFeatures, holisticDistance } from "./holistic.js";
import { createEdoFilter, DEFAULT_FILTER_CONFIG, normalizeFilterConfig } from "./filters.js";

export function calculateDistanceReduction(rawDistance, filteredDistance){
  if (!Number.isFinite(rawDistance) || !Number.isFinite(filteredDistance) || rawDistance <= 1e-6) return null;
  return 100 * (rawDistance - filteredDistance) / rawDistance;
}

export const DEFAULT_AMBIGUITY_CONFIG = Object.freeze({
  absoluteMargin: 0.04,
  relativeMargin: 0.08
});

export function normalizeAmbiguityConfig(config){
  const candidate = { ...DEFAULT_AMBIGUITY_CONFIG, ...(config || {}) };
  return {
    absoluteMargin: Number.isFinite(candidate.absoluteMargin) &&
      candidate.absoluteMargin >= 0 && candidate.absoluteMargin <= 0.5
      ? candidate.absoluteMargin : DEFAULT_AMBIGUITY_CONFIG.absoluteMargin,
    relativeMargin: Number.isFinite(candidate.relativeMargin) &&
      candidate.relativeMargin >= 0 && candidate.relativeMargin <= 0.5
      ? candidate.relativeMargin : DEFAULT_AMBIGUITY_CONFIG.relativeMargin
  };
}

export function createRecognition({ state, dom }){
const { $, video } = dom;
const K = 5;
const POS_W = 2;
const MIN_MOTION_CONFIDENCE = 0.55;
const filteredReferences = new WeakMap();
const unreplayableReferences = new WeakSet();
const failedReferenceReplays = new WeakSet();
let preparedModel = null, preparedTau = null, preparedZeta = null, preparedOmegaN = null;
let preparedAspect = null;
let preparedSamples = null, preparedMotions = null, preparedSampleCount = -1, preparedMotionCount = -1;

function filterFrames(rawFrames, config){
  const filter = createEdoFilter();
  const asPoint = value => Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2] } : value;
  return rawFrames.map(frame => {
    const active = [];
    const filtered = { time: frame.time, hands: {} };
    for (const side of ["Left", "Right"]){
      const points = frame.hands?.[side];
      if (!points) continue;
      const identity = `hand:${side}`;
      const result = filter.process(points.map(asPoint), identity, frame.time, config);
      filtered.hands[side] = result;
      active.push(identity);
    }
    if (frame.faceLandmarks){
      filtered.faceLandmarks = filter.process(
        frame.faceLandmarks.map(asPoint), "face", frame.time, config);
      active.push("face");
    }
    if (Array.isArray(frame.faceFeatures)){
      filtered.faceFeatures = filter.process(
        frame.faceFeatures.map(value => ({ x: value, y: 0, z: 0 })),
        "face:features", frame.time, config
      ).map(point => point.x);
      active.push("face:features");
    }
    filter.retain(active);
    return filtered;
  });
}

function canReplayReference(sample){
  return sample.source === "paired-raw-and-filtered-v2" &&
    Array.isArray(sample.rawFrames) && sample.rawFrames.length >= 8;
}

function regenerateReference(sample, config, aspect){
  if (!canReplayReference(sample)) return null;
  const frames = filterFrames(sample.rawFrames, normalizeFilterConfig(config));
  if (sample.kind === "motion" || Array.isArray(sample.rawHolisticSequence)){
    const sequence = holisticMotionSequence(frames, sample.components, aspect);
    return sequence ? { motion: sequence } : null;
  }
  const descriptors = frames.map(frame =>
    extractHolisticFeatures(frame, aspect, sample.components));
  if (descriptors.some(descriptor => !descriptor)) return null;
  return { static: meanDescriptors(descriptors) };
}

function prepareFilteredReferences(config = state.filterConfig || DEFAULT_FILTER_CONFIG){
  const normalized = normalizeFilterConfig(config);
  const aspect = video.videoWidth / video.videoHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return;
  if (preparedModel === normalized.model && preparedTau === normalized.tau &&
      preparedZeta === normalized.zeta && preparedOmegaN === normalized.omegaN &&
      preparedAspect === aspect &&
      preparedSamples === state.samples && preparedMotions === state.motions &&
      preparedSampleCount === state.samples.length && preparedMotionCount === state.motions.length){
    return;
  }
  preparedModel = normalized.model;
  preparedTau = normalized.tau;
  preparedZeta = normalized.zeta;
  preparedOmegaN = normalized.omegaN;
  preparedAspect = aspect;
  preparedSamples = state.samples;
  preparedMotions = state.motions;
  preparedSampleCount = state.samples.length;
  preparedMotionCount = state.motions.length;
  for (const sample of [...state.samples, ...state.motions]){
    const reference = regenerateReference(sample, normalized, aspect);
    filteredReferences.set(sample, reference);
    if (!reference && !canReplayReference(sample)) unreplayableReferences.add(sample);
    else unreplayableReferences.delete(sample);
    if (canReplayReference(sample) && !reference) failedReferenceReplays.add(sample);
    else failedReferenceReplays.delete(sample);
  }
}

function hasFilterReferenceMismatch(sample){
  return unreplayableReferences.has(sample) || failedReferenceReplays.has(sample);
}

function sampleReference(sample, branch, kind = "static"){
  if (branch === "raw") return kind === "motion"
    ? sample.rawHolisticSequence : sample.rh;
  return filteredReferences.get(sample)?.[kind] ||
    (kind === "motion" ? sample.filteredHolisticSequence : sample.h);
}

function classifyCandidates(entries, threshold, ambiguityConfig = state.ambiguityConfig){
  const bestByLabel = new Map();
  for (const [distance, label] of entries){
    if (!Number.isFinite(distance)) continue;
    const current = bestByLabel.get(label);
    if (current === undefined || distance < current) bestByLabel.set(label, distance);
  }
  const ranked = [...bestByLabel].sort((a, b) => a[1] - b[1]);
  if (!ranked.length) return null;
  const [label, distance] = ranked[0];
  if (distance > threshold) return null;
  const next = ranked[1];
  if (next){
    const absoluteGap = next[1] - distance;
    const relativeGap = absoluteGap / Math.max(next[1], 1e-9);
    const margins = normalizeAmbiguityConfig(ambiguityConfig);
    if (absoluteGap <= margins.absoluteMargin &&
        relativeGap <= margins.relativeMargin){
      return {
        label: null,
        reason: "ambiguous",
        candidates: [label, next[0]],
        distance,
        nextDistance: next[1],
        conf: 0
      };
    }
    const confidence = next[1] / Math.max(1e-9, distance + next[1]);
    return { label, conf: confidence, src: "seña guardada" };
  }
  return {
    label,
    conf: Math.max(0, 1 - distance / threshold),
    src: "seña guardada"
  };
}

function classifyStaticDescriptor(descriptor, components, branch = "filtered"){
  prepareFilteredReferences();
  const entries = [];
  for (const sample of state.samples){
    if (sample.syncStatus === "pending" || !sample.components ||
        ["left", "right", "face"].some(key => sample.components[key] !== components[key])) continue;
    const reference = sampleReference(sample, branch);
    if (!reference) continue;
    entries.push([descriptorDistance(descriptor, reference, components), sample.l]);
  }
  return classifyCandidates(entries, Number.parseFloat($("tol").value));
}

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
    if (sample.syncStatus === "pending") continue;
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
    if (sample.syncStatus === "pending") continue;
    const reference = references(sample, branch);
    if (Array.isArray(reference) && reference.length === f.length){
      ds.push([dist(f, reference), sample.l]);
    }
  }
  ds.sort((a, b) => a[0] - b[0]);
  ds.length = Math.min(ds.length, K);
  if (!ds.length || ds[0][0] > parseFloat($("tol").value)) return null;
  const ambiguity = classifyCandidates(ds, parseFloat($("tol").value));
  if (ambiguity?.reason === "ambiguous") return ambiguity;
  const votes = {}; let total = 0;
  for (const [distance, label] of ds){ const weight = 1 / (distance + 0.05); votes[label] = (votes[label] || 0) + weight; total += weight; }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const score = best[1] / total;
  if (score < 0.55) return null;
  return { label: best[0], conf: score, src: "seña fija" };
}

function evaluateStaticFrame(frame, branch){
  prepareFilteredReferences();
  const entries = [];
  const aspect = video.videoWidth / video.videoHeight;
  const descriptorCache = new Map();
  const descriptorFor = (key, create) => {
    if (!descriptorCache.has(key)) descriptorCache.set(key, create());
    return descriptorCache.get(key);
  };
  for (const sample of state.samples){
    if (sample.syncStatus === "pending") continue;
    if (sample.components){
      const reference = sampleReference(sample, branch);
      if (!reference || typeof reference !== "object") continue;
      const key = `${Number(sample.components.left)}${Number(sample.components.right)}${Number(sample.components.face)}`;
      const descriptor = descriptorFor(key, () => extractHolisticFeatures(frame, aspect, sample.components));
      if (!descriptor) continue;
      entries.push([descriptorDistance(descriptor, reference, sample.components), sample.l, sample]);
      continue;
    }
    const reference = references(sample, branch);
    const storedSide = sample.captureMeta?.handedness || sample.handedness;
    const handSide = storedSide
      ? (frame.hands?.[storedSide] ? storedSide : null)
      : frame.hands?.Left ? "Left" : frame.hands?.Right ? "Right" : null;
    if (!handSide || !Array.isArray(reference)) continue;
    const descriptor = descriptorFor(`legacy:${handSide}`, () =>
      features(frame.hands[handSide], handSide));
    if (reference.length === descriptor.length){
      entries.push([dist(descriptor, reference), sample.l, sample]);
    }
  }

  entries.sort((a, b) => a[0] - b[0]);
  const distances = {};
  for (const [distance, label] of entries){
    if (distances[label] === undefined || distance < distances[label]){
      distances[label] = distance;
    }
  }
  return {
    prediction: classifyCandidates(entries, Number.parseFloat($("tol").value)),
    distances,
    entries
  };
}

function pairedDistances(rawEntries, filteredEntries){
  const filteredBySample = new Map(filteredEntries.map(entry => [entry[2], entry[0]]));
  const candidates = new Map();
  for (const [rawDistance, label, sample] of rawEntries){
    const filteredDistance = filteredBySample.get(sample);
    if (!Number.isFinite(rawDistance) || !Number.isFinite(filteredDistance)) continue;
    const candidate = { sample, rawDistance, filteredDistance };
    const current = candidates.get(label);
    if (!current || rawDistance + filteredDistance < current.rawDistance + current.filteredDistance){
      candidates.set(label, candidate);
    }
  }
  const rawDistances = {}, filteredDistances = {};
  for (const [label, candidate] of candidates){
    rawDistances[label] = candidate.rawDistance;
    filteredDistances[label] = candidate.filteredDistance;
  }
  return { rawDistances, filteredDistances };
}

function compareStaticFrames(rawFrame, filteredFrame){
  const raw = evaluateStaticFrame(rawFrame, "raw");
  const filtered = evaluateStaticFrame(filteredFrame, "filtered");
  const paired = pairedDistances(raw.entries, filtered.entries);
  return {
    rawPrediction: raw.prediction,
    filteredPrediction: filtered.prediction,
    ...paired
  };
}

function meanDescriptors(descriptors){
  const average = key => {
    const vectors = descriptors.map(item => item[key]).filter(Array.isArray);
    if (!vectors.length) return null;
    return vectors[0].map((_, index) =>
      vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  };
  const hands = {};
  for (const side of ["Left", "Right"]){
    const vectors = descriptors.map(item => item.hands?.[side]).filter(Array.isArray);
    if (vectors.length) hands[side] = vectors[0].map((_, index) =>
      vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  }
  const placement = {};
  for (const side of ["Left", "Right"]){
    const vectors = descriptors.map(item => item.placement?.[side]).filter(Array.isArray);
    if (vectors.length) placement[side] = vectors[0].map((_, index) =>
      vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  }
  return { hands, placement: Object.keys(placement).length ? placement : null, face: average("face") };
}

function descriptorDistance(a, b, required){
  return holisticDistance(a, b, required);
}

function interpolateDescriptor(a, b, fraction){
  const interpolateArray = (x, y) => x.map((value, index) => value + (y[index] - value) * fraction);
  const hands = {}, placement = {}, trajectory = {};
  for (const side of ["Left", "Right"]){
    if (a.hands?.[side] && b.hands?.[side]) hands[side] = interpolateArray(a.hands[side], b.hands[side]);
    if (a.placement?.[side] && b.placement?.[side]) placement[side] = interpolateArray(a.placement[side], b.placement[side]);
    if (a.trajectory?.[side] && b.trajectory?.[side]){
      trajectory[side] = interpolateArray(a.trajectory[side], b.trajectory[side]);
    }
  }
  if (a.trajectory?.face && b.trajectory?.face){
    trajectory.face = interpolateArray(a.trajectory.face, b.trajectory.face);
  }
  return {
    hands,
    placement: Object.keys(placement).length ? placement : null,
    trajectory: Object.keys(trajectory).length ? trajectory : null,
    face: a.face && b.face ? interpolateArray(a.face, b.face) : null
  };
}
function resampleDescriptors(frames, count = 24, times = null){
  if (!frames.length) return [];
  const positions = times?.length === frames.length
    ? times.map(time => (time - times[0]) / Math.max(1e-9, times.at(-1) - times[0]))
    : frames.map((_, index) => index / Math.max(1, frames.length - 1));
  return Array.from({ length: count }, (_, index) => {
    const target = index / (count - 1);
    let end = positions.findIndex(position => position >= target);
    if (end < 0) end = frames.length - 1;
    const start = Math.max(0, end - 1);
    const span = positions[end] - positions[start];
    const fraction = span > 0 ? (target - positions[start]) / span : 0;
    return interpolateDescriptor(frames[start], frames[end], fraction);
  });
}
function holisticMotionSequence(frames, required, aspect, count = 24){
  if (!Array.isArray(frames) || frames.length < 8) return null;
  const descriptors = frames.map(frame => extractHolisticFeatures(frame, aspect, required));
  if (descriptors.some(descriptor => !descriptor)) return null;
  const withTrajectory = addMotionTrajectory(descriptors, frames, required, aspect);
  if (!withTrajectory) return null;
  return resampleDescriptors(withTrajectory, count, frames.map(frame => frame.time));
}
function holisticMotionReference(sample, branch, aspect){
  const reference = branch === "raw"
    ? sample.rawHolisticSequence
    : sampleReference(sample, "filtered", "motion");
  if (!Array.isArray(reference)) return null;
  const sides = ["Left", "Right"].filter(side => sample.components[side.toLowerCase()]);
  const tracks = [...sides, ...(sample.components.face ? ["face"] : [])];
  if (reference.every(frame => tracks.every(side => Array.isArray(frame.trajectory?.[side])))){
    return reference;
  }
  const sourceFrames = branch === "raw" ? sample.rawFrames : sample.filteredFrames;
  return holisticMotionSequence(sourceFrames, sample.components, aspect) || reference;
}
function holisticDtw(a, b, required){
  const n = a.length, m = b.length, infinity = Number.POSITIVE_INFINITY;
  let previous = new Float64Array(m + 1).fill(infinity);
  let current = new Float64Array(m + 1).fill(infinity);
  previous[0] = 0;
  for (let i = 1; i <= n; i++){
    current[0] = infinity;
    for (let j = 1; j <= m; j++){
      current[j] = descriptorDistance(a[i - 1], b[j - 1], required) +
        Math.min(previous[j], current[j - 1], previous[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[m] / (n + m);
}
function motionReferences(motion, branch){
  return branch === "raw" ? (motion.r || motion.s) : motion.s;
}
function motionDistances(seq, branch){
  prepareFilteredReferences();
  const best = {};
  for (const motion of state.motions){
    if (motion.syncStatus === "pending") continue;
    const reference = motion.components
      ? sampleReference(motion, branch, "motion")
      : motionReferences(motion, branch);
    if (!Array.isArray(reference)) continue;
    const distance = dtw(seq, reference);
    if (best[motion.l] === undefined || distance < best[motion.l]) best[motion.l] = distance;
  }
  return best;
}
function classifyMotion(seq, branch = "filtered"){
  prepareFilteredReferences();
  const tol = parseFloat($("tolM").value);
  const best = motionDistances(seq, branch);
  const arr = Object.entries(best).sort((a, b) => a[1] - b[1]);
  if (!arr.length) return null;
  const prediction = classifyCandidates(arr, tol);
  if (!prediction?.label || prediction.conf < MIN_MOTION_CONFIDENCE) return prediction?.reason === "ambiguous" ? prediction : null;
  return { ...prediction, src: "seña con movimiento" };
}

function classifyFrame(frame, branch = "filtered", kind = "static"){
  prepareFilteredReferences();
  const isMotion = kind === "motion";
  if (!isMotion) return evaluateStaticFrame(frame, branch).prediction;
  const examples = isMotion ? state.motions : state.samples;
  const field = branch === "raw" ? (isMotion ? "rawHolisticSequence" : "rh") :
    (isMotion ? "filteredHolisticSequence" : "h");
  const entries = [];
  const aspect = video.videoWidth / video.videoHeight;
  for (const sample of examples){
    if (sample.syncStatus === "pending") continue;
    const hasReference = isMotion ? Array.isArray(sample[field]) :
      sample[field] && typeof sample[field] === "object";
    const activeReference = sample.components
      ? sampleReference(sample, branch, isMotion ? "motion" : "static")
      : null;
    const referenceAvailable = sample.components
      ? Array.isArray(activeReference) || activeReference && typeof activeReference === "object"
      : hasReference;
    if (sample.components && referenceAvailable){
      const sourceFrames = branch === "raw" ? frame.rawFrames : frame.filteredFrames;
      const descriptor = isMotion ? null : extractHolisticFeatures(frame, aspect, sample.components);
      const reference = isMotion
        ? holisticMotionReference(sample, branch, aspect) : [activeReference];
      if (!reference) continue;
      if (isMotion && !sourceFrames?.length) continue;
      if (!isMotion && !descriptor || !reference.length) continue;
      const query = isMotion
        ? holisticMotionSequence(sourceFrames, sample.components, aspect) : descriptor;
      if (isMotion){
        if (!query) continue;
        entries.push([holisticDtw(query, reference, sample.components), sample.l]);
      } else {
        entries.push([descriptorDistance(descriptor, reference[0], sample.components), sample.l]);
      }
      continue;
    }
    if (sample.components) continue;
    if (isMotion){
      const sequence = branch === "raw" ? frame.rawLegacySequence : frame.filteredLegacySequence;
      const reference = branch === "raw" ? (sample.r || sample.s) : sample.s;
      if (sequence && Array.isArray(reference)) entries.push([dtw(sequence, reference), sample.l]);
    } else {
      const storedSide = sample.captureMeta?.handedness || sample.handedness;
      const handSide = storedSide
        ? (frame.hands?.[storedSide] ? storedSide : null)
        : frame.hands?.Left ? "Left" : frame.hands?.Right ? "Right" : null;
      const reference = references(sample, branch);
      if (!handSide || !Array.isArray(reference)) continue;
      const featuresValue = features(frame.hands[handSide], handSide);
      if (reference.length === featuresValue.length){
        entries.push([dist(featuresValue, reference), sample.l]);
      }
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  if (!entries.length) return null;
  const threshold = Number.parseFloat($(isMotion ? "tolM" : "tol").value);
  const prediction = classifyCandidates(entries, threshold);
  if (!prediction?.label) return prediction;
  if (isMotion && prediction.conf < MIN_MOTION_CONFIDENCE) return null;
  return { ...prediction, src: isMotion ? "seña guardada con movimiento" : "seña guardada" };
}

function holisticDistances(frame, branch = "filtered", kind = "static"){
  prepareFilteredReferences();
  const isMotion = kind === "motion";
  if (!isMotion) return evaluateStaticFrame(frame, branch).distances;
  const examples = isMotion ? state.motions : state.samples;
  const field = branch === "raw" ? (isMotion ? "rawHolisticSequence" : "rh") :
    (isMotion ? "filteredHolisticSequence" : "h");
  const best = {};
  const aspect = video.videoWidth / video.videoHeight;
  for (const sample of examples){
    if (sample.syncStatus === "pending") continue;
    const hasReference = isMotion ? Array.isArray(sample[field]) :
      sample[field] && typeof sample[field] === "object";
    const activeReference = sample.components
      ? sampleReference(sample, branch, isMotion ? "motion" : "static")
      : null;
    const referenceAvailable = sample.components
      ? Array.isArray(activeReference) || activeReference && typeof activeReference === "object"
      : hasReference;
    if (!sample.components || !referenceAvailable) continue;
    const sourceFrames = branch === "raw" ? frame.rawFrames : frame.filteredFrames;
    const descriptor = isMotion ? null : extractHolisticFeatures(frame, aspect, sample.components);
    if (isMotion && !sourceFrames?.length || !isMotion && !descriptor) continue;
    const query = isMotion ? holisticMotionSequence(sourceFrames, sample.components, aspect) : null;
    if (isMotion && !query) continue;
    const reference = isMotion
      ? holisticMotionReference(sample, branch, aspect) : activeReference;
    if (!reference) continue;
    const distance = isMotion
      ? holisticDtw(query, reference, sample.components)
      : descriptorDistance(descriptor, reference[0], sample.components);
    if (Number.isFinite(distance) &&
        (best[sample.l] === undefined || distance < best[sample.l])) best[sample.l] = distance;
  }
  if (!isMotion){
    for (const sample of examples){
      if (sample.syncStatus === "pending" || sample.components) continue;
      const storedSide = sample.captureMeta?.handedness || sample.handedness;
      const side = storedSide
        ? (frame.hands?.[storedSide] ? storedSide : null)
        : frame.hands?.Left ? "Left" : frame.hands?.Right ? "Right" : null;
      if (side){
        const query = features(frame.hands[side], side);
        const reference = references(sample, branch);
        if (!Array.isArray(reference) || reference.length !== query.length) continue;
        const distance = dist(query, reference);
        if (best[sample.l] === undefined || distance < best[sample.l]) best[sample.l] = distance;
      }
    }
  }
  return best;
}

function pairedHolisticDistances(frame, kind = "static"){
  prepareFilteredReferences();
  const examples = kind === "motion" ? state.motions : state.samples;
  const aspect = video.videoWidth / video.videoHeight;
  const rawFrame = frame.rawFrame || frame;
  const filteredFrame = frame.filteredFrame || frame;
  const candidates = new Map();
  for (const sample of examples){
    if (sample.syncStatus === "pending") continue;
    let rawDistance, filteredDistance;
    if (sample.components && kind === "static"){
      const rawReference = sampleReference(sample, "raw");
      const filteredReference = sampleReference(sample, "filtered");
      if (!rawReference || !filteredReference) continue;
      const rawDescriptor = extractHolisticFeatures(rawFrame, aspect, sample.components);
      const filteredDescriptor = extractHolisticFeatures(filteredFrame, aspect, sample.components);
      if (!rawDescriptor || !filteredDescriptor) continue;
      rawDistance = descriptorDistance(rawDescriptor, rawReference, sample.components);
      filteredDistance = descriptorDistance(filteredDescriptor, filteredReference, sample.components);
    } else if (sample.components && kind === "motion"){
      const rawSources = frame.rawFrames, filteredSources = frame.filteredFrames;
      if (!Array.isArray(rawSources) || !Array.isArray(filteredSources) ||
          rawSources.length !== filteredSources.length ||
          !Array.isArray(sample.rawHolisticSequence) || !Array.isArray(sample.filteredHolisticSequence)) continue;
      const times = rawSources.map(item => item.time);
      if (!times.every(Number.isFinite) || filteredSources.some((item, index) => item.time !== times[index])) continue;
      const rawSequence = holisticMotionSequence(rawSources, sample.components, aspect);
      const filteredSequence = holisticMotionSequence(filteredSources, sample.components, aspect);
      if (!rawSequence || !filteredSequence) continue;
      const rawReference = holisticMotionReference(sample, "raw", aspect);
      const filteredReference = holisticMotionReference(sample, "filtered", aspect);
      if (!rawReference || !filteredReference) continue;
      rawDistance = holisticDtw(rawSequence, rawReference, sample.components);
      filteredDistance = holisticDtw(filteredSequence, filteredReference, sample.components);
    } else if (!sample.components && kind === "motion"){
      const rawReference = sample.r || sample.s, filteredReference = sample.s;
      if (!Array.isArray(frame.rawLegacySequence) || !Array.isArray(frame.filteredLegacySequence) ||
          !Array.isArray(rawReference) || !Array.isArray(filteredReference)) continue;
      rawDistance = dtw(frame.rawLegacySequence, rawReference);
      filteredDistance = dtw(frame.filteredLegacySequence, filteredReference);
    } else {
      const side = sample.captureMeta?.handedness || sample.handedness ||
        (rawFrame.hands?.Left ? "Left" : rawFrame.hands?.Right ? "Right" : null);
      if (!side || !rawFrame.hands?.[side] || !filteredFrame.hands?.[side]) continue;
      const rawReference = sample.r || sample.f, filteredReference = sample.f;
      if (!Array.isArray(rawReference) || !Array.isArray(filteredReference)) continue;
      rawDistance = dist(features(rawFrame.hands[side], side), rawReference);
      filteredDistance = dist(features(filteredFrame.hands[side], side), filteredReference);
    }
    if (!Number.isFinite(rawDistance) || !Number.isFinite(filteredDistance)) continue;
    const current = candidates.get(sample.l);
    if (!current || rawDistance + filteredDistance < current.rawDistance + current.filteredDistance){
      candidates.set(sample.l, { rawDistance, filteredDistance });
    }
  }
  const rawDistances = {}, filteredDistances = {};
  for (const [label, pair] of candidates){
    rawDistances[label] = pair.rawDistance;
    filteredDistances[label] = pair.filteredDistance;
  }
  return { rawDistances, filteredDistances };
}

return { features, classify, classifyMotion, classifyFrame, holisticDistances, meanDescriptors,
  resampleDescriptors, holisticMotionSequence, toSequence, toSequencePair, staticDistances, motionDistances,
  compareStaticFrames, pairedHolisticDistances, calculateDistanceReduction, prepareFilteredReferences,
  filterFrames, classifyStaticDescriptor, hasFilterReferenceMismatch };
}

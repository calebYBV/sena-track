export const DEFAULT_FILTER_CONFIG = Object.freeze({
  model: "first",
  tau: 0.06,
  zeta: 0.9,
  omegaN: 14,
  compareVisual: false
});

export function normalizeFilterConfig(config){
  const candidate = { ...DEFAULT_FILTER_CONFIG, ...(config || {}) };
  return {
    model: ["off", "first", "second"].includes(candidate.model) ? candidate.model : DEFAULT_FILTER_CONFIG.model,
    tau: Number.isFinite(candidate.tau) && candidate.tau >= 0.01 && candidate.tau <= 0.3
      ? candidate.tau : DEFAULT_FILTER_CONFIG.tau,
    zeta: Number.isFinite(candidate.zeta) && candidate.zeta >= 0.2 && candidate.zeta <= 2
      ? candidate.zeta : DEFAULT_FILTER_CONFIG.zeta,
    omegaN: Number.isFinite(candidate.omegaN) && candidate.omegaN >= 2 && candidate.omegaN <= 30
      ? candidate.omegaN : DEFAULT_FILTER_CONFIG.omegaN,
    compareVisual: Boolean(candidate.compareVisual)
  };
}

const cloneLandmarks = points => points.map(({ x, y, z }) => ({ x, y, z }));
const finite = value => Number.isFinite(value);

export function calculateVibrationReduction(raw, filtered){
  if (!finite(raw) || !finite(filtered) || raw <= 1e-9) return null;
  return 100 * (raw - filtered) / raw;
}

export function estimateTrackingLag(samples){
  if (samples.length < 18) return null;
  const raw = [], filtered = [];
  for (let i = 1; i < samples.length; i++){
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    if (dt <= 0) continue;
    raw.push([
      (samples[i].raw.x - samples[i - 1].raw.x) * samples[i].aspect / dt,
      (samples[i].raw.y - samples[i - 1].raw.y) / dt
    ]);
    filtered.push([
      (samples[i].filtered.x - samples[i - 1].filtered.x) * samples[i].aspect / dt,
      (samples[i].filtered.y - samples[i - 1].filtered.y) / dt
    ]);
  }
  const maxLag = Math.min(10, Math.floor(raw.length / 4));
  let best = null;
  for (let lag = 0; lag <= maxLag; lag++){
    const pairs = [];
    for (let i = lag; i < raw.length; i++) pairs.push([raw[i - lag], filtered[i]]);
    const means = [0, 0];
    for (const [a, b] of pairs){
      means[0] += a[0] + b[0];
      means[1] += a[1] + b[1];
    }
    const count = pairs.length * 2;
    means[0] /= count; means[1] /= count;
    let covariance = 0, rawEnergy = 0, filteredEnergy = 0;
    for (const [a, b] of pairs){
      for (let axis = 0; axis < 2; axis++){
        const x = a[axis] - means[axis], y = b[axis] - means[axis];
        covariance += x * y;
        rawEnergy += x * x;
        filteredEnergy += y * y;
      }
    }
    if (!rawEnergy || !filteredEnergy) continue;
    const correlation = covariance / Math.sqrt(rawEnergy * filteredEnergy);
    if (!best || correlation > best.correlation) best = { lag, correlation };
  }
  if (!best || best.correlation < 0.6) return null;
  const intervals = samples.slice(1).map((sample, i) => sample.time - samples[i].time);
  const frameMs = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return best.lag * frameMs;
}

export function createEdoFilter(){
  const tracks = new Map();

  function process(points, identity, timestamp, config){
    if (!Array.isArray(points) || points.some(point =>
      !finite(point.x) || !finite(point.y) || !finite(point.z))){
      throw new TypeError("Los landmarks deben contener coordenadas finitas.");
    }
    if (config.model === "off") return cloneLandmarks(points);
    if (config.model !== "first" && config.model !== "second"){
      throw new RangeError(`Modelo EDO no válido: ${config.model}`);
    }
    if (!finite(timestamp) || !finite(config.tau) || config.tau <= 0 ||
        !finite(config.zeta) || config.zeta <= 0 ||
        !finite(config.omegaN) || config.omegaN <= 0){
      throw new RangeError("El tiempo y los parámetros del filtro EDO deben ser positivos y finitos.");
    }
    const signature = `${config.model}:${config.tau}:${config.zeta}:${config.omegaN}`;
    let track = tracks.get(identity);
    if (track && (track.signature !== signature || timestamp < track.timestamp ||
        timestamp - track.timestamp > 500)){
      tracks.delete(identity);
      track = null;
    }
    if (!track){
      tracks.set(identity, {
        signature,
        timestamp,
        points: points.map(({ x, y, z }) => ({
          x: { y: x, v: 0 },
          y: { y: y, v: 0 },
          z: { y: z, v: 0 }
        }))
      });
      return cloneLandmarks(points);
    }
    if (timestamp === track.timestamp){
      return track.points.map(point => ({ x: point.x.y, y: point.y.y, z: point.z.y }));
    }
    if (points.length !== track.points.length){
      tracks.delete(identity);
      return process(points, identity, timestamp, config);
    }
    const dt = (timestamp - track.timestamp) / 1000;
    const maxStep = config.model === "first"
      ? config.tau
      : Math.min(0.5 / config.omegaN, 0.5 / (2 * config.zeta * config.omegaN));
    const steps = Math.ceil(dt / maxStep);
    const step = dt / steps;
    const filtered = points.map((point, index) => {
      const previous = track.points[index];
      const next = {};
      for (const axis of ["x", "y", "z"]){
        const input = point[axis];
        if (!finite(input)) throw new TypeError("MediaPipe devolvió una coordenada no finita.");
        const value = previous[axis];
        if (config.model === "first"){
          let y = value.y;
          for (let i = 0; i < steps; i++){
            const rate = (input - y) / config.tau;
            y += step * rate;
          }
          next[axis] = { y, v: 0 };
        } else {
          let y = value.y, v = value.v;
          for (let i = 0; i < steps; i++){
            const a = config.omegaN ** 2 * (input - y) -
              2 * config.zeta * config.omegaN * v;
            v += step * a;
            y += step * v;
          }
          next[axis] = { y, v };
        }
      }
      return next;
    });
    track.points = filtered;
    track.timestamp = timestamp;
    return filtered.map(point => ({ x: point.x.y, y: point.y.y, z: point.z.y }));
  }

  function retain(identities){
    const active = new Set(identities);
    for (const identity of tracks.keys()){
      if (!active.has(identity)) tracks.delete(identity);
    }
  }

  function reset(identity){
    if (identity === undefined) tracks.clear();
    else tracks.delete(identity);
  }

  return { process, retain, reset };
}

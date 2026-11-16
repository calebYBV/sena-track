export const DEFAULT_FILTER_CONFIG = Object.freeze({
  model: "first",
  tau: 0.06,
  compareVisual: false
});

export const FILTER_TRACKING_PAUSE_MS = 500;

export function normalizeFilterConfig(config){
  const candidate = config || {};
  return {
    model: candidate.model === "off" ? "off" : "first",
    tau: Number.isFinite(candidate.tau) && candidate.tau >= 0.01 && candidate.tau <= 0.3
      ? candidate.tau : DEFAULT_FILTER_CONFIG.tau,
    compareVisual: Boolean(candidate.compareVisual)
  };
}

export function normalizeActiveFilterConfig(config){
  return { ...normalizeFilterConfig(config), model: "first" };
}

const cloneLandmarks = points => points.map(({ x, y, z }) => ({ x, y, z }));
const finite = value => Number.isFinite(value);
const HEAD_ANGLE_FEATURES = new Set([29, 31]);
const wrapHeadAngle = value => ((value + 1) % 2 + 2) % 2 - 1;
const nearestHeadAngle = (value, reference) =>
  reference + ((value - reference + 1) % 2 + 2) % 2 - 1;
const validFilterConfig = config =>
  config && ["off", "first"].includes(config.model) &&
  finite(config.tau) && config.tau >= 0.01 && config.tau <= 0.3;

export function calculateVibrationReduction(raw, filtered){
  if (!finite(raw) || !finite(filtered) || raw <= 1e-6) return null;
  return 100 * (raw - filtered) / raw;
}

export function estimateTrackingLagDetails(samples){
  const unavailable = reason => ({ lagMs: null, correlation: null, reason });
  if (!Array.isArray(samples) || samples.length < 24){
    return unavailable("Se requieren al menos 24 muestras emparejadas por región.");
  }
  for (let i = 0; i < samples.length; i++){
    const sample = samples[i];
    if (!finite(sample?.time) || !finite(sample?.aspect) || sample.aspect <= 0 ||
        !finite(sample?.raw?.x) || !finite(sample?.raw?.y) ||
        !finite(sample?.filtered?.x) || !finite(sample?.filtered?.y) ||
        (i > 0 && sample.time <= samples[i - 1].time)){
      return unavailable("La trayectoria contiene coordenadas o marcas de tiempo no válidas.");
    }
  }
  const intervals = samples.slice(1).map((sample, index) =>
    sample.time - samples[index].time);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const middle = Math.floor(sortedIntervals.length / 2);
  const periodMs = sortedIntervals.length % 2
    ? sortedIntervals[middle]
    : (sortedIntervals[middle - 1] + sortedIntervals[middle]) / 2;
  if (periodMs > 200){
    return unavailable("La frecuencia de cuadros es demasiado baja para resolver un desfase temporal.");
  }
  if (!(periodMs > 0) || intervals.some(interval =>
    interval > Math.max(250, periodMs * 3))){
    return unavailable("Hay pausas de seguimiento que impiden interpolar una trayectoria continua.");
  }
  if (samples.at(-1).time - samples[0].time < 500){
    return unavailable("La trayectoria todavía no cubre suficiente tiempo para estimar el retardo.");
  }

  const positions = samples.map(sample => ({
    time: sample.time,
    raw: [sample.raw.x * sample.aspect, sample.raw.y],
    filtered: [sample.filtered.x * sample.aspect, sample.filtered.y]
  }));
  const uniform = [];
  let cursor = 0;
  const period = periodMs;
  for (let time = positions[0].time; time <= positions.at(-1).time; time += period){
    while (cursor < positions.length - 2 && positions[cursor + 1].time < time) cursor++;
    const start = positions[cursor], end = positions[cursor + 1];
    const fraction = (time - start.time) / (end.time - start.time);
    uniform.push({
      raw: start.raw.map((value, axis) => value + (end.raw[axis] - value) * fraction),
      filtered: start.filtered.map((value, axis) =>
        value + (end.filtered[axis] - value) * fraction)
    });
  }
  const rawVelocity = [], filteredVelocity = [];
  for (let i = 1; i < uniform.length; i++){
    rawVelocity.push(uniform[i].raw.map((value, axis) =>
      (value - uniform[i - 1].raw[axis]) * 1000 / period));
    filteredVelocity.push(uniform[i].filtered.map((value, axis) =>
      (value - uniform[i - 1].filtered[axis]) * 1000 / period));
  }
  const maxLag = Math.min(
    Math.floor(400 / period),
    Math.floor(rawVelocity.length / 4)
  );
  const minimumPairs = Math.max(16, Math.ceil(rawVelocity.length * 0.6));
  let best = null;
  for (let lag = 0; lag <= maxLag; lag++){
    const count = rawVelocity.length - lag;
    if (count < minimumPairs) continue;
    const rawMeans = [0, 0], filteredMeans = [0, 0];
    for (let i = lag; i < rawVelocity.length; i++){
      for (let axis = 0; axis < 2; axis++){
        rawMeans[axis] += rawVelocity[i - lag][axis];
        filteredMeans[axis] += filteredVelocity[i][axis];
      }
    }
    for (let axis = 0; axis < 2; axis++){
      rawMeans[axis] /= count;
      filteredMeans[axis] /= count;
    }
    let covariance = 0, rawEnergy = 0, filteredEnergy = 0;
    for (let i = lag; i < rawVelocity.length; i++){
      for (let axis = 0; axis < 2; axis++){
        const x = rawVelocity[i - lag][axis] - rawMeans[axis];
        const y = filteredVelocity[i][axis] - filteredMeans[axis];
        covariance += x * y;
        rawEnergy += x * x;
        filteredEnergy += y * y;
      }
    }
    if (rawEnergy / (count * 2) < 1e-8 ||
        filteredEnergy / (count * 2) < 1e-8) continue;
    const correlation = covariance / Math.sqrt(rawEnergy * filteredEnergy);
    if (!best || correlation > best.correlation) best = { lag, correlation };
  }
  if (!best){
    return unavailable("El movimiento es constante o demasiado pequeño; faltan cambios de velocidad/dirección.");
  }
  if (best.lag === maxLag && maxLag > 0){
    return unavailable("El desfase parece superar el intervalo de búsqueda de 400 ms.");
  }
  if (best.correlation < 0.65){
    return unavailable("Las trayectorias raw y EDO no tienen correlación suficiente (se requiere ≥0,65).");
  }
  return {
    lagMs: best.lag * period,
    correlation: best.correlation,
    reason: null
  };
}

export function estimateTrackingLag(samples){
  return estimateTrackingLagDetails(samples).lagMs;
}

export function createEdoFilter(){
  const tracks = new Map();

  function process(points, identity, timestamp, config){
    if (!Array.isArray(points) || points.some(point =>
      !finite(point.x) || !finite(point.y) || !finite(point.z))){
      throw new TypeError("Los landmarks deben contener coordenadas finitas.");
    }
    if (!finite(timestamp)) throw new RangeError("El tiempo del filtro debe ser finito.");
    if (!validFilterConfig(config)){
      throw new RangeError("Los parámetros EDO están fuera de los límites permitidos.");
    }
    if (config.model === "off") return cloneLandmarks(points);
    const signature = `${config.model}:${config.tau}`;
    let track = tracks.get(identity);
    if (track && (track.signature !== signature || timestamp < track.timestamp ||
        timestamp - track.timestamp > FILTER_TRACKING_PAUSE_MS)){
      tracks.delete(identity);
      track = null;
    }
    if (!track){
      tracks.set(identity, {
        signature,
        timestamp,
        points: cloneLandmarks(points)
      });
      return cloneLandmarks(points);
    }
    if (timestamp === track.timestamp){
      return cloneLandmarks(track.points).map((point, index) => ({
        ...point,
        x: identity === "face:features" && HEAD_ANGLE_FEATURES.has(index)
          ? wrapHeadAngle(point.x) : point.x
      }));
    }
    if (points.length !== track.points.length){
      tracks.delete(identity);
      return process(points, identity, timestamp, config);
    }
    const dt = (timestamp - track.timestamp) / 1000;
    const hMax = config.tau / 4;
    const steps = Math.max(1, Math.ceil(dt / hMax));
    const step = dt / steps;
    const filtered = points.map((point, index) => {
      const previous = track.points[index];
      const next = { ...point };
      for (const axis of ["x", "y", "z"]){
        const input = identity === "face:features" && axis === "x" &&
          HEAD_ANGLE_FEATURES.has(index)
          ? nearestHeadAngle(point.x, previous.x) : point[axis];
        if (!finite(input)) throw new TypeError("MediaPipe devolvió una coordenada no finita.");
        let value = previous[axis];
        for (let i = 0; i < steps; i++){
          value += step * (input - value) / config.tau;
        }
        next[axis] = value;
      }
      return next;
    });
    track.points = filtered;
    track.timestamp = timestamp;
    return filtered.map((point, index) => {
      return {
        ...point,
        x: identity === "face:features" && HEAD_ANGLE_FEATURES.has(index)
          ? wrapHeadAngle(point.x) : point.x
      };
    });
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

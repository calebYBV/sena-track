const REGIONS = [
  ["hand:Left", frame => frame?.hands?.Left, (points, aspect) =>
    distance({ x: points[0]?.x * aspect, y: points[0]?.y },
      { x: points[9]?.x * aspect, y: points[9]?.y })],
  ["hand:Right", frame => frame?.hands?.Right, (points, aspect) =>
    distance({ x: points[0]?.x * aspect, y: points[0]?.y },
      { x: points[9]?.x * aspect, y: points[9]?.y })],
  ["face", frame => frame?.faceLandmarks, (points, aspect) =>
    points.length > 454
      ? distance({ x: points[234].x * aspect, y: points[234].y },
        { x: points[454].x * aspect, y: points[454].y })
      : 0]
];
const MAX_PAIR_GAP_MS = 250;
const MAX_IDENTITY_STEP = 0.5;
const DISPLACEMENT_WINDOW_MS = 1000;
const QUIET_WINDOW_MS = 1800;
const QUIET_ENTRY_SPEED = 3;
const QUIET_EXIT_SPEED = 6;
const QUIET_DETECTION_WINDOW_MS = 750;
const MIN_QUIET_DETECTION_SPAN_MS = 500;
const MIN_QUIET_SAMPLES = 12;
const MIN_QUIET_SPAN_MS = 1400;
const METRIC_UPDATE_INTERVAL_MS = 200;
const MIN_PERCENT_BASELINE = 0.01;
const NO_TRACKING = "Muestra tus manos o rostro frente a la cámara.";
const ANALYSIS_NOTE = "Desplazamiento: RMS de velocidad 2D, normalizado por escala de referencia raw " +
  "(palma mano 0–9; ancho facial 234–454), media con igual peso por región; unidad " +
  "% de escala/s. Vibración: RMS temporal de centroide y geometría interna, " +
  "combinadas cuadráticamente y normalizadas por la misma escala raw; igual peso por " +
  "región, expresada como % de escala en una ventana de 1.8 s. " +
  "Quietud proxy: compara medianas de coordenadas por landmark en dos mitades de una " +
  "ventana temporal de 750 ms; cada región entra con ≤3 %/s y sale al superar " +
  "al superar 6 %/s. " +
  "Después requiere 1.8 s, al menos 12 observaciones y una ventana de ≥1.4 s. " +
  "Las diferencias relativas usan (raw−EDO)/raw×100 y no se calculan si raw ≤0.01 " +
  "en la unidad de su métrica o la diferencia absoluta es ≤0.01 puntos de esa unidad. " +
  "Este proxy no identifica temblor fisiológico ni distingue microgestos; ninguna " +
  "métrica mide exactitud.";

function distance(a, b){
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function finitePoints(points){
  return Array.isArray(points) && points.length > 0 &&
    points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
}

function regionTracks(frame, aspect){
  const tracks = new Map();
  for (const [identity, read, measureScale] of REGIONS){
    const points = read(frame);
    if (!finitePoints(points)) continue;
    const scale = measureScale(points, aspect);
    if (!Number.isFinite(scale) || scale <= 0) continue;
    const coordinates = points.map(point => ({
      x: point.x * aspect,
      y: point.y
    }));
    const centroid = coordinates.reduce((mean, point) => ({
      x: mean.x + point.x / coordinates.length,
      y: mean.y + point.y / coordinates.length
    }), { x: 0, y: 0 });
    tracks.set(identity, {
      count: points.length,
      scale,
      centroid,
      points: coordinates
    });
  }
  return tracks;
}

function median(values){
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quietRegionMotion(history, identity, timestamp){
  const start = timestamp - QUIET_DETECTION_WINDOW_MS;
  const midpoint = start + QUIET_DETECTION_WINDOW_MS / 2;
  const earlier = history.filter(sample =>
    sample.time >= start && sample.time < midpoint && sample.regions.has(identity));
  const later = history.filter(sample =>
    sample.time >= midpoint && sample.time <= timestamp && sample.regions.has(identity));
  const span = history.length > 1
    ? history.at(-1).time - history[0].time : 0;
  if (span < MIN_QUIET_DETECTION_SPAN_MS || earlier.length < 2 || later.length < 2){
    return { score: null, span, identity };
  }

  const earlierTracks = earlier.map(sample => sample.regions.get(identity));
  const laterTracks = later.map(sample => sample.regions.get(identity));
  if (earlierTracks.some(track => !track) || laterTracks.some(track => !track)){
    return { score: null, span, identity };
  }
  const pointCount = laterTracks[0].points.length;
  if (earlierTracks.some(track => track.points.length !== pointCount) ||
      laterTracks.some(track => track.points.length !== pointCount)){
    return { score: null, span, identity };
  }

  const earlierTime = median(earlier.map(sample => sample.time));
  const laterTime = median(later.map(sample => sample.time));
  const elapsed = (laterTime - earlierTime) / 1000;
  const scale = median([...earlierTracks, ...laterTracks].map(track => track.scale));
  if (!(elapsed > 0) || !(scale > 0)) return { score: null, span, identity };

  let squaredDistance = 0;
  for (let index = 0; index < pointCount; index++){
    const earlierX = median(earlierTracks.map(track => track.points[index].x));
    const earlierY = median(earlierTracks.map(track => track.points[index].y));
    const laterX = median(laterTracks.map(track => track.points[index].x));
    const laterY = median(laterTracks.map(track => track.points[index].y));
    squaredDistance += (laterX - earlierX) ** 2 + (laterY - earlierY) ** 2;
  }
  return {
    score: 100 * Math.sqrt(squaredDistance / pointCount) / scale / elapsed,
    span,
    identity
  };
}

function meanSquare(values, weight = () => 1){
  let weightedSquares = 0;
  let totalWeight = 0;
  for (const value of values){
    const currentWeight = weight(value);
    if (!(currentWeight > 0)) continue;
    weightedSquares += value.value ** 2 * currentWeight;
    totalWeight += currentWeight;
  }
  return totalWeight ? Math.sqrt(weightedSquares / totalWeight) : null;
}

function vibrationRms(samples, regionIds, branch){
  const regionVariances = [];
  for (const identity of regionIds){
    const observations = samples.flatMap(sample => {
      const track = sample.regions?.[identity];
      if (!track || !track[branch] || !track[`${branch}Centroid`]) return [];
      return [{
        values: track[branch],
        centroid: track[`${branch}Centroid`],
        scale: track.scale,
        weight: sample.weight
      }];
    }).filter(item => item.weight > 0);
    if (observations.length < MIN_QUIET_SAMPLES) continue;
    const pointCount = observations[0].values.length;
    if (observations.some(item => item.values.length !== pointCount)) return null;
    const scales = observations.map(item => item.scale)
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!scales.length) continue;
    const middle = Math.floor(scales.length / 2);
    const scale = scales.length % 2
      ? scales[middle] : (scales[middle - 1] + scales[middle]) / 2;
    let totalWeight = 0;
    const means = Array.from({ length: pointCount }, () => [0, 0]);
    for (const observation of observations){
      totalWeight += observation.weight;
      observation.values.forEach((point, index) => {
        means[index][0] += point.x * observation.weight;
        means[index][1] += point.y * observation.weight;
      });
    }
    if (!totalWeight) continue;
    for (const mean of means){
      mean[0] /= totalWeight;
      mean[1] /= totalWeight;
    }
    const centroidMean = observations.reduce((mean, observation) => ({
      x: mean.x + observation.centroid.x * observation.weight / totalWeight,
      y: mean.y + observation.centroid.y * observation.weight / totalWeight
    }), { x: 0, y: 0 });
    let shapeVariance = 0;
    let centroidVariance = 0;
    for (const observation of observations){
      observation.values.forEach((point, index) => {
        shapeVariance += observation.weight * (
          (point.x - means[index][0]) ** 2 + (point.y - means[index][1]) ** 2
        );
      });
      centroidVariance += observation.weight * (
        (observation.centroid.x - centroidMean.x) ** 2 +
        (observation.centroid.y - centroidMean.y) ** 2
      );
    }
    const normalizedVariance = (centroidVariance + shapeVariance / pointCount) /
      (totalWeight * scale ** 2);
    regionVariances.push(normalizedVariance < 1e-20 ? 0 : normalizedVariance);
  }
  return regionVariances.length
    ? 100 * Math.sqrt(regionVariances.reduce((sum, value) => sum + value, 0) /
      regionVariances.length)
    : null;
}

function createRegionState(identity, track, timestamp, diagnosticReason = "acquiring-observations"){
  return {
    history: [{ time: timestamp, regions: new Map([[identity, track]]) }],
    quiet: false,
    quietSince: null,
    samples: [],
    motionScore: null,
    stableCount: 0,
    stableSince: null,
    diagnosticReason
  };
}

function configSignature(config){
  return ["model", "tau", "zeta", "omegaN"]
    .map(key => `${key}:${config?.[key]}`).join("|");
}

export function createTrackingDiagnostics(){
  let previous = null;
  let configKey = null;
  let displacementSamples = [];
  let regionStates = new Map();
  let lastMetricsAt = -Infinity;
  let lastMetrics = null;

  function clearSequences(){
    displacementSamples = [];
    regionStates = new Map();
    lastMetricsAt = -Infinity;
    lastMetrics = null;
  }

  function reset(reason = "Diagnóstico reiniciado; esperando seguimiento válido."){
    previous = null;
    configKey = null;
    clearSequences();
    lastMetrics = emptyMetrics(reason);
    return { ...lastMetrics, shouldUpdate: true };
  }

  function emptyMetrics(status){
    const interrupted = /interrump|pérdida temporal/i.test(status);
    return {
      displacementRaw: null,
      displacementFiltered: null,
      displacementSamples: 0,
      regionCount: 0,
      vibrationRaw: null,
      vibrationFiltered: null,
      vibrationReduction: null,
      vibrationAssessment: null,
      vibrationProgress: 0,
      vibrationRegionCount: 0,
      vibrationState: status === NO_TRACKING
        ? "sin-seguimiento"
        : interrupted ? "seguimiento-interrumpido" : "adquiriendo-muestras",
      diagnosticReason: status,
      quietReason: interrupted
        ? "Seguimiento interrumpido; adquiriendo de nuevo."
        : status === NO_TRACKING
          ? NO_TRACKING : "Mantén una región quieta para medir.",
      displacementChange: null,
      displacementAssessment: null,
      status,
      note: ANALYSIS_NOTE
    };
  }

  function calculate(timestamp, activeRegions, trackedRegions = activeRegions){
    const displacementWindow = displacementSamples.filter(sample =>
      timestamp - sample.time <= DISPLACEMENT_WINDOW_MS);
    const displacementRaw = displacementWindow.length >= 3
      ? meanSquare(displacementWindow.map(sample => ({
        value: sample.raw,
        weight: sample.weight
      })), sample => sample.weight)
      : null;
    const displacementFiltered = displacementWindow.length >= 3
      ? meanSquare(displacementWindow.map(sample => ({
        value: sample.filtered,
        weight: sample.weight
      })), sample => sample.weight)
      : null;
    const displacementDifference = displacementRaw === null || displacementFiltered === null
      ? null : displacementRaw - displacementFiltered;
    let displacementAssessment = null;
    if (displacementDifference !== null){
      if (displacementRaw <= MIN_PERCENT_BASELINE){
        displacementAssessment = "Porcentaje no calculable: valor base demasiado pequeño";
      } else if (Math.abs(displacementDifference) <= MIN_PERCENT_BASELINE){
        displacementAssessment = "Sin diferencia medible";
      } else {
        displacementAssessment = displacementDifference > 0
          ? "Menor desplazamiento observado con EDO"
          : "Mayor desplazamiento observado con EDO";
      }
    }
    const displacementChange = displacementRaw === null ||
      displacementRaw <= MIN_PERCENT_BASELINE || displacementDifference === null ||
      Math.abs(displacementDifference) <= MIN_PERCENT_BASELINE
      ? null : 100 * displacementDifference / displacementRaw;

    const windowStart = timestamp - QUIET_WINDOW_MS;
    const regionWindows = [...regionStates.entries()]
      .filter(([, state]) => state.quiet)
      .map(([identity, state]) => {
        const samples = state.samples.filter(sample =>
          sample.time >= windowStart && sample.time <= timestamp);
        const span = samples.length > 1
          ? samples.at(-1).time - samples[0].time : 0;
        const maxGap = samples.slice(1).reduce((largest, sample, index) =>
          Math.max(largest, sample.time - samples[index].time), 0);
        return {
          identity,
          samples,
          span,
          maxGap,
          duration: timestamp - state.quietSince
        };
      });
    const measurableRegions = regionWindows.filter(region =>
      region.duration >= QUIET_WINDOW_MS &&
      region.samples.length >= MIN_QUIET_SAMPLES &&
      region.span >= MIN_QUIET_SPAN_MS &&
      region.maxGap <= MAX_PAIR_GAP_MS);
    const validQuietRegions = measurableRegions.map(region => region.identity);
    const combinedSamples = [];
    for (const region of measurableRegions){
      for (const sample of region.samples){
        let combined = combinedSamples.find(item => item.time === sample.time);
        if (!combined){
          combined = { time: sample.time, weight: sample.weight, regions: {} };
          combinedSamples.push(combined);
        }
        combined.regions[region.identity] = sample.regions[region.identity];
      }
    }
    const vibrationRaw = validQuietRegions.length
      ? vibrationRms(combinedSamples, validQuietRegions, "raw") : null;
    const vibrationFiltered = validQuietRegions.length
      ? vibrationRms(combinedSamples, validQuietRegions, "filtered") : null;
    const vibrationDifference = vibrationRaw === null || vibrationFiltered === null
      ? null : vibrationFiltered - vibrationRaw;
    const vibrationAssessment = vibrationDifference === null ? null
      : Math.abs(vibrationDifference) <= 0.01 ? "Sin diferencia medible"
        : vibrationDifference < 0 ? "EDO reduce la vibración"
          : "EDO aumenta la vibración";
    const vibrationReduction = vibrationRaw === null || vibrationFiltered === null ||
      vibrationRaw <= 0.01 || Math.abs(vibrationDifference) <= 0.01 ? null
      : 100 * (vibrationRaw - vibrationFiltered) / vibrationRaw;

    const longestQuietDuration = [...regionStates.values()].reduce((longest, state) =>
      state.quiet ? Math.max(longest, timestamp - state.quietSince) : longest, 0);
    const vibrationProgress = validQuietRegions.length
      ? 100
      : Math.min(99, Math.round(100 * longestQuietDuration / QUIET_WINDOW_MS));
    const hasQuietDetectionWindow = [...regionStates.values()].some(state =>
      state.history.length > 1 &&
      state.history.at(-1).time - state.history[0].time >= MIN_QUIET_DETECTION_SPAN_MS);
    const vibrationState = validQuietRegions.length
      ? "medicion-disponible"
      : longestQuietDuration > 0
        ? "midiendo-vibracion"
        : !trackedRegions.length
          ? "sin-seguimiento"
          : hasQuietDetectionWindow ? "analizando-quietud" : "adquiriendo-muestras";
    const movingRegion = [...regionStates.values()].some(state =>
      state.motionScore !== null && state.motionScore > QUIET_ENTRY_SPEED);
    const quietReason = validQuietRegions.length
      ? `Medición disponible · ${validQuietRegions.length} ${validQuietRegions.length === 1 ? "región estable" : "regiones estables"}.`
      : longestQuietDuration > 0
        ? `Analizando estabilidad… ${vibrationProgress}%.`
        : trackedRegions.length
          ? movingRegion
            ? "Movimiento detectado; mantén una región quieta."
            : hasQuietDetectionWindow
              ? "Analizando estabilidad…"
              : "Adquiriendo muestras…"
          : NO_TRACKING;

    return {
      displacementRaw,
      displacementFiltered,
      displacementSamples: displacementWindow.length,
      regionCount: activeRegions.length,
      vibrationRaw,
      vibrationFiltered,
      vibrationReduction,
      vibrationAssessment,
      vibrationProgress,
      vibrationRegionCount: validQuietRegions.length,
      vibrationState,
      diagnosticReason: vibrationRaw === null
        ? longestQuietDuration > 0
          ? "quiet-window-not-ready"
          : !trackedRegions.length ? "no-tracking"
            : movingRegion
              ? "movement-above-entry-threshold"
              : [...regionStates.values()].some(state =>
                state.diagnosticReason === "identity-discontinuity")
                ? "identity-discontinuity"
                : hasQuietDetectionWindow ? "no-stable-region" : "acquiring-observations"
        : null,
      quietReason,
      displacementChange,
      displacementAssessment,
      status: activeRegions.length
        ? `Analizando ${activeRegions.length} ${activeRegions.length === 1 ? "región" : "regiones"} ` +
          "con coordenadas emparejadas por cuadro."
        : trackedRegions.length
          ? "Seguimiento detectado; sincronizando cuadros."
        : NO_TRACKING,
      note: ANALYSIS_NOTE
    };
  }

  function update(rawFrame, filteredFrame, timestamp, aspect = 1, filterConfig){
    if (!Number.isFinite(timestamp) || !Number.isFinite(aspect) || aspect <= 0){
      throw new RangeError("El tiempo y la relación de aspecto del diagnóstico deben ser válidos.");
    }
    const key = configSignature(filterConfig);
    const rawTracks = regionTracks(rawFrame, aspect);
    const filteredTracks = regionTracks(filteredFrame, aspect);
    if (configKey !== null && key !== configKey){
      clearSequences();
      previous = null;
    }
    configKey = key;
    const raw = new Map([...rawTracks].filter(([identity, track]) =>
      filteredTracks.get(identity)?.count === track.count));
    const filtered = new Map([...filteredTracks].filter(([identity, track]) =>
      raw.get(identity)?.count === track.count));
    if (raw.size === 0){
      const reason = rawTracks.size === 0 ? NO_TRACKING
        : "No hay regiones raw/EDO emparejadas con landmarks compatibles.";
      const alreadyReported = previous === null && lastMetrics?.diagnosticReason === reason;
      previous = null;
      clearSequences();
      lastMetrics = emptyMetrics(reason);
      lastMetrics.diagnosticReason = reason;
      return { ...lastMetrics, shouldUpdate: !alreadyReported };
    }

    const current = { time: timestamp, raw, filtered };
    if (!previous){
      previous = current;
      const status = "Seguimiento detectado; sincronizando el primer par de cuadros.";
      lastMetrics = emptyMetrics(status);
      for (const [identity, track] of raw){
        regionStates.set(identity, createRegionState(identity, track, timestamp));
      }
      return { ...lastMetrics, regionCount: raw.size, shouldUpdate: true };
    }
    const dtMs = timestamp - previous.time;
    if (dtMs <= 0 || dtMs > MAX_PAIR_GAP_MS){
      clearSequences();
      previous = current;
      const reason = dtMs <= 0
        ? "Marca de tiempo no creciente; se reinició la continuidad del seguimiento."
        : "Pérdida temporal de seguimiento; sincronizando un nuevo par de cuadros.";
      lastMetrics = emptyMetrics(reason);
      lastMetrics.vibrationState = "seguimiento-interrumpido";
      lastMetrics.diagnosticReason = reason;
      for (const [identity, track] of raw){
        regionStates.set(identity, createRegionState(identity, track, timestamp));
      }
      return { ...lastMetrics, regionCount: raw.size, shouldUpdate: true };
    }

    const dt = dtMs / 1000;
    const pairs = {};
    const pairedRegions = [];
    let rawSpeedSum = 0, filteredSpeedSum = 0;
    for (const identity of regionStates.keys()){
      if (!raw.has(identity)) regionStates.delete(identity);
    }
    for (const identity of raw.keys()){
      const previousRaw = previous.raw.get(identity);
      const currentRaw = raw.get(identity);
      const previousFiltered = previous.filtered.get(identity);
      const currentFiltered = filtered.get(identity);
      const state = regionStates.get(identity);
      if (!state || !previousRaw || previousRaw.count !== currentRaw.count ||
          previousFiltered?.count !== currentFiltered.count){
        regionStates.set(identity, createRegionState(identity, currentRaw, timestamp));
        continue;
      }
      const referenceScale = (previousRaw.scale + currentRaw.scale) / 2;
      const centerStep = Math.hypot(
        currentRaw.centroid.x - previousRaw.centroid.x,
        currentRaw.centroid.y - previousRaw.centroid.y
      ) / referenceScale;
      if (centerStep > MAX_IDENTITY_STEP){
        regionStates.set(identity, createRegionState(identity, currentRaw, timestamp,
          "identity-discontinuity"));
        continue;
      }
      let rawStepSquares = 0, filteredStepSquares = 0;
      const rawShape = [], filteredShape = [];
      currentRaw.points.forEach((point, index) => {
        const oldRawPoint = previousRaw.points[index];
        const oldFilteredPoint = previousFiltered.points[index];
        const filteredPoint = currentFiltered.points[index];
        const rawDx = (point.x - oldRawPoint.x) / referenceScale;
        const rawDy = (point.y - oldRawPoint.y) / referenceScale;
        const filteredDx = (filteredPoint.x - oldFilteredPoint.x) / referenceScale;
        const filteredDy = (filteredPoint.y - oldFilteredPoint.y) / referenceScale;
        rawStepSquares += rawDx ** 2 + rawDy ** 2;
        filteredStepSquares += filteredDx ** 2 + filteredDy ** 2;
        rawShape.push({ x: point.x - currentRaw.centroid.x,
          y: point.y - currentRaw.centroid.y });
        filteredShape.push({ x: filteredPoint.x - currentFiltered.centroid.x,
          y: filteredPoint.y - currentFiltered.centroid.y });
      });
      const divisor = currentRaw.points.length;
      const rawSpeed = 100 * Math.sqrt(rawStepSquares / divisor) / dt;
      const filteredSpeed = 100 * Math.sqrt(filteredStepSquares / divisor) / dt;
      rawSpeedSum += rawSpeed;
      filteredSpeedSum += filteredSpeed;
      pairedRegions.push(identity);
      pairs[identity] = {
        raw: rawShape,
        filtered: filteredShape,
        rawCentroid: currentRaw.centroid,
        filteredCentroid: currentFiltered.centroid,
        scale: currentRaw.scale
      };
      state.history.push({ time: timestamp, regions: new Map([[identity, currentRaw]]) });
      state.history = state.history.filter(sample =>
        timestamp - sample.time <= QUIET_DETECTION_WINDOW_MS);
      const { score, span } = quietRegionMotion(state.history, identity, timestamp);
      state.motionScore = score;
      if (!state.quiet){
        if (score !== null && score <= QUIET_ENTRY_SPEED){
          state.stableCount++;
          state.stableSince ??= timestamp;
        } else {
          state.stableCount = 0;
          state.stableSince = null;
        }
        if (span >= MIN_QUIET_DETECTION_SPAN_MS && state.stableCount >= 2 &&
            timestamp - state.stableSince >= METRIC_UPDATE_INTERVAL_MS){
          state.quiet = true;
          state.quietSince = timestamp;
          state.samples = [];
        }
      } else if (score !== null && score >= QUIET_EXIT_SPEED){
        state.quiet = false;
        state.quietSince = null;
        state.samples = [];
        state.stableCount = 0;
        state.stableSince = null;
      }
      if (state.quiet){
        state.samples.push({
          time: timestamp,
          weight: dt,
          regions: { [identity]: pairs[identity] }
        });
        state.samples = state.samples.filter(sample =>
          timestamp - sample.time <= QUIET_WINDOW_MS);
      }
    }
    if (pairedRegions.length){
      displacementSamples.push({
        time: timestamp,
        weight: dt,
        raw: rawSpeedSum / pairedRegions.length,
        filtered: filteredSpeedSum / pairedRegions.length
      });
      displacementSamples = displacementSamples.filter(sample =>
        timestamp - sample.time <= DISPLACEMENT_WINDOW_MS);
    }
    previous = current;

    if (timestamp - lastMetricsAt < METRIC_UPDATE_INTERVAL_MS && lastMetrics){
      return { ...lastMetrics, shouldUpdate: false };
    }
    lastMetricsAt = timestamp;
    lastMetrics = calculate(timestamp, pairedRegions, [...raw.keys()]);
    return { ...lastMetrics, shouldUpdate: true };
  }

  return { update, reset };
}

export function createTrackingDiagnosticsSession({ onReset, onUpdate } = {}){
  let active = false;
  let generation = 0;

  function reset(reason){
    generation++;
    onReset?.(reason, active);
    return generation;
  }

  function setActive(enabled){
    const next = Boolean(enabled);
    if (next === active) return false;
    active = next;
    reset(next
      ? "Nueva sesión de reconocimiento; sincronizando cuadros."
      : "Inicia el reconocimiento para visualizar el análisis EDO.");
    return true;
  }

  function update(rawFrame, filteredFrame, timestamp, frameGeneration = generation){
    if (!active || frameGeneration !== generation) return false;
    onUpdate?.(rawFrame, filteredFrame, timestamp);
    return true;
  }

  return {
    isActive: () => active,
    generation: () => generation,
    setActive,
    reset,
    update
  };
}

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
const QUIET_WINDOW_MS = 1500;
const QUIET_ENTRY_SPEED = 3;
const QUIET_EXIT_SPEED = 6;
const QUIET_DETECTION_WINDOW_MS = 500;
const MIN_QUIET_DETECTION_SPAN_MS = 350;
const MIN_QUIET_SAMPLES = 12;
const MIN_QUIET_SPAN_MS = 1400;
const METRIC_UPDATE_INTERVAL_MS = 200;
const MIN_PERCENT_BASELINE = 0.01;
const NO_TRACKING = "Muestra tus manos o rostro frente a la cámara.";
const ANALYSIS_NOTE = "Desplazamiento: RMS de velocidad 2D, normalizado por escala de referencia raw " +
  "(palma mano 0–9; ancho facial 234–454), media con igual peso por región; unidad " +
  "% de escala/s. Vibración: RMS temporal de centroide y geometría interna, " +
  "combinadas cuadráticamente y normalizadas por la misma escala raw; igual peso por " +
  "región, expresada como % de escala en una ventana de 1.5 s. " +
  "Quietud proxy: compara medianas de coordenadas por landmark en dos mitades de una " +
  "ventana temporal de 500 ms; el máximo regional debe ser ≤3 %/s para entrar y sale " +
  "al superar 6 %/s. " +
  "Después requiere 1.5 s, al menos 12 observaciones y una ventana de ≥1.4 s. " +
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

function sameRegions(previous, current){
  return previous.size === current.size &&
    [...previous.keys()].every(identity => current.has(identity));
}

function median(values){
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quietMotion(history, timestamp){
  const start = timestamp - QUIET_DETECTION_WINDOW_MS;
  const midpoint = start + QUIET_DETECTION_WINDOW_MS / 2;
  const earlier = history.filter(sample => sample.time >= start && sample.time < midpoint);
  const later = history.filter(sample => sample.time >= midpoint && sample.time <= timestamp);
  const span = history.length > 1
    ? history.at(-1).time - history[0].time : 0;
  if (span < MIN_QUIET_DETECTION_SPAN_MS || earlier.length < 3 || later.length < 3){
    return { score: null, span };
  }

  const identities = [...later.at(-1).regions.keys()];
  const regionalSpeeds = [];
  for (const identity of identities){
    const earlierTracks = earlier.map(sample => sample.regions.get(identity));
    const laterTracks = later.map(sample => sample.regions.get(identity));
    if (earlierTracks.some(track => !track) || laterTracks.some(track => !track)) continue;
    const pointCount = laterTracks[0].points.length;
    if (earlierTracks.some(track => track.points.length !== pointCount) ||
        laterTracks.some(track => track.points.length !== pointCount)) continue;

    const earlierTime = median(earlier.map(sample => sample.time));
    const laterTime = median(later.map(sample => sample.time));
    const elapsed = (laterTime - earlierTime) / 1000;
    const scale = median([...earlierTracks, ...laterTracks].map(track => track.scale));
    if (!(elapsed > 0) || !(scale > 0)) continue;

    let squaredDistance = 0;
    for (let index = 0; index < pointCount; index++){
      const earlierX = median(earlierTracks.map(track => track.points[index].x));
      const earlierY = median(earlierTracks.map(track => track.points[index].y));
      const laterX = median(laterTracks.map(track => track.points[index].x));
      const laterY = median(laterTracks.map(track => track.points[index].y));
      squaredDistance += (laterX - earlierX) ** 2 + (laterY - earlierY) ** 2;
    }
    regionalSpeeds.push(100 * Math.sqrt(squaredDistance / pointCount) / scale / elapsed);
  }
  return {
    score: regionalSpeeds.length ? Math.max(...regionalSpeeds) : null,
    span
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
    const observations = samples.map(sample => ({
      values: sample.regions[identity]?.[branch],
      centroid: sample.regions[identity]?.[`${branch}Centroid`],
      weight: sample.weight
    })).filter(item => item.values && item.centroid && item.weight > 0);
    if (observations.length < MIN_QUIET_SAMPLES) return null;
    const pointCount = observations[0].values.length;
    if (observations.some(item => item.values.length !== pointCount)) return null;
    const scales = samples.map(sample => sample.regions[identity]?.scale)
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!scales.length) return null;
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
    if (!totalWeight) return null;
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

function configSignature(config){
  return ["model", "tau", "zeta", "omegaN"]
    .map(key => `${key}:${config?.[key]}`).join("|");
}

export function createTrackingDiagnostics(){
  let previous = null;
  let configKey = null;
  let displacementSamples = [];
  let motionHistory = [];
  let quietSamples = [];
  let quiet = false;
  let quietSince = null;
  let lastMetricsAt = -Infinity;
  let lastMetrics = null;

  function clearSequences(){
    displacementSamples = [];
    motionHistory = [];
    quietSamples = [];
    quiet = false;
    quietSince = null;
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
      quietReason: "Mantén las manos o el rostro quietos para medir la vibración.",
      displacementChange: null,
      displacementAssessment: null,
      status,
      note: ANALYSIS_NOTE
    };
  }

  function calculate(timestamp, activeRegions, motionScore, currentPairs){
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

    const quietDuration = quiet && quietSince !== null ? timestamp - quietSince : 0;
    const quietWindow = quietSamples.filter(sample =>
      timestamp - sample.time <= QUIET_WINDOW_MS);
    const quietSpan = quietWindow.length
      ? quietWindow.at(-1).time - quietWindow[0].time : 0;
    const hasQuietMeasurement = quiet && quietDuration >= QUIET_WINDOW_MS &&
      quietWindow.length >= MIN_QUIET_SAMPLES && quietSpan >= MIN_QUIET_SPAN_MS;
    const vibrationRaw = hasQuietMeasurement
      ? vibrationRms(quietWindow, activeRegions, "raw") : null;
    const vibrationFiltered = hasQuietMeasurement
      ? vibrationRms(quietWindow, activeRegions, "filtered") : null;
    const vibrationDifference = vibrationRaw === null || vibrationFiltered === null
      ? null : vibrationFiltered - vibrationRaw;
    const vibrationAssessment = vibrationDifference === null ? null
      : Math.abs(vibrationDifference) <= 0.01 ? "Sin diferencia medible"
        : vibrationDifference < 0 ? "EDO reduce la vibración"
          : "EDO aumenta la vibración";
    const vibrationReduction = vibrationRaw === null || vibrationFiltered === null ||
      vibrationRaw <= 0.01 || Math.abs(vibrationDifference) <= 0.01 ? null
      : 100 * (vibrationRaw - vibrationFiltered) / vibrationRaw;

    let quietReason;
    if (!quiet){
      quietReason = motionScore === null
        ? "Reuniendo observaciones para evaluar la quietud."
        : motionScore > QUIET_ENTRY_SPEED
          ? `Movimiento detectado (${motionScore.toFixed(2)} %/s); mantén las regiones quietas.`
          : `Evaluando una ventana estable (${motionScore.toFixed(2)} %/s; umbral ≤${QUIET_ENTRY_SPEED} %/s).`;
    } else if (!hasQuietMeasurement){
      const progress = Math.min(100, Math.round(100 * quietDuration / QUIET_WINDOW_MS));
      quietReason = `Segmento estable: ${progress}% de ${QUIET_WINDOW_MS / 1000} s; ` +
        `se requieren ≥${MIN_QUIET_SAMPLES} observaciones válidas.`;
    } else {
      quietReason = `Ventana quieta de ${QUIET_WINDOW_MS / 1000} s · ` +
        `${quietWindow.length} observaciones emparejadas · vibración residual.`;
    }

    return {
      displacementRaw,
      displacementFiltered,
      displacementSamples: displacementWindow.length,
      regionCount: activeRegions.length,
      vibrationRaw,
      vibrationFiltered,
      vibrationReduction,
      vibrationAssessment,
      vibrationProgress: quiet
        ? Math.min(100, Math.round(100 * quietDuration / QUIET_WINDOW_MS))
        : 0,
      quietReason,
      displacementChange,
      displacementAssessment,
      status: currentPairs
        ? `Analizando ${activeRegions.length} ${activeRegions.length === 1 ? "región" : "regiones"} ` +
          "con coordenadas emparejadas por cuadro."
        : NO_TRACKING,
      note: ANALYSIS_NOTE
    };
  }

  function update(rawFrame, filteredFrame, timestamp, aspect = 1, filterConfig){
    if (!Number.isFinite(timestamp) || !Number.isFinite(aspect) || aspect <= 0){
      throw new RangeError("El tiempo y la relación de aspecto del diagnóstico deben ser válidos.");
    }
    const key = configSignature(filterConfig);
    const raw = regionTracks(rawFrame, aspect);
    const filtered = regionTracks(filteredFrame, aspect);
    const pairIsValid = sameRegions(raw, filtered) &&
      [...raw.keys()].every(identity => raw.get(identity).count === filtered.get(identity).count);
    if (configKey !== null && key !== configKey){
      clearSequences();
      previous = null;
    }
    configKey = key;
    if (!pairIsValid || raw.size === 0){
      const reason = raw.size === 0 ? NO_TRACKING
        : "Las coordenadas raw y EDO no contienen las mismas regiones y landmarks.";
      const alreadyReported = previous === null && lastMetrics?.status === reason;
      previous = null;
      clearSequences();
      lastMetrics = emptyMetrics(reason);
      return { ...lastMetrics, shouldUpdate: !alreadyReported };
    }

    const current = { time: timestamp, raw, filtered };
    if (!previous){
      previous = current;
      const status = "Seguimiento detectado; sincronizando el primer par de cuadros.";
      lastMetrics = emptyMetrics(status);
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
      return { ...lastMetrics, regionCount: raw.size, shouldUpdate: true };
    }
    if (!sameRegions(previous.raw, raw) ||
        [...raw.keys()].some(identity =>
          previous.raw.get(identity)?.count !== raw.get(identity)?.count)){
      clearSequences();
      previous = current;
      lastMetrics = emptyMetrics(
        "Cambió la región o identidad seguida; sincronizando sin unir trayectorias."
      );
      return { ...lastMetrics, regionCount: raw.size, shouldUpdate: true };
    }

    const dt = dtMs / 1000;
    const pairs = {};
    let rawSpeedSum = 0, filteredSpeedSum = 0;
    for (const identity of raw.keys()){
      const previousRaw = previous.raw.get(identity);
      const currentRaw = raw.get(identity);
      const previousFiltered = previous.filtered.get(identity);
      const currentFiltered = filtered.get(identity);
      const referenceScale = (previousRaw.scale + currentRaw.scale) / 2;
      const centerStep = Math.hypot(
        currentRaw.centroid.x - previousRaw.centroid.x,
        currentRaw.centroid.y - previousRaw.centroid.y
      ) / referenceScale;
      if (centerStep > MAX_IDENTITY_STEP){
        clearSequences();
        previous = current;
        lastMetrics = emptyMetrics(
          "Salto de identidad/lateralidad detectado; sincronizando el seguimiento."
        );
        return { ...lastMetrics, regionCount: raw.size, shouldUpdate: true };
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
      pairs[identity] = {
        raw: rawShape,
        filtered: filteredShape,
        rawCentroid: currentRaw.centroid,
        filteredCentroid: currentFiltered.centroid,
        scale: currentRaw.scale
      };
    }
    const rawMotion = rawSpeedSum / raw.size;
    const filteredMotion = filteredSpeedSum / filtered.size;
    displacementSamples.push({
      time: timestamp,
      weight: dt,
      raw: rawMotion,
      filtered: filteredMotion
    });
    displacementSamples = displacementSamples.filter(sample =>
      timestamp - sample.time <= DISPLACEMENT_WINDOW_MS);
    motionHistory.push({ time: timestamp, regions: raw });
    motionHistory = motionHistory.filter(sample =>
      timestamp - sample.time <= QUIET_DETECTION_WINDOW_MS);
    const { score: robustMotion, span: detectionSpan } = quietMotion(motionHistory, timestamp);
    if (!quiet && detectionSpan >= MIN_QUIET_DETECTION_SPAN_MS &&
        robustMotion !== null && robustMotion <= QUIET_ENTRY_SPEED){
      quiet = true;
      quietSince = timestamp;
      quietSamples = [];
    } else if (quiet && robustMotion !== null && robustMotion >= QUIET_EXIT_SPEED){
      quiet = false;
      quietSince = null;
      quietSamples = [];
    }
    if (quiet){
      quietSamples.push({ time: timestamp, weight: dt, regions: pairs });
      quietSamples = quietSamples.filter(sample =>
        timestamp - sample.time <= QUIET_WINDOW_MS);
    }
    previous = current;

    if (timestamp - lastMetricsAt < METRIC_UPDATE_INTERVAL_MS && lastMetrics){
      return { ...lastMetrics, shouldUpdate: false };
    }
    lastMetricsAt = timestamp;
    lastMetrics = calculate(timestamp, [...raw.keys()], robustMotion, true);
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

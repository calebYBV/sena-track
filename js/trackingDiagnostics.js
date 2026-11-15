import { estimateTrackingLagDetails } from "./filters.js";

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
const QUIET_ENTRY_DURATION_MS = 300;
const QUIET_EXIT_DURATION_MS = 400;
const MIN_QUIET_SAMPLES = 12;
const MIN_QUIET_SPAN_MS = 1400;
const LAG_WINDOW_MS = 4000;
const METRIC_UPDATE_INTERVAL_MS = 200;
const NO_TRACKING = "Muestra tus manos o rostro frente a la cámara.";
const ANALYSIS_NOTE = "Desplazamiento: RMS de velocidad 2D, normalizado por escala de referencia raw " +
  "(palma mano 0–9; ancho facial 234–454), media con igual peso por región; unidad " +
  "% de escala/s. Vibración: RMS temporal de centroide y geometría interna, " +
  "combinadas cuadráticamente y normalizadas por la misma escala raw; igual peso por " +
  "región, expresada como % de escala en una ventana de 1.5 s. " +
  "Quietud proxy: mediana de 500 ms del máximo RMS regional ≤3 %/s y 300 ms de entrada; " +
  "salida si ≥6 %/s " +
  "durante 400 ms; requiere 1.5 s y 12 observaciones. La variación es " +
  "(raw−EDO)/raw×100; no se calcula si raw o la diferencia ≤0.01 % de escala. " +
  "Este proxy no identifica " +
  "temblor fisiológico ni distingue microgestos. Retardo: correlación de velocidades " +
  "2D remuestreadas, ≥24 muestras y correlación ≥0.65; hasta 400 ms. No es latencia de " +
  "cómputo, inferencia, confirmación ni una métrica de exactitud.";

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
  let lagByRegion = new Map();
  let quiet = false;
  let quietSince = null;
  let lastMetricsAt = -Infinity;
  let lastMetrics = null;

  function clearSequences(){
    displacementSamples = [];
    motionHistory = [];
    quietSamples = [];
    lagByRegion = new Map();
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
      lagMs: null,
      lagReason: "Realiza un movimiento continuo con cambios de dirección para estimar el retardo.",
      lagCorrelation: null,
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
      const progress = motionScore !== null && motionScore <= QUIET_ENTRY_SPEED
        ? Math.min(100, Math.round(100 * (motionHistory.at(-1).time -
          motionHistory[0].time) / QUIET_ENTRY_DURATION_MS))
        : 0;
      quietReason = `Analizando quietud; mantén las regiones quietas. Movimiento normalizado ${motionScore?.toFixed(2) ??
        "—"} %/s; ${motionScore !== null && motionScore > QUIET_ENTRY_SPEED
        ? `supera el umbral de entrada de ${QUIET_ENTRY_SPEED} %/s.`
        : `entrada ≤${QUIET_ENTRY_SPEED} %/s durante ${QUIET_ENTRY_DURATION_MS} ms.`} ` +
        `Estabilidad: ${progress}%.`;
    } else if (!hasQuietMeasurement){
      const progress = Math.min(100, Math.round(100 * quietDuration / QUIET_WINDOW_MS));
      quietReason = `Segmento estable: ${progress}% de ${QUIET_WINDOW_MS / 1000} s; ` +
        `se requieren ≥${MIN_QUIET_SAMPLES} observaciones válidas.`;
    } else {
      quietReason = `Ventana quieta de ${QUIET_WINDOW_MS / 1000} s · ` +
        `${quietWindow.length} observaciones emparejadas · vibración residual.`;
    }

    let bestLag = null;
    let bestCorrelation = -Infinity;
    let bestLagRegion = null;
    let lagReason = motionScore === null || motionScore < QUIET_EXIT_SPEED
      ? `Movimiento insuficiente (<${QUIET_EXIT_SPEED} %/s); realiza un movimiento ` +
        "continuo con cambios de dirección para estimar el retardo."
      : "Se requieren 24 muestras emparejadas por región.";
    if (motionScore !== null && motionScore >= QUIET_EXIT_SPEED){
      for (const identity of activeRegions){
        const history = lagByRegion.get(identity) || [];
        const result = estimateTrackingLagDetails(history);
        if (result.lagMs !== null && result.correlation > bestCorrelation){
          bestLag = result.lagMs;
          bestCorrelation = result.correlation;
          bestLagRegion = identity;
        } else if (bestLag === null && result.reason){
          lagReason = result.reason;
        }
      }
    }
    if (bestLag !== null){
      const regionName = bestLagRegion === "hand:Left" ? "mano izquierda"
        : bestLagRegion === "hand:Right" ? "mano derecha" : "rostro";
      lagReason = `Estimación por correlación temporal de velocidades 2D · ` +
        `${regionName} · ` +
        `correlación ${bestCorrelation.toFixed(2)}.`;
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
      vibrationProgress: quiet && !hasQuietMeasurement
        ? Math.min(100, Math.round(100 * quietDuration / QUIET_WINDOW_MS)) : 0,
      quietReason,
      lagMs: bestLag,
      lagReason,
      lagCorrelation: bestLag === null ? null : bestCorrelation,
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
    let rawSpeedSum = 0, filteredSpeedSum = 0, motionScore = 0;
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
      motionScore = Math.max(motionScore, rawSpeed);
      pairs[identity] = {
        raw: rawShape,
        filtered: filteredShape,
        rawCentroid: currentRaw.centroid,
        filteredCentroid: currentFiltered.centroid,
        scale: currentRaw.scale
      };
      const lagHistory = lagByRegion.get(identity) || [];
      const rawCenter = previous.raw.get(identity).centroid;
      const filteredCenter = previous.filtered.get(identity).centroid;
      lagHistory.push({
        raw: { x: rawCenter.x, y: rawCenter.y },
        filtered: { x: filteredCenter.x, y: filteredCenter.y },
        time: previous.time,
        aspect: 1
      });
      lagHistory.push({
        raw: { x: currentRaw.centroid.x, y: currentRaw.centroid.y },
        filtered: { x: currentFiltered.centroid.x, y: currentFiltered.centroid.y },
        time: timestamp,
        aspect: 1
      });
      const uniqueHistory = lagHistory.filter((sample, index) =>
        index === 0 || sample.time > lagHistory[index - 1].time);
      const retained = uniqueHistory.filter(sample => timestamp - sample.time <= LAG_WINDOW_MS);
      lagByRegion.set(identity, retained);
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
    motionHistory.push({ time: timestamp, score: motionScore });
    motionHistory = motionHistory.filter(sample =>
      timestamp - sample.time <= QUIET_DETECTION_WINDOW_MS);
    const detectionSpan = motionHistory.length > 1
      ? motionHistory.at(-1).time - motionHistory[0].time : 0;
    const robustMotion = median(motionHistory.map(sample => sample.score));
    if (!quiet && detectionSpan >= QUIET_ENTRY_DURATION_MS &&
        robustMotion !== null && robustMotion <= QUIET_ENTRY_SPEED){
      quiet = true;
      quietSince = timestamp;
      quietSamples = [];
    } else if (quiet && detectionSpan >= QUIET_EXIT_DURATION_MS &&
        robustMotion !== null && robustMotion >= QUIET_EXIT_SPEED){
      quiet = false;
      quietSince = null;
      quietSamples = [];
    }
    if (quiet && motionScore <= QUIET_EXIT_SPEED){
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

// Diagnostic 2-D displacement across all currently visible tracking components.
// Each hand and the face contribute equal weight; no recognition decisions use this metric.
const TRACKS = [
  ["Mano izquierda", frame => frame?.hands?.Left],
  ["Mano derecha", frame => frame?.hands?.Right],
  ["Rostro", frame => frame?.faceLandmarks]
];

function hasPoints(points){
  return Array.isArray(points) && points.length > 0 &&
    points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
}

function rmsDisplacement(previous, current, aspect){
  if (!hasPoints(previous) || !hasPoints(current) || previous.length !== current.length) return null;
  let squareSum = 0;
  for (let index = 0; index < current.length; index++){
    const dx = (current[index].x - previous[index].x) * aspect;
    const dy = current[index].y - previous[index].y;
    squareSum += dx * dx + dy * dy;
  }
  return Math.sqrt(squareSum / current.length);
}

export function globalTraceDisplacement(previousRaw, previousFiltered, raw, filtered, aspect = 1){
  if (!previousRaw || !previousFiltered || !raw || !filtered ||
    !Number.isFinite(aspect) || aspect <= 0) return null;
  const components = [];
  let rawSum = 0;
  let filteredSum = 0;
  for (const [name, read] of TRACKS){
    const oldRaw = read(previousRaw);
    const oldFiltered = read(previousFiltered);
    const nowRaw = read(raw);
    const nowFiltered = read(filtered);
    const hadTrack = hasPoints(oldRaw) && hasPoints(oldFiltered);
    const hasTrack = hasPoints(nowRaw) && hasPoints(nowFiltered);
    // Do not connect data from frames with a different set of tracked components.
    if (hadTrack !== hasTrack) return null;
    if (!hasTrack) continue;
    const rawMotion = rmsDisplacement(oldRaw, nowRaw, aspect);
    const filteredMotion = rmsDisplacement(oldFiltered, nowFiltered, aspect);
    if (rawMotion == null || filteredMotion == null) return null;
    components.push(name);
    rawSum += rawMotion;
    filteredSum += filteredMotion;
  }
  if (!components.length) return null;
  return {
    raw: rawSum / components.length,
    filtered: filteredSum / components.length,
    components
  };
}

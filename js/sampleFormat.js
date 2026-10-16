export const SAMPLE_FORMAT_VERSION = 2;
export const SAMPLE_MAX_BYTES = 12 * 1024 * 1024;
export const SAMPLE_MAX_DURATION_MS = 30_000;
export const SAMPLE_MAX_FRAMES = 900;
export const SAMPLE_STORAGE_THRESHOLD_BYTES = 64 * 1024;

function finiteVector(value, length){
  return Array.isArray(value) && value.length === length &&
    value.every(Number.isFinite);
}

function validLandmarks(value){
  return Array.isArray(value) && value.length === 21 &&
    value.every(point => finiteVector(point, 3));
}

function validComponents(value){
  return value && typeof value === "object" &&
    ["left", "right", "face"].every(key => typeof value[key] === "boolean") &&
    (value.left || value.right || value.face);
}

function validFrame(frame){
  if (!frame || !Number.isFinite(frame.time) || frame.time < 0 ||
      !frame.presence || typeof frame.presence !== "object") return false;
  for (const side of ["Left", "Right"]){
    const present = frame.presence[side];
    const landmarks = frame.hands?.[side];
    if (typeof present !== "boolean" || (present && !validLandmarks(landmarks)) ||
        (!present && landmarks !== undefined)) return false;
  }
  if (typeof frame.presence.face !== "boolean" ||
      typeof frame.presence.faceFeatures !== "boolean") return false;
  if (frame.presence.face &&
      (!Array.isArray(frame.faceLandmarks) || frame.faceLandmarks.length < 468 ||
       frame.faceLandmarks.some(point => !finiteVector(point, 3)))) return false;
  if (!frame.presence.face && frame.faceLandmarks !== undefined) return false;
  if (frame.presence.faceFeatures &&
      (!frame.presence.face || !Array.isArray(frame.faceFeatures) ||
       frame.faceFeatures.length !== 32 || !frame.faceFeatures.every(Number.isFinite))) return false;
  if (!frame.presence.faceFeatures && frame.faceFeatures !== undefined) return false;
  return true;
}

function validDescriptor(descriptor, components){
  if (!descriptor || typeof descriptor !== "object" || !descriptor.hands ||
      typeof descriptor.hands !== "object") return false;
  for (const [enabled, side] of [[components.left, "Left"], [components.right, "Right"]]){
    if (enabled && (!Array.isArray(descriptor.hands[side]) ||
        descriptor.hands[side].length !== 63 || !descriptor.hands[side].every(Number.isFinite))) return false;
  }
  if (components.face && (!Array.isArray(descriptor.face) || descriptor.face.length !== 32 ||
      !descriptor.face.every(Number.isFinite))) return false;
  if (descriptor.placement !== null && descriptor.placement !== undefined){
    for (const side of ["Left", "Right"]){
      if (descriptor.placement[side] !== undefined &&
          (!finiteVector(descriptor.placement[side], 3))) return false;
    }
  }
  return true;
}

function validateFrameSequences(rawFrames, filteredFrames, components){
  if (!Array.isArray(rawFrames) || rawFrames.length < 8 ||
      rawFrames.length > SAMPLE_MAX_FRAMES || rawFrames.some(frame => !validFrame(frame)) ||
      !Array.isArray(filteredFrames) || filteredFrames.length !== rawFrames.length ||
      filteredFrames.some(frame => !validFrame(frame))){
    throw new TypeError("La captura debe conservar cuadros sincronizados y coordenadas originales válidas.");
  }
  let previousTime = -1;
  for (const frame of rawFrames){
    if (frame.time <= previousTime) throw new TypeError("Los tiempos de captura deben ser estrictamente crecientes.");
    previousTime = frame.time;
    if (components.face && !frame.presence.faceFeatures ||
        components.left && !frame.presence.Left ||
        components.right && !frame.presence.Right){
      throw new TypeError("La captura no contiene todos los componentes requeridos.");
    }
  }
  for (let index = 0; index < rawFrames.length; index++){
    const raw = rawFrames[index], filtered = filteredFrames[index];
    if (filtered.time !== raw.time ||
        ["Left", "Right", "face", "faceFeatures"].some(part =>
          filtered.presence[part] !== raw.presence[part])){
      throw new TypeError("Las ramas raw y EDO deben conservar la misma presencia y tiempo por cuadro.");
    }
  }
  if (previousTime > SAMPLE_MAX_DURATION_MS){
    throw new RangeError(`La captura excede ${SAMPLE_MAX_DURATION_MS / 1000} segundos.`);
  }
}

function validateStatic(sample){
  if (sample.source === "paired-raw-and-filtered-v2" && !sample.components){
    throw new TypeError("El formato holístico requiere los componentes de la seña.");
  }
  if (sample.components && !validComponents(sample.components)){
    throw new TypeError("Los componentes requeridos de la seña no son válidos.");
  }
  if (sample.components){
    validateFrameSequences(sample.rawFrames, sample.filteredFrames, sample.components);
    if (!validDescriptor(sample.h, sample.components) ||
        !validDescriptor(sample.rh, sample.components)){
      throw new TypeError("Las características holísticas no son válidas.");
    }
    return;
  }
  if (!Array.isArray(sample.f) || sample.f.length !== 63 ||
      !sample.f.every(Number.isFinite)){
    throw new TypeError("Una seña fija debe incluir 63 características finitas.");
  }
  if (sample.r !== undefined && (!Array.isArray(sample.r) || sample.r.length !== 63 ||
      !sample.r.every(Number.isFinite))){
    throw new TypeError("Las características raw de la seña fija no son válidas.");
  }
  if (sample.lm !== undefined && !validLandmarks(sample.lm)){
    throw new TypeError("Las coordenadas originales deben contener 21 puntos x/y/z finitos.");
  }
  if (sample.source === "paired-raw-and-filtered-v1" && !sample.lm){
    throw new TypeError("La captura nueva debe conservar sus coordenadas originales.");
  }
  if (sample.captureTimeMs !== undefined &&
      (!Number.isFinite(sample.captureTimeMs) || sample.captureTimeMs < 0 ||
       sample.captureTimeMs > SAMPLE_MAX_DURATION_MS)){
    throw new RangeError("El tiempo relativo de captura de la seña fija no es válido.");
  }
}

function validateMotion(sample){
  if (sample.source === "paired-raw-and-filtered-v2" && !sample.components){
    throw new TypeError("El formato holístico requiere los componentes de la seña.");
  }
  if (sample.components && !validComponents(sample.components)){
    throw new TypeError("Los componentes requeridos de la seña no son válidos.");
  }
  if (sample.components){
    const raw = sample.rawFrames;
    const filtered = sample.filteredFrames;
    validateFrameSequences(raw, filtered, sample.components);
    if (!Array.isArray(sample.filteredHolisticSequence) ||
        sample.filteredHolisticSequence.length !== 24 ||
        !Array.isArray(sample.rawHolisticSequence) ||
        sample.rawHolisticSequence.length !== 24 ||
        [...sample.filteredHolisticSequence, ...sample.rawHolisticSequence]
          .some(frame => !validDescriptor(frame, sample.components))){
      throw new TypeError("La secuencia EDO y original debe contener 24 cuadros sincronizados.");
    }
    return;
  }
  for (const field of ["s", "r"]){
    if (sample[field] !== undefined &&
        (!Array.isArray(sample[field]) || sample[field].length !== 24 ||
         sample[field].some(frame => !Array.isArray(frame) || frame.length !== 65 ||
           !frame.every(Number.isFinite)))){
      throw new TypeError(`La secuencia ${field} debe contener 24 vectores de 65 valores finitos.`);
    }
  }
  if (Array.isArray(sample.rawFrames)){
    if (sample.rawFrames.length < 8 || sample.rawFrames.length > SAMPLE_MAX_FRAMES){
      throw new TypeError(`La captura debe contener entre 8 y ${SAMPLE_MAX_FRAMES} cuadros originales.`);
    }
    let previousTime = -1;
    for (const frame of sample.rawFrames){
      if (!validLandmarks(frame.lm) || !["Left", "Right"].includes(frame.hand) ||
          !Number.isFinite(frame.time) || frame.time < 0 || frame.time <= previousTime){
        throw new TypeError("Los cuadros originales tienen puntos, lateralidad u orden temporal inválido.");
      }
      previousTime = frame.time;
    }
    if (previousTime > SAMPLE_MAX_DURATION_MS){
      throw new RangeError(`La captura excede ${SAMPLE_MAX_DURATION_MS / 1000} segundos.`);
    }
  } else if (sample.source === "paired-raw-and-filtered-v1"){
    throw new TypeError("Una captura nueva con movimiento debe conservar sus coordenadas originales.");
  } else if (!Array.isArray(sample.s)){
    throw new TypeError("La muestra heredada no contiene una secuencia reconocible.");
  }
}

export function validateSample(sample, kind){
  if (!sample || typeof sample !== "object" || typeof sample.l !== "string" ||
      !sample.l.trim() || sample.l.trim().length > 80){
    throw new TypeError("La muestra debe tener un nombre de seña entre 1 y 80 caracteres.");
  }
  if (sample.kind !== undefined && sample.kind !== kind){
    throw new TypeError("El tipo guardado no coincide con el tipo de la muestra.");
  }
  if (sample.formatVersion !== undefined && ![1, SAMPLE_FORMAT_VERSION].includes(sample.formatVersion)){
    throw new TypeError("La versión del formato de la muestra no es compatible.");
  }
  if (kind === "static") validateStatic(sample);
  else if (kind === "motion") validateMotion(sample);
  else throw new TypeError("El tipo de seña debe ser static o motion.");
}

export function prepareSamplePayload(sample, kind){
  validateSample(sample, kind);
  const payload = structuredClone(sample);
  delete payload.syncStatus;
  payload.formatVersion = SAMPLE_FORMAT_VERSION;
  payload.kind = kind;
  const knownProcessing = sample.source === "paired-raw-and-filtered-v2";
  payload.provenance = {
    rawCoordinatesAvailable: Array.isArray(sample.rawFrames) || Array.isArray(sample.lm),
    facialCoordinatesAvailable: Array.isArray(sample.rawFrames) &&
      sample.rawFrames.some(frame => frame.presence?.face),
    facialFeaturesUsed: Boolean(sample.components?.face),
    legacy: !knownProcessing,
    ...(knownProcessing ? {} : {
      processing: sample.source || "legacy-smoothing-unknown",
      format: kind === "motion" && !sample.rawFrames ? "legacy-features-only" : "legacy-capture"
    })
  };
  if (payload.rawFrames && payload.filteredFrames){
    const firstTime = payload.rawFrames[0].time;
    payload.rawFrames = payload.rawFrames.map(frame => ({
      ...frame,
      time: frame.time - firstTime
    }));
    payload.filteredFrames = payload.filteredFrames.map((frame, index) => ({
      ...frame,
      time: payload.rawFrames[index].time
    }));
  } else if (kind === "motion" && payload.rawFrames){
    const firstTime = payload.rawFrames[0].time;
    payload.rawFrames = payload.rawFrames.map(frame => ({
      ...frame,
      time: frame.time - firstTime
    }));
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > SAMPLE_MAX_BYTES){
    throw new RangeError(`La muestra supera el límite de ${SAMPLE_MAX_BYTES / 1024 / 1024} MiB.`);
  }
  return { payload, bytes };
}

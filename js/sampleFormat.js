export const SAMPLE_FORMAT_VERSION = 1;
export const SAMPLE_MAX_BYTES = 4 * 1024 * 1024;
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

function validateStatic(sample){
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
  if (kind === "static") validateStatic(sample);
  else if (kind === "motion") validateMotion(sample);
  else throw new TypeError("El tipo de seña debe ser static o motion.");
}

export function prepareSamplePayload(sample, kind){
  validateSample(sample, kind);
  const payload = structuredClone(sample);
  payload.formatVersion = SAMPLE_FORMAT_VERSION;
  const knownProcessing = sample.source === "paired-raw-and-filtered-v1";
  payload.provenance = {
    rawCoordinatesAvailable: kind === "static"
      ? Array.isArray(sample.lm)
      : Array.isArray(sample.rawFrames),
    legacy: !knownProcessing,
    ...(knownProcessing ? {} : {
      processing: sample.source || "legacy-smoothing-unknown",
      format: kind === "motion" && !sample.rawFrames ? "legacy-features-only" : "legacy-capture"
    })
  };
  if (kind === "motion" && payload.rawFrames){
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

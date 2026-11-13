export const RECOGNITION_MODES = Object.freeze(["edo", "mediapipe"]);

export function recognitionBranch(state){
  return state.recognitionMode === "mediapipe" ? "raw" : "filtered";
}

export function shouldProcessEdo(state){
  return recognitionBranch(state) === "filtered" || !!state.recognitionEnabled ||
    !!state.motion || !!state.capState || !!state.filterConfig?.compareVisual;
}

export function selectActivePrediction(rawPrediction, filteredPrediction, mode){
  return mode === "mediapipe" ? rawPrediction : filteredPrediction;
}

export function resetRecognitionForModeChange(state, mode){
  if (!RECOGNITION_MODES.includes(mode)){
    throw new RangeError(`Modo de reconocimiento desconocido: ${mode}`);
  }
  if (state.recognitionMode === mode) return false;

  state.recognitionMode = mode;
  state.recognitionGeneration = (state.recognitionGeneration || 0) + 1;
  state.cand = null;
  state.candCount = 0;
  state.candSince = null;
  state.noHand = 0;
  state.noHandSince = null;
  state.neutralSince = null;
  state.readoutLock = 0;
  if (state.motion?.purpose === "recognize"){
    state.motion.frames = [];
    state.motion.lastEvaluatedAt = 0;
    state.motion.lastComparedAt = 0;
    state.motion.armed = true;
    state.motion.segmentActive = false;
    state.motion.unrecognizedSince = 0;
  }
  return true;
}

export function isCurrentRecognitionResult(state, generation){
  return generation === state.recognitionGeneration;
}

export function isRecognitionActive(state){
  return !!state.recognitionEnabled || state.motion?.purpose === "recognize";
}

export function shouldAutoAppendPhrase(state, label, now = performance.now(),
    generation = state.recognitionGeneration){
  if (!isCurrentRecognitionResult(state, generation)) return false;
  if (!label || !String(label).trim() || !state.recognitionEnabled) return false;
  const normalized = String(label).trim();
  const repeated = normalized === state.lastRecognitionLabel &&
    Number.isFinite(state.lastRecognitionAt) &&
    now - state.lastRecognitionAt < 100;
  if (repeated) return false;
  state.lastRecognitionLabel = normalized;
  state.lastRecognitionAt = now;
  return true;
}

export function selectUnifiedPrediction(staticPrediction, motionPrediction){
  const staticLabel = staticPrediction?.label;
  const motionLabel = motionPrediction?.label;
  if (staticPrediction?.reason === "ambiguous" || motionPrediction?.reason === "ambiguous"){
    const candidates = [...new Set([
      ...(staticPrediction.candidates || []),
      ...(motionPrediction.candidates || []),
      ...(staticLabel ? [staticLabel] : []),
      ...(motionLabel ? [motionLabel] : [])
    ])];
    return { label: null, reason: "ambiguous", candidates };
  }
  if (staticLabel && motionLabel && staticLabel !== motionLabel){
    return { label: null, reason: "ambiguous", candidates: [staticLabel, motionLabel] };
  }
  if (staticLabel && motionLabel){
    return { ...staticPrediction, src: "postura y trayectoria" };
  }
  return staticPrediction?.label ? staticPrediction : motionPrediction?.label ? motionPrediction : null;
}

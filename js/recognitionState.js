export function isRecognitionActive(state){
  return !!state.recognitionEnabled || state.motion?.purpose === "recognize";
}

export function shouldAutoAppendPhrase(state, label, now = performance.now()){
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

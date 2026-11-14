import { extractHolisticFeatures } from "./holistic.js";
import { analyzeUnifiedCapture } from "./unifiedCapture.js";
import {
  SAMPLE_MAX_DURATION_MS,
  SAMPLE_FORMAT_VERSION,
  validateEvaluationCapture,
  validateSample
} from "./sampleFormat.js";

function storedFrame(frame, time, presence){
  const hands = {};
  for (const side of ["Left", "Right"]){
    if (presence[side]){
      hands[side] = frame.hands[side].map(({ x, y, z }) => [x, y, z]);
    }
  }
  const result = {
    time,
    presence: { ...presence },
    hands
  };
  if (presence.face){
    result.faceLandmarks = frame.faceLandmarks.map(({ x, y, z }) => [x, y, z]);
  }
  if (presence.faceFeatures) result.faceFeatures = frame.faceFeatures.slice();
  return result;
}

export function buildEvaluationSample({
  rawFrames, components, truth, kind, captureId, participantId, sessionId,
  capturedAt = new Date().toISOString()
}, recognition, filterConfig, aspect){
  const analysis = analyzeUnifiedCapture(rawFrames, components, aspect);
  if (analysis.kind !== kind){
    const reason = analysis.reason === "incomplete-motion"
      ? "El movimiento no terminó con una pausa estable; vuelve a capturar la trayectoria completa."
      : analysis.kind === "static"
        ? "Se detectó una postura estática, no una trayectoria dinámica."
        : analysis.kind === "motion"
          ? "Se detectó movimiento, no una postura estática."
          : "La captura no contiene suficientes cuadros o componentes válidos.";
    throw new TypeError(reason);
  }

  const filteredFrames = recognition.filterFrames(rawFrames, filterConfig)
    .map((frame, index) => ({
      time: frame.time,
      presence: rawFrames[index].presence,
      hands: Object.fromEntries(Object.entries(frame.hands).map(([side, points]) =>
        [side, points.map(({ x, y, z }) => [x, y, z])])),
      ...(frame.faceLandmarks ? {
        faceLandmarks: frame.faceLandmarks.map(({ x, y, z }) => [x, y, z])
      } : {}),
      ...(frame.faceFeatures ? { faceFeatures: frame.faceFeatures } : {})
    }));
  const sample = {
    l: truth,
    truth,
    kind,
    formatVersion: SAMPLE_FORMAT_VERSION,
    components,
    source: "paired-raw-and-filtered-v2",
    captureId,
    ...(participantId ? { participantId } : {}),
    ...(sessionId ? { sessionId } : {}),
    capturedAt,
    rawFrames,
    filteredFrames
  };
  if (kind === "static"){
    const rawDescriptors = rawFrames.map(frame =>
      extractHolisticFeatures(frame, aspect, components));
    const filteredDescriptors = filteredFrames.map(frame =>
      extractHolisticFeatures(frame, aspect, components));
    if (rawDescriptors.some(value => !value) || filteredDescriptors.some(value => !value)){
      throw new TypeError("No se pudieron extraer las características holísticas de la captura.");
    }
    sample.rh = recognition.meanDescriptors(rawDescriptors);
    sample.h = recognition.meanDescriptors(filteredDescriptors);
  } else {
    sample.rawHolisticSequence = recognition.holisticMotionSequence(
      rawFrames, components, aspect);
    sample.filteredHolisticSequence = recognition.holisticMotionSequence(
      filteredFrames, components, aspect);
    if (!sample.rawHolisticSequence || !sample.filteredHolisticSequence){
      throw new TypeError("No se pudo construir una trayectoria holística completa.");
    }
  }
  validateSample(sample, kind);
  validateEvaluationCapture(sample);
  return sample;
}

export function createEvaluationCapture({ state, dom, recognition, onUpdate }){
  const { $, video } = dom;
  const samples = [];
  let recording = null;
  let lastProgressCount = 0;
  const maximumFrameGapMs = 250;

  function counts(){
    return Object.fromEntries(["training", "validation", "test"].map(split => [
      split, samples.filter(sample => sample.split === split).length
    ]));
  }

  function notify(message){
    onUpdate({ message, counts: counts(), recording: Boolean(recording) });
  }

  function start(){
    if (!state.ready){
      notify("La cámara todavía no está lista.");
      return;
    }
    if (state.capState || state.motion){
      notify("Termina la captura o el movimiento actual antes de grabar una prueba.");
      return;
    }
    const truth = $("evalTruth").value.trim();
    const components = {
      left: $("requireLeft").checked,
      right: $("requireRight").checked,
      face: $("requireFace").checked
    };
    if (!truth || truth.length > 80){
      notify("Escribe la etiqueta verdadera (1–80 caracteres).");
      return;
    }
    if (!components.left && !components.right && !components.face){
      notify("Selecciona al menos una mano o el rostro como componente requerido.");
      return;
    }
    const participantId = $("evalParticipant").value.trim();
    const sessionId = $("evalSession").value.trim();
    const durationMs = Number($("evalDuration").value);
    if (!["static", "motion"].includes($("evalKind").value) ||
        !["training", "validation", "test"].includes($("evalSplit").value)){
      notify("El tipo o la partición de captura no son válidos.");
      return;
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0 ||
        durationMs > SAMPLE_MAX_DURATION_MS){
      notify(`La duración debe ser mayor que cero y no superar ${SAMPLE_MAX_DURATION_MS / 1000} segundos.`);
      return;
    }
    if (participantId.length > 128 || sessionId.length > 128){
      notify("Los identificadores seudónimos no pueden superar 128 caracteres.");
      return;
    }
    recording = {
      truth,
      kind: $("evalKind").value,
      split: $("evalSplit").value,
      durationMs,
      components,
      ...(participantId ? { participantId } : {}),
      ...(sessionId ? { sessionId } : {}),
      frames: [],
      startedAt: null,
      lastFrameAt: null
    };
    lastProgressCount = 0;
    notify("Esperando las partes requeridas para iniciar la captura.");
  }

  function finish(){
    const current = recording;
    recording = null;
    const aspect = video.videoWidth / video.videoHeight;
    try {
      const sample = buildEvaluationSample({
        rawFrames: current.frames,
        components: current.components,
        truth: current.truth,
        kind: current.kind,
        captureId: crypto.randomUUID(),
        participantId: current.participantId,
        sessionId: current.sessionId
      }, recognition, state.filterConfig, aspect);
      samples.push({ ...sample, split: current.split });
      notify(`Captura ${current.kind} “${current.truth}” guardada en ${current.split}.`);
    } catch (error){
      notify(`Captura descartada: ${error.message}`);
    }
  }

  function captureFrame(frame, presence, timestamp){
    if (!recording) return;
    const required = recording.components;
    if (required.left && !presence.Left ||
        required.right && !presence.Right ||
        required.face && (!presence.face || !presence.faceFeatures)) return;
    if (recording.lastFrameAt !== null &&
        timestamp - recording.lastFrameAt > maximumFrameGapMs){
      cancel("Captura descartada: hubo una interrupción de más de 250 ms entre cuadros.");
      return;
    }
    if (recording.startedAt === null) recording.startedAt = timestamp;
    recording.lastFrameAt = timestamp;
    recording.frames.push(storedFrame(
      frame, timestamp - recording.startedAt, presence));
    if (timestamp - recording.startedAt >= recording.durationMs){
      finish();
      return;
    }
    if (recording.frames.length - lastProgressCount >= 15){
      lastProgressCount = recording.frames.length;
      notify(`Grabando ${recording.frames.length} cuadros…`);
    }
  }

  function cancel(message = "Captura cancelada; no se guardaron sus cuadros."){
    if (!recording) return;
    recording = null;
    notify(message);
  }

  function exportSplit(){
    const split = $("evalSplit").value;
    const selected = samples.filter(sample => sample.split === split);
    if (!selected.length){
      notify(`No hay capturas en la partición ${split} para exportar.`);
      return;
    }
    const payload = {
      schemaVersion: 2,
      aspectRatio: video.videoWidth / video.videoHeight,
      ...(split === "training" ? {
        static: selected.filter(sample => sample.kind === "static"),
        motion: selected.filter(sample => sample.kind === "motion")
      } : { samples: selected })
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${split}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify(`Exportadas ${selected.length} capturas de ${split}.`);
  }

  function clear(){
    cancel("Captura cancelada al cambiar de cuenta.");
    samples.length = 0;
    notify("Capturas de evaluación eliminadas de esta sesión.");
  }

  $("evalCaptureStart").addEventListener("click", start);
  $("evalCaptureCancel").addEventListener("click", () => cancel());
  $("evalExport").addEventListener("click", exportSplit);
  $("evalClear").addEventListener("click", clear);
  notify("Listo para grabar una captura etiquetada.");

  return {
    captureFrame,
    cancel,
    clear,
    isRecording: () => Boolean(recording)
  };
}

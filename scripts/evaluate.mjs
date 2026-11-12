import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { extractHolisticFeatures } from "../js/holistic.js";
import { DEFAULT_FILTER_CONFIG, normalizeFilterConfig } from "../js/filters.js";
import { assertIndependentEvaluationSet, evaluateModels } from "../js/evaluation.js";
import { createRecognition, DEFAULT_AMBIGUITY_CONFIG, normalizeAmbiguityConfig } from "../js/recognition.js";
import { validateRawCapture, validateSample } from "../js/sampleFormat.js";

const args = process.argv.slice(2);
const participantSplit = args.includes("--participant-split");
const paths = args.filter(argument => !argument.startsWith("--"));
if (paths.length !== 2){
  console.error("Uso: node scripts/evaluate.mjs referencias.json prueba-etiquetada.json [--participant-split]");
  process.exitCode = 2;
} else {
  try {
    const referencesFile = JSON.parse(await readFile(paths[0], "utf8"));
    const evaluationFile = JSON.parse(await readFile(paths[1], "utf8"));
    const references = [
      ...(referencesFile.static || referencesFile.s || []),
      ...(referencesFile.motion || referencesFile.m || [])
    ].filter(sample => sample.syncStatus !== "pending");
    const evaluation = evaluationFile.samples;
    const aspectRatio = Number(evaluationFile.aspectRatio ?? referencesFile.aspectRatio ?? 4 / 3);
    if (!Number.isFinite(aspectRatio) || aspectRatio < 0.5 || aspectRatio > 3){
      throw new RangeError("aspectRatio debe ser finito y estar entre 0.5 y 3.");
    }
    const staticTolerance = Number(evaluationFile.staticTolerance ?? 0.8);
    const motionTolerance = Number(evaluationFile.motionTolerance ?? 0.7);
    if (!Number.isFinite(staticTolerance) || staticTolerance < 0.3 || staticTolerance > 1.5 ||
        !Number.isFinite(motionTolerance) || motionTolerance < 0.2 || motionTolerance > 2){
      throw new RangeError("Las tolerancias de evaluación están fuera de los límites admitidos.");
    }
    if (!references.length) throw new TypeError("El archivo de referencias está vacío.");
    if (!Array.isArray(evaluation) || !evaluation.length){
      throw new TypeError("El archivo de prueba debe contener un arreglo samples no vacío.");
    }
    for (const sample of references){
      validateSample(sample, sample.kind);
      if (!sample.components || sample.source !== "paired-raw-and-filtered-v2"){
        throw new TypeError("Las referencias deben ser capturas holísticas v2 con cuadros raw reprocesables.");
      }
    }
    for (const sample of evaluation){
      validateRawCapture(sample);
      if (!sample.components || sample.source !== "paired-raw-and-filtered-v2"){
        throw new TypeError("La prueba requiere capturas holísticas v2 con componentes y coordenadas raw.");
      }
    }
    assertIndependentEvaluationSet(references, evaluation, {
      separateParticipants: participantSplit
    });

    const state = {
      samples: references.filter(sample => sample.kind === "static"),
      motions: references.filter(sample => sample.kind === "motion"),
      filterConfig: { ...DEFAULT_FILTER_CONFIG },
      ambiguityConfig: normalizeAmbiguityConfig(
        evaluationFile.ambiguityConfig || DEFAULT_AMBIGUITY_CONFIG)
    };
    const recognition = createRecognition({
      state,
      dom: {
        $: id => ({ value: String(id === "tolM" ? motionTolerance : staticTolerance) }),
        video: { videoWidth: aspectRatio * 480, videoHeight: 480 }
      }
    });
    const models = [
      { id: "off", model: "off" },
      { id: "first", model: "first" },
      { id: "second", model: "second" }
    ];
    const metrics = evaluateModels(evaluation, models, (record, model) => {
      state.filterConfig = normalizeFilterConfig({ ...DEFAULT_FILTER_CONFIG, ...model });
      recognition.prepareFilteredReferences(state.filterConfig);
      const start = performance.now();
      const frames = recognition.filterFrames(record.rawFrames, state.filterConfig);
      let prediction;
      if (record.kind === "static"){
        const descriptors = frames.map(frame => extractHolisticFeatures(
          frame, aspectRatio, record.components));
        if (descriptors.some(descriptor => !descriptor)){
          prediction = null;
        } else {
          prediction = recognition.classifyStaticDescriptor(
            recognition.meanDescriptors(descriptors), record.components, "filtered");
        }
      } else {
        prediction = recognition.classifyFrame(
          { filteredFrames: frames }, "filtered", "motion");
      }
      return { prediction, latencyMs: performance.now() - start };
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      testCount: evaluation.length,
      aspectRatio,
      thresholds: { staticTolerance, motionTolerance, ambiguity: state.ambiguityConfig },
      classes: [...new Set(evaluation.map(sample => sample.truth))].sort(),
      split: assertIndependentEvaluationSet(references, evaluation, {
        separateParticipants: participantSplit
      }),
      latencyDefinition: "Tiempo local de reprocesamiento de cuadros raw y clasificación; excluye inferencia MediaPipe, carga de modelos y preparación inicial de referencias.",
      metrics
    }, null, 2)}\n`);
  } catch (error){
    console.error(`No se pudo completar la evaluación: ${error.message}`);
    process.exitCode = 1;
  }
}

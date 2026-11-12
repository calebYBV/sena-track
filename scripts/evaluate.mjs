import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { extractHolisticFeatures } from "../js/holistic.js";
import { DEFAULT_FILTER_CONFIG, normalizeFilterConfig } from "../js/filters.js";
import {
  assertIndependentEvaluationSets,
  evaluateModels,
  replayStaticConfirmation
} from "../js/evaluation.js";
import {
  createRecognition,
  DEFAULT_AMBIGUITY_CONFIG,
  normalizeAmbiguityConfig,
  STATIC_CONFIRMATION_FRAMES
} from "../js/recognition.js";
import { validateEvaluationCapture, validateSample } from "../js/sampleFormat.js";

const args = process.argv.slice(2);
const participantSplit = args.includes("--participant-split");
const sessionSplit = args.includes("--session-split");
const knownOptions = new Set(["--participant-split", "--session-split"]);
const unknownOptions = args.filter(argument =>
  argument.startsWith("--") && !knownOptions.has(argument));
const paths = args.filter(argument => !argument.startsWith("--"));
if (unknownOptions.length){
  console.error(`Opción desconocida: ${unknownOptions[0]}`);
  process.exitCode = 2;
} else if (paths.length !== 3){
  console.error("Uso: node scripts/evaluate.mjs entrenamiento.json validacion.json prueba.json [--participant-split] [--session-split]");
  process.exitCode = 2;
} else {
  try {
    const referencesFile = JSON.parse(await readFile(paths[0], "utf8"));
    const validationFile = JSON.parse(await readFile(paths[1], "utf8"));
    const testFile = JSON.parse(await readFile(paths[2], "utf8"));
    if (!referencesFile || typeof referencesFile !== "object" ||
        !validationFile || typeof validationFile !== "object" ||
        !testFile || typeof testFile !== "object"){
      throw new TypeError("Los tres archivos deben contener objetos JSON.");
    }
    const references = [
      ...(referencesFile.static || referencesFile.s || []),
      ...(referencesFile.motion || referencesFile.m || [])
    ].filter(sample => sample.syncStatus !== "pending");
    const validation = validationFile.samples;
    const evaluation = testFile.samples;
    const aspectRatio = Number(
      validationFile.aspectRatio ?? referencesFile.aspectRatio ?? 4 / 3);
    if (!Number.isFinite(aspectRatio) || aspectRatio < 0.5 || aspectRatio > 3){
      throw new RangeError("aspectRatio debe ser finito y estar entre 0.5 y 3.");
    }
    const staticTolerance = Number(validationFile.staticTolerance ?? 0.8);
    const motionTolerance = Number(validationFile.motionTolerance ?? 0.7);
    if (!Number.isFinite(staticTolerance) || staticTolerance < 0.3 || staticTolerance > 1.5 ||
        !Number.isFinite(motionTolerance) || motionTolerance < 0.2 || motionTolerance > 2){
      throw new RangeError("Las tolerancias definidas con validación están fuera de los límites admitidos.");
    }
    if (!references.length) throw new TypeError("El archivo de referencias está vacío.");
    if (!Array.isArray(validation) || !validation.length){
      throw new TypeError("El archivo de validación debe contener un arreglo samples no vacío.");
    }
    if (!Array.isArray(evaluation) || !evaluation.length){
      throw new TypeError("El archivo de prueba debe contener un arreglo samples no vacío.");
    }
    for (const sample of references){
      validateSample(sample, sample.kind);
      if (!sample.components || sample.source !== "paired-raw-and-filtered-v2"){
        throw new TypeError("Las referencias deben ser capturas holísticas v2 con cuadros raw reprocesables.");
      }
    }
    for (const sample of validation) validateEvaluationCapture(sample);
    for (const sample of evaluation) validateEvaluationCapture(sample);
    const split = assertIndependentEvaluationSets(references, validation, evaluation, {
      separateParticipants: participantSplit,
      separateSessions: sessionSplit
    });

    const state = {
      samples: references.filter(sample => sample.kind === "static"),
      motions: references.filter(sample => sample.kind === "motion"),
      filterConfig: { ...DEFAULT_FILTER_CONFIG },
      ambiguityConfig: normalizeAmbiguityConfig(
        validationFile.ambiguityConfig || DEFAULT_AMBIGUITY_CONFIG)
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
    const evaluatePartition = records => Object.fromEntries(
      ["static", "motion"].map(kind => {
        const matchingRecords = records.filter(record => record.kind === kind);
        if (!matchingRecords.length) return [kind, null];
        const metrics = evaluateModels(matchingRecords, models, (record, model) => {
          state.filterConfig = normalizeFilterConfig({ ...DEFAULT_FILTER_CONFIG, ...model });
          recognition.prepareFilteredReferences(state.filterConfig);
          const start = performance.now();
          const frames = recognition.filterFrames(record.rawFrames, state.filterConfig);
          if (kind === "static"){
            const replay = replayStaticConfirmation(frames, frame => {
              const descriptor = extractHolisticFeatures(
                frame, aspectRatio, record.components);
              return descriptor
                ? recognition.classifyStaticDescriptor(
                  descriptor, record.components, "filtered")
                : null;
            }, STATIC_CONFIRMATION_FRAMES);
            return { prediction: replay.prediction, latencyMs: replay.latencyMs };
          }
          const prediction = recognition.classifyFrame(
            { filteredFrames: frames }, "filtered", "motion");
          return { prediction, latencyMs: performance.now() - start };
        });
        return [kind, metrics];
      })
    );
    const limitations = [];
    if (!split.sessionSeparationChecked){
      limitations.push("No se pudo verificar la independencia por sesión: faltan participantId o sessionId en al menos una muestra.");
    }
    if (!participantSplit){
      limitations.push("No se exigió una partición por participante; resultados no garantizan generalización a participantes nuevos.");
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 2,
      aspectRatio,
      partitionCounts: {
        training: references.length,
        validation: validation.length,
        test: evaluation.length
      },
      thresholds: { staticTolerance, motionTolerance, ambiguity: state.ambiguityConfig },
      split,
      validation: {
        classes: [...new Set(validation.map(sample => sample.truth))].sort(),
        metricsByKind: evaluatePartition(validation)
      },
      test: {
        classes: [...new Set(evaluation.map(sample => sample.truth))].sort(),
        metricsByKind: evaluatePartition(evaluation)
      },
      latencyDefinitionByKind: {
        static: "Tiempo desde el primer cuadro de la captura hasta 15 predicciones estáticas consecutivas; no incluye inferencia MediaPipe ni garantiza que el primer cuadro coincida con el inicio real del gesto.",
        motion: "Tiempo local de filtrado y clasificación del clip completo; no representa la latencia de decisión de la ventana deslizante en vivo."
      },
      limitations
    }, null, 2)}\n`);
  } catch (error){
    console.error(`No se pudo completar la evaluación: ${error.message}`);
    process.exitCode = 1;
  }
}

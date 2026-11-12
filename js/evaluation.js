function predictionOf(value){
  if (typeof value === "string") return { label: value, reason: null };
  if (!value || typeof value !== "object") return { label: null, reason: null };
  return {
    label: typeof value.label === "string" && value.label.trim() ? value.label : null,
    reason: value.reason === "ambiguous" ? "ambiguous" : null
  };
}

export function assertIndependentEvaluationSet(training, evaluation, options = {}){
  return checkIndependentSplits(
    [{ name: "entrenamiento", samples: training },
      { name: "evaluación", samples: evaluation }],
    options,
    { allowEmptyTraining: true }
  );
}

function checkIndependentSplits(splits, options = {}, { allowEmptyTraining = false } = {}){
  if (!Array.isArray(splits) || splits.length < 2 ||
      splits.some(({ samples }) => !Array.isArray(samples))){
    throw new TypeError("Los conjuntos deben proporcionarse como arreglos de muestras.");
  }
  const training = splits[0].samples;
  const evaluationSplits = splits.slice(1);
  if ((!allowEmptyTraining && !training.length) ||
      evaluationSplits.some(({ samples }) => !samples.length)){
    throw new TypeError("Entrenamiento, validación y prueba deben contener muestras.");
  }

  const captureOwners = new Map();
  const participantOwners = new Map();
  const sessionOwners = new Map();
  const allSamples = splits.flatMap(({ name, samples }) =>
    samples.map(sample => ({ name, sample })));
  const completeSessions = allSamples.length > 0 && allSamples.every(({ sample }) =>
    typeof sample?.participantId === "string" && sample.participantId.trim() &&
    typeof sample?.sessionId === "string" && sample.sessionId.trim());
  const completeParticipants = allSamples.length > 0 && allSamples.every(({ sample }) =>
    typeof sample?.participantId === "string" && sample.participantId.trim());

  if (options.separateSessions && !completeSessions){
    throw new TypeError("La separación por sesión requiere participantId y sessionId seudónimos en todos los conjuntos.");
  }
  if (options.separateParticipants && !completeParticipants){
    throw new TypeError("La separación por participante requiere participantId seudónimos en todos los conjuntos.");
  }

  for (const { name, samples } of splits){
    const capturesInSplit = new Set();
    for (const sample of samples){
      if (!sample || typeof sample.captureId !== "string" ||
          !sample.captureId.trim() || sample.captureId.length > 128){
        throw new TypeError(`Cada muestra de ${name} debe incluir captureId de 1 a 128 caracteres.`);
      }
      if (name !== "entrenamiento" &&
          (typeof sample.truth !== "string" || !sample.truth.trim())){
        throw new TypeError(`Cada muestra de ${name} debe incluir una etiqueta truth no vacía.`);
      }
      if (capturesInSplit.has(sample.captureId)){
        throw new Error(`La captura ${sample.captureId} está duplicada en ${name}.`);
      }
      capturesInSplit.add(sample.captureId);
      const previousCaptureOwner = captureOwners.get(sample.captureId);
      if (previousCaptureOwner){
        throw new Error(`La captura ${sample.captureId} aparece en ${previousCaptureOwner} y ${name}.`);
      }
      captureOwners.set(sample.captureId, name);

      for (const field of ["participantId", "sessionId"]){
        if (sample[field] !== undefined &&
            (typeof sample[field] !== "string" || !sample[field].trim())){
          throw new TypeError(`${field} debe ser un identificador seudónimo no vacío.`);
        }
      }
      if (sample.participantId){
        const previousParticipantSplit = participantOwners.get(sample.participantId);
        if (options.separateParticipants && previousParticipantSplit &&
            previousParticipantSplit !== name){
          throw new Error(`El participante ${sample.participantId} aparece en ${previousParticipantSplit} y ${name}.`);
        }
        participantOwners.set(sample.participantId, name);
      }
      if (sample.participantId && sample.sessionId){
        const sessionKey = JSON.stringify([sample.participantId, sample.sessionId]);
        const previousSessionSplit = sessionOwners.get(sessionKey);
        if (previousSessionSplit && previousSessionSplit !== name){
          throw new Error(`La sesión ${sample.sessionId} del participante ${sample.participantId} aparece en ${previousSessionSplit} y ${name}.`);
        }
        sessionOwners.set(sessionKey, name);
      }
    }
  }

  return {
    captureIdsDisjoint: true,
    sessionSeparationChecked: completeSessions,
    participantSeparationChecked: Boolean(options.separateParticipants)
  };
}

export function assertIndependentEvaluationSets(training, validation, test, options = {}){
  return checkIndependentSplits([
    { name: "entrenamiento", samples: training },
    { name: "validación", samples: validation },
    { name: "prueba", samples: test }
  ], options);
}

export function replayStaticConfirmation(frames, classify, confirmationFrames = 15){
  if (!Array.isArray(frames) || !frames.length || typeof classify !== "function"){
    throw new TypeError("El replay estático requiere cuadros y una función clasificadora.");
  }
  if (!Number.isInteger(confirmationFrames) || confirmationFrames < 1){
    throw new RangeError("confirmationFrames debe ser un entero positivo.");
  }
  const startTime = frames[0]?.time;
  if (!Number.isFinite(startTime) || frames.some((frame, index) =>
    !Number.isFinite(frame?.time) || index > 0 && frame.time <= frames[index - 1].time)){
    throw new TypeError("Los cuadros del replay requieren tiempos finitos y estrictamente crecientes.");
  }

  let candidate = null, candidateCount = 0, ambiguousPrediction = null;
  for (const frame of frames){
    const result = classify(frame);
    const prediction = predictionOf(result);
    if (prediction.reason === "ambiguous"){
      candidate = null;
      candidateCount = 0;
      ambiguousPrediction = result;
      continue;
    }
    const label = prediction.label;
    if (label !== candidate){
      candidate = label;
      candidateCount = 0;
    }
    candidateCount++;
    if (label && candidateCount === confirmationFrames){
      return {
        prediction: result,
        latencyMs: frame.time - startTime,
        confirmed: true,
        ambiguousObserved: Boolean(ambiguousPrediction)
      };
    }
  }
  return {
    prediction: ambiguousPrediction,
    latencyMs: null,
    confirmed: false,
    ambiguousObserved: Boolean(ambiguousPrediction)
  };
}

export function calculateClassificationMetrics(records){
  if (!Array.isArray(records) || !records.length){
    throw new TypeError("Se requieren predicciones etiquetadas para calcular métricas.");
  }
  const normalized = records.map(record => {
    if (!record || typeof record.truth !== "string" || !record.truth.trim()){
      throw new TypeError("Cada resultado debe incluir una etiqueta truth no vacía.");
    }
    const prediction = predictionOf(record.prediction);
    if (record.latencyMs !== undefined && record.latencyMs !== null &&
        (!Number.isFinite(record.latencyMs) || record.latencyMs < 0)){
      throw new TypeError("La latencia debe ser un valor finito no negativo.");
    }
    return { truth: record.truth, ...prediction, latencyMs: record.latencyMs };
  });
  const labels = [...new Set(normalized.map(record => record.truth))].sort();
  const predictedLabels = normalized.map(record => record.label).filter(Boolean);
  const reject = "(rechazo)";
  const ambiguous = "(ambiguo)";
  const columns = [...new Set([...labels, ...predictedLabels, reject, ambiguous])];
  const confusion = Object.fromEntries(labels.map(label => [
    label, Object.fromEntries(columns.map(column => [column, 0]))
  ]));
  let correct = 0, falsePositives = 0, falseRejects = 0, ambiguousCount = 0;
  for (const record of normalized){
    const outcome = record.reason === "ambiguous" ? ambiguous : record.label || reject;
    confusion[record.truth][outcome] += 1;
    if (record.label === record.truth && record.reason !== "ambiguous") correct++;
    else if (record.reason === "ambiguous") ambiguousCount++;
    else if (!record.label) falseRejects++;
    else falsePositives++;
  }
  const perClass = Object.fromEntries(labels.map(label => {
    const truePositive = confusion[label][label];
    const support = normalized.filter(record => record.truth === label).length;
    const predicted = normalized.filter(record =>
      record.label === label && record.reason !== "ambiguous").length;
    const precision = predicted ? truePositive / predicted : 0;
    const recall = support ? truePositive / support : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return [label, { precision, recall, f1, support }];
  }));
  const latencies = normalized.map(record => record.latencyMs).filter(Number.isFinite);
  return {
    count: normalized.length,
    accuracy: correct / normalized.length,
    macroF1: Object.values(perClass).reduce((sum, item) => sum + item.f1, 0) / labels.length,
    perClass,
    confusionMatrix: { labels: columns, counts: confusion },
    falsePositives,
    falseRejects,
    ambiguousCount,
    ambiguousRate: ambiguousCount / normalized.length,
    meanLatencyMs: latencies.length
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    latencySampleCount: latencies.length
  };
}

export function evaluateModels(records, models, classify){
  if (!Array.isArray(models) || !models.length || typeof classify !== "function"){
    throw new TypeError("Se requieren modelos y una función clasificadora.");
  }
  assertIndependentEvaluationSet([], records);
  const results = {};
  const modelIds = new Set();
  for (const model of models){
    if (!model || typeof model.id !== "string" || !model.id.trim()){
      throw new TypeError("Cada modelo debe tener un identificador.");
    }
    if (modelIds.has(model.id)) throw new Error(`El modelo ${model.id} está duplicado.`);
    modelIds.add(model.id);
    const predictions = records.map(record => {
      const result = classify(record, model);
      const prediction = result && typeof result === "object" && "prediction" in result
        ? result.prediction : result;
      return {
        truth: record.truth,
        prediction,
        latencyMs: result?.latencyMs
      };
    });
    results[model.id] = calculateClassificationMetrics(predictions);
  }
  return results;
}

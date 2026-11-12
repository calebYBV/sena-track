function predictionOf(value){
  if (typeof value === "string") return { label: value, reason: null };
  if (!value || typeof value !== "object") return { label: null, reason: null };
  return {
    label: typeof value.label === "string" && value.label.trim() ? value.label : null,
    reason: value.reason === "ambiguous" ? "ambiguous" : null
  };
}

export function assertIndependentEvaluationSet(training, evaluation, options = {}){
  if (!Array.isArray(training) || !Array.isArray(evaluation) || !evaluation.length){
    throw new TypeError("El conjunto de evaluación debe contener muestras etiquetadas.");
  }
  const trainingCaptures = new Set();
  for (const sample of training){
    if (!sample || typeof sample.captureId !== "string" || !sample.captureId){
      throw new TypeError("Cada muestra de entrenamiento debe incluir captureId para comprobar independencia.");
    }
    if (trainingCaptures.has(sample.captureId)){
      throw new Error(`La captura ${sample.captureId} está duplicada en entrenamiento.`);
    }
    trainingCaptures.add(sample.captureId);
  }
  const evaluationCaptures = new Set();
  const trainingSessions = new Set(training
    .filter(sample => sample.participantId && sample.sessionId)
    .map(sample => `${sample.participantId}:${sample.sessionId}`));
  const trainingParticipants = new Set(training.map(sample => sample.participantId).filter(Boolean));
  if (options.separateParticipants &&
      [...training, ...evaluation].some(sample => !sample?.participantId)){
    throw new TypeError("La separación por participante requiere participantId en todos los registros.");
  }
  for (const sample of evaluation){
    if (!sample || typeof sample.captureId !== "string" || !sample.captureId ||
        typeof sample.truth !== "string" || !sample.truth.trim()){
      throw new TypeError("Cada muestra de evaluación debe incluir captureId y etiqueta truth.");
    }
    if (evaluationCaptures.has(sample.captureId) || trainingCaptures.has(sample.captureId)){
      throw new Error(`La captura ${sample.captureId} aparece en entrenamiento y evaluación, o está duplicada.`);
    }
    evaluationCaptures.add(sample.captureId);
    if (sample.participantId && sample.sessionId){
      const sessionKey = `${sample.participantId}:${sample.sessionId}`;
      if (trainingSessions.has(sessionKey)){
        throw new Error(`La sesión ${sessionKey} no es independiente entre entrenamiento y evaluación.`);
      }
    }
    if (options.separateParticipants && trainingParticipants.has(sample.participantId)){
      throw new Error(`El participante ${sample.participantId} aparece en entrenamiento y evaluación.`);
    }
  }
  return {
    captureIdsDisjoint: true,
    sessionSeparationChecked: training.length > 0 &&
      [...training, ...evaluation].every(sample => sample.participantId && sample.sessionId),
    participantSeparationChecked: Boolean(options.separateParticipants)
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
    if (record.latencyMs !== undefined &&
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertIndependentEvaluationSet,
  calculateClassificationMetrics,
  evaluateModels
} from "../js/evaluation.js";

test("classification metrics report per-class performance, rejects, ambiguity, and latency", () => {
  const result = calculateClassificationMetrics([
    { truth: "A", prediction: { label: "A" }, latencyMs: 10 },
    { truth: "A", prediction: { label: "B" }, latencyMs: 20 },
    { truth: "B", prediction: { label: null, reason: "ambiguous" } },
    { truth: "B", prediction: null }
  ]);
  assert.equal(result.accuracy, 0.25);
  assert.equal(result.perClass.A.precision, 1);
  assert.equal(result.perClass.A.recall, 0.5);
  assert.equal(result.perClass.B.precision, 0);
  assert.equal(result.perClass.B.recall, 0);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falseRejects, 1);
  assert.equal(result.ambiguousRate, 0.25);
  assert.equal(result.meanLatencyMs, 15);
  assert.equal(result.confusionMatrix.counts.B["(ambiguo)"], 1);
});

test("evaluation rejects overlapping capture ids and participant sessions", () => {
  const training = [{ captureId: "train-1", participantId: "P1", sessionId: "S1" }];
  const evaluation = [{ captureId: "test-1", truth: "A", participantId: "P1", sessionId: "S1" }];
  assert.throws(() => assertIndependentEvaluationSet(training, evaluation), /sesión/);
  assert.throws(() => assertIndependentEvaluationSet(
    training,
    [{ ...evaluation[0], captureId: "train-1", sessionId: "S2" }]
  ), /captura/);
  assert.throws(() => assertIndependentEvaluationSet(training, [
    { ...evaluation[0], sessionId: "S2" }
  ], { separateParticipants: true }), /participante/);
});

test("model evaluation uses the same held-out records and returns per-model metrics", () => {
  const records = [
    { captureId: "A-1", truth: "A" },
    { captureId: "B-1", truth: "B" }
  ];
  const result = evaluateModels(records, [{ id: "off" }, { id: "first" }], (record, model) => ({
    prediction: { label: model.id === "off" ? record.truth : "A" },
    latencyMs: model.id === "off" ? 1 : 2
  }));
  assert.equal(result.off.accuracy, 1);
  assert.equal(result.first.accuracy, 0.5);
  assert.equal(result.first.count, records.length);
  assert.equal(result.first.meanLatencyMs, 2);
});

test("metrics explicitly reject empty or malformed evaluation data", () => {
  assert.throws(() => calculateClassificationMetrics([]), /Se requieren/);
  assert.throws(() => calculateClassificationMetrics([{ truth: "" }]), /truth/);
  assert.equal(calculateClassificationMetrics([
    { truth: "A", prediction: null }
  ]).meanLatencyMs, null);
});

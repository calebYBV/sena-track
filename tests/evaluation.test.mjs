import test from "node:test";
import assert from "node:assert/strict";
import {
  assertIndependentEvaluationSets,
  assertIndependentEvaluationSet,
  calculateClassificationMetrics,
  evaluateModels,
  replayStaticConfirmation
} from "../js/evaluation.js";
import { validateEvaluationCapture } from "../js/sampleFormat.js";

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

test("three-way splits reject shared captures and sessions and require pseudonymous IDs in strict modes", () => {
  const training = [{ captureId: "train", participantId: "P1", sessionId: "S1" }];
  const validation = [{ captureId: "validation", truth: "A", participantId: "P2", sessionId: "S2" }];
  const test = [{ captureId: "test", truth: "A", participantId: "P3", sessionId: "S3" }];
  const result = assertIndependentEvaluationSets(training, validation, test);
  assert.equal(result.captureIdsDisjoint, true);
  assert.equal(result.sessionSeparationChecked, true);

  assert.throws(() => assertIndependentEvaluationSets(
    training,
    validation,
    [{ ...test[0], participantId: "P2", sessionId: "S2" }]
  ), /sesión/);
  assert.throws(() => assertIndependentEvaluationSets(
    training,
    validation,
    [{ ...test[0], captureId: "validation" }]
  ), /captura/);
  assert.throws(() => assertIndependentEvaluationSets(
    training,
    [{ captureId: "validation", truth: "A" }],
    test,
    { separateSessions: true }
  ), /participantId y sessionId/);
  assert.throws(() => assertIndependentEvaluationSets(
    training,
    [{ captureId: "validation", truth: "A", participantId: "P1", sessionId: "S2" }],
    test,
    { separateParticipants: true }
  ), /participante P1/);
});

test("evaluation captures reject missing, mistyped, or unknown kind values", () => {
  const sample = {
    captureId: "heldout-1",
    truth: "A",
    kind: "static",
    source: "paired-raw-and-filtered-v2",
    components: { left: true, right: false, face: false },
    rawFrames: Array.from({ length: 8 }, (_, index) => ({
      time: index * 20,
      presence: { Left: true, Right: false, face: false, faceFeatures: false },
      hands: { Left: Array.from({ length: 21 }, (_, pointIndex) =>
        [0.1 + pointIndex * 0.002, 0.2 + pointIndex * 0.003, 0]) }
    }))
  };
  assert.doesNotThrow(() => validateEvaluationCapture(sample));
  for (const kind of [undefined, null, 1, "other"]){
    const invalid = { ...sample, kind };
    if (kind === undefined) delete invalid.kind;
    assert.throws(() => validateEvaluationCapture(invalid), /kind debe ser exactamente/);
  }
  assert.throws(() => validateEvaluationCapture({
    ...sample, participantId: 7
  }), /participantId debe ser/);
});

test("static replay requires the live confirmation count and resets on ambiguity", () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({
    time: index * 20, index
  }));
  const replay = replayStaticConfirmation(frames, frame =>
    frame.index === 10 ? { label: null, reason: "ambiguous" } : { label: "A" }, 15);
  assert.equal(replay.confirmed, true);
  assert.equal(replay.prediction.label, "A");
  assert.equal(replay.latencyMs, 500);
  assert.equal(replay.ambiguousObserved, true);
  assert.equal(replayStaticConfirmation(
    frames.slice(0, 14), () => ({ label: "A" }), 15
  ).confirmed, false);
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
  const unconfirmed = calculateClassificationMetrics([
    { truth: "A", prediction: null, latencyMs: null }
  ]);
  assert.equal(unconfirmed.falseRejects, 1);
  assert.equal(unconfirmed.meanLatencyMs, null);
  assert.equal(unconfirmed.latencySampleCount, 0);
});

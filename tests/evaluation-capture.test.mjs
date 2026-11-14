import test from "node:test";
import assert from "node:assert/strict";
import { createEvaluationCapture, buildEvaluationSample } from "../js/evaluationCapture.js";
import { createRecognition } from "../js/recognition.js";
import { DEFAULT_FILTER_CONFIG } from "../js/filters.js";
import { validateEvaluationCapture, validateSample } from "../js/sampleFormat.js";

function storedFrames(count = 40){
  return Array.from({ length: count }, (_, index) => ({
    time: index * 50,
    presence: { Left: true, Right: false, face: false, faceFeatures: false },
    hands: {
      Left: Array.from({ length: 21 }, (_, pointIndex) =>
        [0.4 + pointIndex * 0.002, 0.5 - pointIndex * 0.003, 0])
    }
  }));
}

function recognition(){
  return createRecognition({
    state: { samples: [], motions: [] },
    dom: {
      $: () => ({ value: "0.8" }),
      video: { videoWidth: 640, videoHeight: 480 }
    }
  });
}

test("labeled captures create compatible raw and EDO references without storing video", () => {
  const required = { left: true, right: false, face: false };
  const sample = buildEvaluationSample({
    rawFrames: storedFrames(),
    components: required,
    truth: "A",
    kind: "static",
    captureId: "capture-1",
    participantId: "P01",
    sessionId: "S01"
  }, recognition(), { ...DEFAULT_FILTER_CONFIG, model: "second" }, 4 / 3);

  assert.equal(sample.truth, "A");
  assert.equal(sample.captureId, "capture-1");
  assert.equal(sample.rawFrames.length, sample.filteredFrames.length);
  assert.deepEqual(sample.rawFrames[0].hands.Left[0], [0.4, 0.5, 0]);
  assert.ok(sample.h.hands.Left.length === 63);
  assert.ok(sample.rh.hands.Left.length === 63);
  assert.equal("video" in sample, false);
  assert.doesNotThrow(() => validateSample(sample, "static"));
  assert.doesNotThrow(() => validateEvaluationCapture(sample));
});

test("labeled facial captures preserve head and expression features in the same schema", () => {
  const rawFrames = Array.from({ length: 40 }, (_, index) => ({
    time: index * 50,
    presence: { Left: false, Right: false, face: true, faceFeatures: true },
    hands: {},
    faceLandmarks: Array.from({ length: 468 }, (_, pointIndex) => [
      0.5 + (pointIndex === 33 ? -0.08 : pointIndex === 263 ? 0.08 : 0),
      0.4 + pointIndex * 0.0001,
      0
    ]),
    faceFeatures: Array.from({ length: 32 }, (_, featureIndex) =>
      featureIndex === 29 ? 0.1 : 0.2)
  }));
  const sample = buildEvaluationSample({
    rawFrames,
    components: { left: false, right: false, face: true },
    truth: "Sorpresa",
    kind: "static",
    captureId: "face-1"
  }, recognition(), { ...DEFAULT_FILTER_CONFIG }, 4 / 3);

  assert.equal(sample.h.face.length, 32);
  assert.equal(sample.filteredFrames[0].faceLandmarks.length, 468);
  assert.doesNotThrow(() => validateEvaluationCapture(sample));
});

test("labeled moving captures keep paired raw and EDO trajectories", () => {
  const rawFrames = Array.from({ length: 40 }, (_, index) => {
    const wrist = index < 20 ? 0.4 + index * 0.005 : 0.5;
    return {
      time: index * 50,
      presence: { Left: true, Right: false, face: false, faceFeatures: false },
      hands: {
        Left: Array.from({ length: 21 }, (_, pointIndex) =>
          [wrist + pointIndex * 0.002, 0.5 - pointIndex * 0.003, 0])
      }
    };
  });
  const sample = buildEvaluationSample({
    rawFrames,
    components: { left: true, right: false, face: false },
    truth: "Mover",
    kind: "motion",
    captureId: "motion-1"
  }, recognition(), { ...DEFAULT_FILTER_CONFIG }, 4 / 3);

  assert.equal(sample.rawHolisticSequence.length, 24);
  assert.equal(sample.filteredHolisticSequence.length, 24);
  assert.doesNotThrow(() => validateSample(sample, "motion"));
});

test("the recorder stores a labeled capture only after the requested duration on valid frames", () => {
  const elements = new Map([
    ["evalTruth", { value: "A" }],
    ["requireLeft", { checked: true }],
    ["requireRight", { checked: false }],
    ["requireFace", { checked: false }],
    ["evalParticipant", { value: "P01" }],
    ["evalSession", { value: "S02" }],
    ["evalKind", { value: "static" }],
    ["evalSplit", { value: "validation" }],
    ["evalDuration", { value: "500" }]
  ]);
  for (const id of ["evalCaptureStart", "evalCaptureCancel", "evalExport", "evalClear"]){
    elements.set(id, { addEventListener(_type, callback){ this.callback = callback; } });
  }
  const messages = [];
  const callbacks = [];
  const recorder = createEvaluationCapture({
    state: { ready: true, filterConfig: { ...DEFAULT_FILTER_CONFIG } },
    dom: {
      $: id => elements.get(id),
      video: { videoWidth: 640, videoHeight: 480 }
    },
    recognition: recognition(),
    onUpdate: update => { messages.push(update.message); callbacks.push(update); }
  });

  elements.get("evalCaptureStart").callback();
  const frame = {
    hands: { Left: Array.from({ length: 21 }, (_, index) =>
      ({ x: 0.4 + index * 0.002, y: 0.5 - index * 0.003, z: 0 })) }
  };
  const presence = { Left: true, Right: false, face: false, faceFeatures: false };
  for (let timestamp = 0; timestamp <= 500; timestamp += 25){
    recorder.captureFrame(frame, presence, timestamp);
  }
  assert.ok(callbacks.some(update => update.counts.validation === 1));
  assert.match(messages.at(-1), /guardada en validation/);
  assert.equal(recorder.isRecording(), false);
  elements.get("evalCaptureStart").callback();
  recorder.captureFrame(frame, presence, 1_000);
  recorder.captureFrame(frame, presence, 1_300);
  assert.equal(recorder.isRecording(), false);
  assert.equal(callbacks.at(-1).counts.validation, 1);
  assert.match(messages.at(-1), /interrupción de más de 250 ms/);
});

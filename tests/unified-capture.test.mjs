import test from "node:test";
import assert from "node:assert/strict";
import { extractHolisticFeatures } from "../js/holistic.js";
import { createRecognition } from "../js/recognition.js";
import { prepareSamplePayload } from "../js/sampleFormat.js";
import { analyzeUnifiedCapture } from "../js/unifiedCapture.js";

function hand(wristX = 0.5, fingerOpen = 1){
  return Array.from({ length: 21 }, (_, index) => {
    const finger = Math.floor((index - 1) / 4);
    const step = index === 0 ? 0 : (index % 4) * 0.025 * fingerOpen;
    return [wristX + step, 0.5 - index * 0.003, 0];
  });
}

function face(headX = 0.5, expression = 0){
  const landmarks = Array.from({ length: 468 }, (_, index) => [
    headX + (index === 33 ? -0.08 : index === 263 ? 0.08 : 0),
    0.45 + index * 0.0001,
    0
  ]);
  landmarks[1] = [headX, 0.45, 0];
  return { faceLandmarks: landmarks, faceFeatures: Array(32).fill(expression) };
}

function frames(makeFrame, count = 40){
  return Array.from({ length: count }, (_, index) => ({
    ...makeFrame(index),
    time: index * 50
  }));
}

function storedFrames(sourceFrames){
  return sourceFrames.map(frame => ({
    time: frame.time,
    presence: {
      Left: Boolean(frame.hands.Left),
      Right: Boolean(frame.hands.Right),
      face: Boolean(frame.faceLandmarks),
      faceFeatures: Boolean(frame.faceFeatures)
    },
    hands: frame.hands,
    ...(frame.faceLandmarks ? { faceLandmarks: frame.faceLandmarks } : {}),
    ...(frame.faceFeatures ? { faceFeatures: frame.faceFeatures } : {})
  }));
}

test("unified capture classifies a stable hand posture as static", () => {
  const capture = frames(() => ({ hands: { Left: hand() } }));
  const result = analyzeUnifiedCapture(capture, { left: true, right: false, face: false }, 4 / 3);
  assert.equal(result.kind, "static");
  assert.equal(result.motionDetected, false);
  assert.equal(result.rawHolisticSequence.length, 40);
});

test("small hand tremors do not turn a held posture into a motion sign", () => {
  const capture = frames(index => ({
    hands: { Left: hand(0.5 + (index % 2 ? 0.001 : -0.001),
      index % 2 ? 1.005 : 0.995) }
  }));
  const result = analyzeUnifiedCapture(
    capture, { left: true, right: false, face: false }, 4 / 3);
  assert.equal(result.kind, "static");
  assert.equal(result.motionDetected, false);
});

test("automatically derived samples preserve the existing static and motion v2 formats", () => {
  const aspect = 4 / 3;
  const required = { left: true, right: false, face: false };
  const recognition = createRecognition({
    state: { samples: [], motions: [] },
    dom: { $: () => ({ value: "0.8" }), video: { videoWidth: 640, videoHeight: 480 } }
  });
  const makeSample = (capture, label, components = required) => {
    const rawFrames = storedFrames(capture);
    const filteredFrames = structuredClone(rawFrames);
    const analysis = analyzeUnifiedCapture(rawFrames, components, aspect);
    const common = {
      l: label, kind: analysis.kind, formatVersion: 2, components,
      source: "paired-raw-and-filtered-v2", rawFrames, filteredFrames
    };
    if (analysis.kind === "static"){
      const descriptors = rawFrames.map(frame =>
        extractHolisticFeatures(frame, aspect, components));
      const descriptor = recognition.meanDescriptors(descriptors);
      return { ...common, h: descriptor, rh: descriptor };
    }
    return {
      ...common,
      rawHolisticSequence: recognition.holisticMotionSequence(rawFrames, components, aspect),
      filteredHolisticSequence: recognition.holisticMotionSequence(filteredFrames, components, aspect)
    };
  };
  const staticCapture = frames(() => ({ hands: { Left: hand() } }));
  const movingCapture = frames(index => ({
    hands: { Left: hand(index < 20 ? 0.5 + index * 0.01 : 0.7) }
  }));
  const staticSample = prepareSamplePayload(makeSample(staticCapture, "5"), "static").payload;
  const motionSample = prepareSamplePayload(makeSample(movingCapture, "Gracias"), "motion").payload;
  const facialCapture = frames(index => ({
    hands: {},
    ...face(index < 20 ? 0.5 + index * 0.005 : 0.6,
      index < 20 ? index * 0.015 : 0.3)
  }));
  const facialSample = prepareSamplePayload(makeSample(facialCapture, "Sorpresa",
    { left: false, right: false, face: true }), "motion").payload;
  assert.equal(staticSample.l, "5");
  assert.equal(motionSample.l, "Gracias");
  assert.equal(motionSample.rawHolisticSequence.length, 24);
  assert.equal(motionSample.rawFrames.at(-1).time, movingCapture.at(-1).time);
  assert.ok(facialSample.rawHolisticSequence.some(frame => frame.trajectory?.face?.[0] > 0));
});

test("unified capture detects a completed hand trajectory and rejects an unfinished one", () => {
  const completed = frames(index => ({
    hands: { Left: hand(index < 20 ? 0.5 + index * 0.01 : 0.7) }
  }));
  const incomplete = frames(index => ({
    hands: { Left: hand(0.5 + index * 0.01) }
  }));
  const required = { left: true, right: false, face: false };
  assert.equal(analyzeUnifiedCapture(completed, required, 4 / 3).kind, "motion");
  assert.equal(analyzeUnifiedCapture(incomplete, required, 4 / 3).reason, "incomplete-motion");
});

test("unified capture detects facial-only head and expression movement", () => {
  const capture = frames(index => ({
    hands: {},
    ...face(index < 20 ? 0.5 + index * 0.005 : 0.6,
      index < 20 ? index * 0.015 : 0.3)
  }));
  const result = analyzeUnifiedCapture(capture, { left: false, right: false, face: true }, 4 / 3);
  assert.equal(result.kind, "motion");
  assert.ok(result.travel.face > 0);
  assert.ok(result.facialChange > 0);
});

test("unified capture preserves bimanual and hand-plus-face component requirements", () => {
  const bothHands = frames(() => ({ hands: { Left: hand(0.4), Right: hand(0.7) } }));
  const handAndFace = frames(() => ({ hands: { Right: hand(0.7) }, ...face() }));
  assert.equal(analyzeUnifiedCapture(bothHands,
    { left: true, right: true, face: false }, 4 / 3).kind, "static");
  assert.equal(analyzeUnifiedCapture(handAndFace,
    { left: false, right: true, face: true }, 4 / 3).kind, "static");
});

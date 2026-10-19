import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFaceFeatures,
  extractHolisticFeatures,
  FACE_BLENDSHAPES,
  holisticDistance
} from "../js/holistic.js";
import { createRecognition } from "../js/recognition.js";

function hand(offset = 0){
  return Array.from({ length: 21 }, (_, index) => ({
    x: offset + index * 0.003,
    y: 0.35 + index * 0.002,
    z: index * 0.001
  }));
}

function face(expression = 0, offset = 0){
  const landmarks = Array.from({ length: 478 }, (_, index) => ({
    x: offset + index / 1000,
    y: 0.2 + index / 2000,
    z: index / 3000
  }));
  landmarks[33] = { x: offset + 0.3, y: 0.4, z: 0 };
  landmarks[263] = { x: offset + 0.7, y: 0.4, z: 0 };
  const categories = FACE_BLENDSHAPES.map(categoryName => ({
    categoryName, score: categoryName === "jawOpen" ? expression : 0.1
  }));
  return {
    landmarks,
    categories,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  };
}

function holisticFrame({ left = hand(0.2), right, expression = 0, faceAvailable = true } = {}){
  const faceData = face(expression);
  return {
    hands: { ...(left ? { Left: left } : {}), ...(right ? { Right: right } : {}) },
    faceLandmarks: faceAvailable ? faceData.landmarks : undefined,
    faceFeatures: faceAvailable
      ? extractFaceFeatures(faceData.landmarks, faceData.categories, faceData.matrix, 4 / 3)
      : undefined
  };
}

test("facial descriptors use MediaPipe blendshape, geometry and head-pose data", () => {
  const open = face(0.8), neutral = face(0);
  const openFeatures = extractFaceFeatures(open.landmarks, open.categories, open.matrix, 4 / 3);
  const neutralFeatures = extractFaceFeatures(neutral.landmarks, neutral.categories, neutral.matrix, 4 / 3);
  assert.equal(openFeatures.length, 32);
  assert.notDeepEqual(openFeatures, neutralFeatures);
  assert.equal(extractFaceFeatures(open.landmarks, [], open.matrix, 4 / 3), null);
  assert.equal(extractFaceFeatures(open.landmarks, open.categories, null, 4 / 3), null);
});

test("face data does not affect a hand-only sign, but facial signs compare expression", () => {
  const handOnly = { left: true, right: false, face: false };
  const facial = { ...handOnly, face: true };
  const first = extractHolisticFeatures(holisticFrame({ expression: 0 }), 4 / 3, handOnly);
  const changedFace = extractHolisticFeatures(holisticFrame({ expression: 1 }), 4 / 3, handOnly);
  assert.equal(holisticDistance(first, changedFace, handOnly), 0);

  const facialFirst = extractHolisticFeatures(holisticFrame({ expression: 0 }), 4 / 3, facial);
  const facialChanged = extractHolisticFeatures(holisticFrame({ expression: 1 }), 4 / 3, facial);
  assert.ok(holisticDistance(facialFirst, facialChanged, facial) > 0);
  assert.equal(extractHolisticFeatures(holisticFrame({ faceAvailable: false }), 4 / 3, facial), null);
});

test("a bimanual descriptor includes independently identified left and right hands", () => {
  const required = { left: true, right: true, face: false };
  const baseline = extractHolisticFeatures(
    holisticFrame({ right: hand(0.65) }), 4 / 3, required);
  const changedRight = extractHolisticFeatures(
    holisticFrame({ right: hand(0.8) }), 4 / 3, required);
  assert.ok(holisticDistance(baseline, changedRight, required) > 0);
  assert.equal(extractHolisticFeatures(holisticFrame(), 4 / 3, required), null);
});

test("bimanual recognition compares both hands and their relative position", () => {
  const values = { tol: "0.8", tolM: "0.7" };
  const state = { samples: [], motions: [] };
  const recognition = createRecognition({
    state,
    dom: { $: id => ({ value: values[id] }), video: { videoWidth: 640, videoHeight: 480 } }
  });
  const required = { left: true, right: true, face: false };
  const registered = holisticFrame({ right: hand(0.65) });
  const descriptor = extractHolisticFeatures(registered, 4 / 3, required);
  state.samples.push({ l: "Bimanual", components: required, h: descriptor, rh: descriptor });
  assert.equal(recognition.classifyFrame(registered)?.label, "Bimanual");
  assert.equal(recognition.classifyFrame(holisticFrame({ right: hand(0.8) })), null);
});

test("facial-only motion distance includes head trajectory", () => {
  const required = { left: false, right: false, face: true };
  const stationary = {
    hands: {},
    face: Array(32).fill(0),
    trajectory: { face: [0, 0, 0] }
  };
  const moving = {
    ...stationary,
    trajectory: { face: [1, 0, 0] }
  };
  assert.ok(holisticDistance(stationary, moving, required) > 0);
});

test("recognition returns no label for empty or pending-only libraries", () => {
  const values = { tol: "0.8", tolM: "0.7" };
  const state = { samples: [], motions: [] };
  const recognition = createRecognition({
    state,
    dom: { $: id => ({ value: values[id] }), video: { videoWidth: 640, videoHeight: 480 } }
  });
  const frame = holisticFrame();
  assert.equal(recognition.classifyFrame(frame), null);
  const required = { left: true, right: false, face: false };
  const descriptor = extractHolisticFeatures(frame, 4 / 3, required);
  state.samples.push({ l: "Registrada", components: required, h: descriptor, rh: descriptor, syncStatus: "pending" });
  assert.equal(recognition.classifyFrame(frame), null);
  state.samples[0].syncStatus = "saved";
  assert.equal(recognition.classifyFrame(frame).label, "Registrada");
});

test("a facial expression difference can reject a registered facial sign", () => {
  const values = { tol: "0.8", tolM: "0.7" };
  const state = { samples: [], motions: [] };
  const recognition = createRecognition({
    state,
    dom: { $: id => ({ value: values[id] }), video: { videoWidth: 640, videoHeight: 480 } }
  });
  const required = { left: false, right: false, face: true };
  const registered = holisticFrame({ expression: 0 });
  state.samples.push({
    l: "Expresión registrada",
    components: required,
    h: extractHolisticFeatures(registered, 4 / 3, required),
    rh: extractHolisticFeatures(registered, 4 / 3, required),
    syncStatus: "saved"
  });
  assert.equal(recognition.classifyFrame(registered)?.label, "Expresión registrada");
  assert.equal(recognition.classifyFrame(holisticFrame({ expression: 1 })), null);
});

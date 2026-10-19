import test from "node:test";
import assert from "node:assert/strict";
import { createRecognition, calculateDistanceReduction } from "../js/recognition.js";
import { extractHolisticFeatures } from "../js/holistic.js";

const zero = length => Array(length).fill(0);
const sequence = value => Array.from({ length: 24 }, () => Array(65).fill(value));

function makeRecognition(state, values = { tol: "1.5", tolM: "2" }){
  return createRecognition({
    state,
    dom: { $: id => ({ value: values[id] }), video: { videoWidth: 640, videoHeight: 480 } }
  });
}

test("static distances are available per label before recognition thresholds", () => {
  const state = { samples: [
    { l: "A", f: zero(63), r: zero(63).map(() => 0.5) },
    { l: "B", f: zero(63).map(() => 1), r: zero(63).map(() => 0.25) },
    { l: "Anterior", f: zero(63).map(() => 0.2) }
  ], motions: [] };
  const recognition = makeRecognition(state);
  const distances = recognition.staticDistances(zero(63), "filtered");
  assert.equal(distances.A, 0);
  assert.equal(distances.B, Math.sqrt(63));
  assert.equal(recognition.staticDistances(zero(63), "raw").A, Math.sqrt(63) * 0.5);
  assert.equal(recognition.staticDistances(zero(63), "raw").Anterior,
    recognition.staticDistances(zero(63), "filtered").Anterior);
  assert.equal(recognition.classify(zero(63), "filtered").label, "A");
});

test("static frame comparison reuses per-branch results and returns saved-example distances", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state);
  const rawLandmarks = Array.from({ length: 21 }, (_, index) => ({
    x: 0.2 + index * 0.002,
    y: 0.3 + index * 0.003,
    z: index * 0.001
  }));
  const filteredLandmarks = rawLandmarks.map(point => ({ ...point, x: point.x + 0.01 }));
  const rawFrame = { hands: { Left: rawLandmarks } };
  const filteredFrame = { hands: { Left: filteredLandmarks } };
  state.samples.push({
    l: "A",
    r: recognition.features(rawLandmarks, "Left"),
    f: recognition.features(filteredLandmarks, "Left")
  });

  const comparison = recognition.compareStaticFrames(rawFrame, filteredFrame);
  assert.equal(comparison.rawPrediction.label, "A");
  assert.equal(comparison.filteredPrediction.label, "A");
  assert.equal(comparison.rawDistances.A, 0);
  assert.equal(comparison.filteredDistances.A, 0);
  assert.deepEqual(comparison.rawPrediction, recognition.classifyFrame(rawFrame, "raw"));
  assert.deepEqual(comparison.filteredPrediction, recognition.classifyFrame(filteredFrame, "filtered"));
  assert.deepEqual(comparison.rawDistances, recognition.holisticDistances(rawFrame, "raw"));
  assert.deepEqual(comparison.filteredDistances, recognition.holisticDistances(filteredFrame, "filtered"));
});

test("static comparison uses one common saved example for both branches", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state);
  const makeHand = offset => Array.from({ length: 21 }, (_, index) => ({
    x: index * 0.002 + (index > 9 ? offset * Math.sin(index * 7) * 0.03 : 0),
    y: 0.3 + index * 0.003 + (index > 9 ? offset * Math.cos(index * 3) * 0.03 : 0),
    z: index * 0.001
  }));
  const first = makeHand(0.1), second = makeHand(0.5);
  const rawFrame = { hands: { Left: first } };
  const filteredFrame = { hands: { Left: second } };
  const firstFeatures = recognition.features(first, "Left");
  const secondFeatures = recognition.features(second, "Left");
  state.samples.push(
    { l: "A", r: firstFeatures, f: firstFeatures },
    { l: "A", r: secondFeatures, f: secondFeatures }
  );

  const comparison = recognition.compareStaticFrames(rawFrame, filteredFrame);
  assert.ok(Number.isFinite(comparison.rawDistances.A));
  assert.ok(Number.isFinite(comparison.filteredDistances.A));
  assert.ok(comparison.rawDistances.A > 0 || comparison.filteredDistances.A > 0);
});

test("holistic static comparison pairs raw and filtered distances by capture", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state);
  const components = { left: true, right: false, face: false };
  const makeHand = offset => Array.from({ length: 21 }, (_, index) => ({
    x: index * 0.002 + (index > 9 ? offset * Math.sin(index * 7) * 0.03 : 0),
    y: 0.3 + index * 0.003 + (index > 9 ? offset * Math.cos(index * 3) * 0.03 : 0),
    z: index * 0.001
  }));
  const first = { hands: { Left: makeHand(0.2) } };
  const second = { hands: { Left: makeHand(0.8) } };
  const descriptor = frame => extractHolisticFeatures(frame, 4 / 3, components);
  state.samples.push(
    { l: "A", components, rh: descriptor(first), h: descriptor(first) },
    { l: "A", components, rh: descriptor(second), h: descriptor(second) }
  );

  const comparison = recognition.compareStaticFrames(first, second);
  assert.ok(comparison.rawDistances.A > 0 || comparison.filteredDistances.A > 0);
});

test("motion comparison uses one common saved example for both branches", () => {
  const state = { samples: [], motions: [
    { l: "Ola", r: sequence(0), s: sequence(1) },
    { l: "Ola", r: sequence(1), s: sequence(0) }
  ] };
  const recognition = makeRecognition(state);
  const { rawDistances, filteredDistances } = recognition.pairedHolisticDistances({
    rawLegacySequence: sequence(0),
    filteredLegacySequence: sequence(0)
  }, "motion");
  assert.ok(Number.isFinite(rawDistances.Ola));
  assert.ok(Number.isFinite(filteredDistances.Ola));
  assert.ok(rawDistances.Ola > 0 || filteredDistances.Ola > 0);
});

test("holistic motion recognition uses synchronized frame times in both branches", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state);
  const components = { left: true, right: false, face: false };
  const landmarks = Array.from({ length: 21 }, (_, index) => ({
    x: index * 0.002 + (index > 9 ? Math.sin(index * 7) * 0.01 : 0),
    y: 0.3 + index * 0.003 + (index > 9 ? Math.cos(index * 3) * 0.01 : 0),
    z: index * 0.001
  }));
  const descriptor = extractHolisticFeatures({ hands: { Left: landmarks } }, 4 / 3, components);
  const frames = Array.from({ length: 12 }, (_, index) => ({
    hands: { Left: landmarks }, time: index * 33
  }));
  const sequence = Array.from({ length: 24 }, () => descriptor);
  state.motions.push({
    l: "Movimiento",
    components,
    rawHolisticSequence: sequence,
    filteredHolisticSequence: sequence
  });

  const query = {
    rawFrames: frames,
    filteredFrames: frames.map(frame => ({ ...frame, time: frame.time }))
  };
  assert.equal(recognition.classifyFrame(query, "raw", "motion").label, "Movimiento");
  assert.equal(recognition.classifyFrame(query, "filtered", "motion").label, "Movimiento");
  assert.equal(recognition.pairedHolisticDistances(query, "motion").rawDistances.Movimiento, 0);
});

test("holistic motion recognition compares wrist trajectory for a single hand", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state, { tol: "1.5", tolM: "0.1" });
  const components = { left: true, right: false, face: false };
  const makeFrames = positions => positions.map((offset, index) => ({
    time: index * 30,
    hands: {
      Left: Array.from({ length: 21 }, (_, point) => ({
        x: offset + point * 0.003,
        y: 0.35 + point * 0.002,
        z: point * 0.001
      }))
    }
  }));
  const moving = makeFrames(Array.from({ length: 12 }, (_, index) => 0.2 + index * 0.025));
  const stationary = makeFrames(Array(12).fill(0.2));
  const oldDescriptors = moving.map(frame =>
    extractHolisticFeatures(frame, 4 / 3, components));
  const reference = recognition.resampleDescriptors(oldDescriptors, 24, moving.map(frame => frame.time));
  state.motions.push({
    l: "Desplazamiento",
    components,
    rawHolisticSequence: reference,
    filteredHolisticSequence: reference,
    rawFrames: moving,
    filteredFrames: moving
  });

  assert.equal(
    recognition.classifyFrame({ rawFrames: moving, filteredFrames: moving }, "raw", "motion")?.label,
    "Desplazamiento"
  );
  assert.equal(
    recognition.classifyFrame({ rawFrames: stationary, filteredFrames: stationary }, "raw", "motion"),
    null
  );
});

test("motion recognition distinguishes opposite trajectories and rejects ambiguity", () => {
  const state = { samples: [], motions: [] };
  const recognition = makeRecognition(state, { tol: "1.5", tolM: "0.1" });
  const components = { left: true, right: false, face: false };
  const makeFrames = positions => positions.map((offset, index) => ({
    time: index * 30,
    hands: {
      Left: Array.from({ length: 21 }, (_, point) => ({
        x: offset + point * 0.003,
        y: 0.35 + point * 0.002,
        z: point * 0.001
      }))
    }
  }));
  const rightward = makeFrames(Array.from({ length: 12 }, (_, index) => 0.2 + index * 0.025));
  const leftward = makeFrames(Array.from({ length: 12 }, (_, index) => 0.475 - index * 0.025));
  const register = (label, frames) => {
    const sequence = recognition.holisticMotionSequence(frames, components, 4 / 3);
    state.motions.push({
      l: label,
      components,
      rawHolisticSequence: sequence,
      filteredHolisticSequence: sequence
    });
  };
  register("Derecha", rightward);
  register("Izquierda", leftward);

  const query = frames => ({ rawFrames: frames, filteredFrames: frames });
  assert.equal(recognition.classifyFrame(query(rightward), "raw", "motion")?.label, "Derecha");
  assert.equal(recognition.classifyFrame(query(leftward), "raw", "motion")?.label, "Izquierda");
  const distances = recognition.holisticDistances(query(rightward), "raw", "motion");
  assert.ok(distances.Derecha < distances.Izquierda);

  state.motions.push({
    l: "Ambigua",
    components,
    rawHolisticSequence: state.motions[0].rawHolisticSequence,
    filteredHolisticSequence: state.motions[0].filteredHolisticSequence
  });
  assert.equal(recognition.classifyFrame(query(rightward), "raw", "motion"), null);
});

test("motion distance uses paired references and applies one raw-defined crop to both branches", () => {
  const state = { samples: [], motions: [
    { l: "Ola", s: sequence(1), r: sequence(0) }
  ] };
  const recognition = makeRecognition(state);
  assert.equal(recognition.motionDistances(sequence(0), "raw").Ola, 0);
  assert.ok(recognition.motionDistances(sequence(0), "filtered").Ola > 0);

  const positions = [0, 0, 0, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.6, 0.6];
  const frames = positions.map(x => {
    const lm = Array.from({ length: 21 }, (_, i) => ({
      x: x + i * 0.002, y: 0.3 + i * 0.003, z: i * 0.001
    }));
    lm[0] = { x, y: 0.3, z: 0 };
    lm[9] = { x: x + 0.2, y: 0.5, z: 0 };
    return { lm, hand: "Right" };
  });
  const stationaryFiltered = frames.map(() => ({
    hand: "Right",
    lm: frames[0].lm.map(point => ({ ...point }))
  }));
  const pair = recognition.toSequencePair(frames, stationaryFiltered, 4 / 3);
  assert.ok(pair);
  assert.equal(pair.raw.length, 24);
  assert.equal(pair.filtered.length, 24);
  assert.ok(pair.filtered.every(step => Math.abs(step[63]) < 1e-9 && Math.abs(step[64]) < 1e-9));
});

test("distance reduction reports improvements, regressions, equality, and zero baselines", () => {
  assert.equal(calculateDistanceReduction(10, 7), 30);
  assert.equal(calculateDistanceReduction(10, 12), -20);
  assert.equal(calculateDistanceReduction(10, 10), 0);
  assert.equal(calculateDistanceReduction(0, 0.4), null);
  assert.equal(calculateDistanceReduction(1e-7, 0), null);
  assert.equal(calculateDistanceReduction(Number.NaN, 1), null);
});

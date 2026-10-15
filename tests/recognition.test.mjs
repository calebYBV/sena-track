import test from "node:test";
import assert from "node:assert/strict";
import { createRecognition, calculateDistanceReduction } from "../js/recognition.js";

const zero = length => Array(length).fill(0);
const sequence = value => Array.from({ length: 24 }, () => Array(65).fill(value));

function makeRecognition(state){
  const values = { tol: "1.5", tolM: "2" };
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
  assert.equal(calculateDistanceReduction(Number.NaN, 1), null);
});

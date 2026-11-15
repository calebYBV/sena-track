import test from "node:test";
import assert from "node:assert/strict";
import { globalTraceDisplacement } from "../js/globalTrace.js";

const point = (x = 0, y = 0) => ({ x, y, z: 0 });
const frame = (left, right, face) => ({
  hands: { ...(left ? { Left: left } : {}), ...(right ? { Right: right } : {}) },
  ...(face ? { faceLandmarks: face } : {})
});

test("general trace averages motion across both hands and face without face point count bias", () => {
  const previous = frame([point(), point()], [point()], [point(), point(), point()]);
  const raw = frame([point(.2), point(.2)], [point(.4)], [point(.6), point(.6), point(.6)]);
  const edo = frame([point(.1), point(.1)], [point(.2)], [point(.3), point(.3), point(.3)]);
  const result = globalTraceDisplacement(previous, previous, raw, edo);
  assert.ok(Math.abs(result.raw - .4) < 1e-12);
  assert.ok(Math.abs(result.filtered - .2) < 1e-12);
  assert.deepEqual(result.components, ["Mano izquierda", "Mano derecha", "Rostro"]);
});

test("general trace works with either hand or the face on its own", () => {
  const first = frame([point()]);
  assert.equal(globalTraceDisplacement(first, first,
    frame([point(.1)]), frame([point(.05)])).filtered, .05);
  const face = frame(null, null, [point()]);
  assert.equal(globalTraceDisplacement(face, face,
    frame(null, null, [point(.2)]), frame(null, null, [point(.1)])).raw, .2);
});

test("general trace compensates x with the video aspect ratio", () => {
  const previous = frame([point()]);
  const next = frame([point(.1)]);
  assert.equal(globalTraceDisplacement(previous, previous, next, next, 2).raw, .2);
});

test("general trace inserts a gap when a tracked component appears or disappears", () => {
  const one = frame([point()]);
  const two = frame([point()], [point()]);
  assert.equal(globalTraceDisplacement(one, one, two, two), null);
  assert.equal(globalTraceDisplacement(two, two, one, one), null);
});

test("general trace requires paired valid coordinates and previous frames", () => {
  const previous = frame([point()]);
  const next = frame([point(.1)]);
  assert.equal(globalTraceDisplacement(null, previous, next, next), null);
  assert.equal(globalTraceDisplacement(previous, previous,
    frame([point(.1), point(.2)]), next), null);
  assert.equal(globalTraceDisplacement(previous, previous,
    frame([point(NaN)]), next), null);
  assert.equal(globalTraceDisplacement(previous, previous, next, next, 0), null);
});

test("EDO can have greater displacement; graph is not an accuracy claim", () => {
  const previous = frame([point()]);
  const result = globalTraceDisplacement(previous, previous,
    frame([point(.02)]), frame([point(.08)]));
  assert.ok(result.filtered > result.raw);
});

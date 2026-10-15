import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareSamplePayload,
  SAMPLE_FORMAT_VERSION,
  SAMPLE_STORAGE_THRESHOLD_BYTES,
  validateSample
} from "../js/sampleFormat.js";

const landmarks = () => Array.from({ length: 21 }, (_, index) => [index / 20, index / 40, index / 80]);
const features = length => Array.from({ length }, (_, index) => index / length);

test("static captures preserve raw points and derived features in versioned JSON", () => {
  const sample = { l: "Hola", f: features(63), r: features(63), lm: landmarks(), source: "paired-raw-and-filtered-v1" };
  const stored = prepareSamplePayload(sample, "static");
  assert.equal(stored.payload.formatVersion, SAMPLE_FORMAT_VERSION);
  assert.equal(stored.payload.provenance.rawCoordinatesAvailable, true);
  assert.equal(stored.payload.lm.length, 21);
  assert.ok(stored.bytes < SAMPLE_STORAGE_THRESHOLD_BYTES);
});

test("motion captures require finite, ordered raw landmarks and store relative times", () => {
  const sample = {
    l: "Gracias",
    s: Array.from({ length: 24 }, () => features(65)),
    r: Array.from({ length: 24 }, () => features(65)),
    rawFrames: [1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140].map((time, index) => ({
      lm: landmarks(),
      hand: index % 2 ? "Right" : "Right",
      time
    })),
    source: "paired-raw-and-filtered-v1"
  };
  const stored = prepareSamplePayload(sample, "motion");
  assert.equal(stored.payload.rawFrames[0].time, 0);
  assert.equal(stored.payload.rawFrames.at(-1).time, 140);
  assert.equal(stored.payload.provenance.rawCoordinatesAvailable, true);
});

test("legacy motion feature sequences remain importable without invented coordinates", () => {
  const sample = {
    l: "Hola",
    s: Array.from({ length: 24 }, () => features(65)),
    source: "legacy-smoothing-v0"
  };
  const stored = prepareSamplePayload(sample, "motion");
  assert.equal(stored.payload.provenance.legacy, true);
  assert.equal(stored.payload.provenance.rawCoordinatesAvailable, false);
  assert.equal(stored.payload.provenance.processing, "legacy-smoothing-v0");
  assert.equal("rawFrames" in stored.payload, false);
  assert.throws(() => prepareSamplePayload({
    ...sample,
    source: "paired-raw-and-filtered-v1"
  }, "motion"), /coordenadas originales/);
  assert.throws(() => prepareSamplePayload({
    l: "A",
    f: features(63),
    source: "paired-raw-and-filtered-v1"
  }, "static"), /coordenadas originales/);
});

test("invalid landmark dimensions, non-finite values, and unordered times are rejected", () => {
  assert.throws(() => validateSample({ l: "A", f: [1, 2], lm: landmarks() }, "static"), /63 características/);
  const frames = Array.from({ length: 8 }, (_, index) => ({
    lm: landmarks(),
    hand: "Right",
    time: index === 4 ? 30 : index * 10
  }));
  assert.throws(() => validateSample({
    l: "Giro",
    s: Array.from({ length: 24 }, () => features(65)),
    rawFrames: frames,
    source: "paired-raw-and-filtered-v1"
  }, "motion"), /orden temporal inválido/);
});

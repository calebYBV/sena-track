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

test("holistic format preserves required components, facial data and synchronized raw/EDO frames", () => {
  const handPoints = landmarks();
  const facePoints = Array.from({ length: 478 }, (_, index) =>
    [index / 1000, index / 2000, index / 3000]);
  const components = { left: true, right: false, face: true };
  const frames = Array.from({ length: 8 }, (_, index) => ({
    time: index * 20,
    presence: { Left: true, Right: false, face: true, faceFeatures: true },
    hands: { Left: handPoints },
    faceLandmarks: facePoints,
    faceFeatures: features(32)
  }));
  const descriptor = {
    hands: { Left: features(63) },
    placement: { Left: features(3) },
    face: features(32)
  };
  const result = prepareSamplePayload({
    l: "Seña registrada",
    components,
    h: descriptor,
    rh: descriptor,
    rawFrames: frames,
    filteredFrames: structuredClone(frames),
    source: "paired-raw-and-filtered-v2"
  }, "static");
  assert.equal(result.payload.kind, "static");
  assert.equal(result.payload.formatVersion, 2);
  assert.equal(result.payload.provenance.facialCoordinatesAvailable, true);
  assert.equal(result.payload.provenance.facialFeaturesUsed, true);
  assert.equal(result.payload.rawFrames[0].time, 0);
  assert.equal(result.payload.filteredFrames.at(-1).time, 140);

  assert.throws(() => prepareSamplePayload({
    ...result.payload,
    filteredFrames: result.payload.filteredFrames.map((frame, index) =>
      index === 3 ? { ...frame, presence: { ...frame.presence, Left: false }, hands: {} } : frame)
  }, "static"), /misma presencia y tiempo/);
  assert.throws(() => prepareSamplePayload({
    ...result.payload,
    rawFrames: frames.map(frame => ({
      ...frame, presence: { ...frame.presence, face: false, faceFeatures: false },
      faceLandmarks: undefined, faceFeatures: undefined
    }))
  }, "static"), /componentes requeridos/);
});

test("available facial coordinates are retained even when expression features are unavailable", () => {
  const facePoints = Array.from({ length: 478 }, (_, index) =>
    [index / 1000, index / 2000, index / 3000]);
  const frames = Array.from({ length: 8 }, (_, index) => ({
    time: index * 20,
    presence: { Left: true, Right: false, face: true, faceFeatures: false },
    hands: { Left: landmarks() },
    faceLandmarks: facePoints
  }));
  const handDescriptor = { hands: { Left: features(63) }, placement: null, face: null };
  const sample = {
    l: "Seña de una mano",
    components: { left: true, right: false, face: false },
    h: handDescriptor,
    rh: handDescriptor,
    rawFrames: frames,
    filteredFrames: structuredClone(frames),
    source: "paired-raw-and-filtered-v2"
  };
  const result = prepareSamplePayload(sample, "static");
  assert.equal(result.payload.provenance.facialCoordinatesAvailable, true);
  assert.equal(result.payload.provenance.facialFeaturesUsed, false);
  assert.equal(result.payload.rawFrames[0].faceLandmarks.length, 478);
  assert.equal("faceFeatures" in result.payload.rawFrames[0], false);
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

test("holistic motion sequences preserve validated wrist trajectories", () => {
  const handPoints = landmarks();
  const frames = Array.from({ length: 8 }, (_, index) => ({
    time: index * 20,
    presence: { Left: true, Right: false, face: false, faceFeatures: false },
    hands: { Left: handPoints }
  }));
  const descriptor = {
    hands: { Left: features(63) },
    placement: null,
    trajectory: { Left: [0.1, 0.2, 0.3] },
    face: null
  };
  const sample = {
    l: "Desplazamiento",
    components: { left: true, right: false, face: false },
    rawFrames: frames,
    filteredFrames: structuredClone(frames),
    rawHolisticSequence: Array.from({ length: 24 }, () => descriptor),
    filteredHolisticSequence: Array.from({ length: 24 }, () => descriptor),
    source: "paired-raw-and-filtered-v2"
  };
  const stored = prepareSamplePayload(sample, "motion");
  assert.deepEqual(stored.payload.rawHolisticSequence[0].trajectory.Left, [0.1, 0.2, 0.3]);
  assert.throws(() => prepareSamplePayload({
    ...sample,
    rawHolisticSequence: sample.rawHolisticSequence.map((frame, index) =>
      index === 4 ? { ...frame, trajectory: { Left: [0.1, Number.NaN, 0.3] } } : frame)
  }, "motion"), /secuencia EDO y original/);
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

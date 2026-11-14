import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRecognition } from "../js/recognition.js";

const script = fileURLToPath(new URL("../scripts/evaluate.mjs", import.meta.url));
const recognition = createRecognition({
  state: { samples: [], motions: [] },
  dom: { $: () => ({ value: "0.8" }), video: { videoWidth: 640, videoHeight: 480 } }
});

function makeCapture(captureId, truth, kind = "static", participantId, sessionId, frameCount = 20){
  const rawFrames = Array.from({ length: frameCount }, (_, index) => ({
    time: index * 20,
    presence: { Left: true, Right: false, face: false, faceFeatures: false },
    hands: {
      Left: Array.from({ length: 21 }, (_, pointIndex) => [
        0.1 + pointIndex * 0.002,
        0.2 + pointIndex * 0.003,
        0
      ])
    }
  }));
  const capture = {
    l: truth,
    truth,
    kind,
    captureId,
    participantId,
    sessionId,
    formatVersion: 2,
    components: { left: true, right: false, face: false },
    source: "paired-raw-and-filtered-v2",
    rawFrames,
    filteredFrames: structuredClone(rawFrames),
    components: { left: true, right: false, face: false }
  };
  if (kind === "motion"){
    capture.rawHolisticSequence = recognition.holisticMotionSequence(
      rawFrames, capture.components, 4 / 3);
    capture.filteredHolisticSequence = structuredClone(capture.rawHolisticSequence);
  } else {
    capture.h = { hands: { Left: Array(63).fill(0) }, placement: null, face: null };
    capture.rh = structuredClone(capture.h);
  }
  return capture;
}

async function runCli(directory, evaluationKind, evaluationFrameCount = 20, filterCandidates){
  const fixtureKind = evaluationKind === "motion" ? "motion" : "static";
  const reference = makeCapture("train-1", "A", fixtureKind, "P1", "S1");
  const validation = makeCapture("validation-1", "A", fixtureKind, "P2", "S2");
  const evaluation = makeCapture("test-1", "A", fixtureKind, "P3", "S3", evaluationFrameCount);
  if (evaluationKind === "missing") delete evaluation.kind;
  else if (evaluationKind !== "static") evaluation.kind = evaluationKind;
  const files = [
    ["training.json", { [fixtureKind]: [reference] }],
    ["validation.json", {
      samples: [validation], staticTolerance: 0.8, motionTolerance: 0.7,
      ...(filterCandidates ? { filterCandidates } : {})
    }],
    ["test.json", { samples: [evaluation] }]
  ];
  const paths = [];
  for (const [name, content] of files){
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(content));
    paths.push(path);
  }
  return spawnSync(process.execPath, [script, ...paths], { encoding: "utf8" });
}

test("evaluation CLI rejects missing and invalid kinds without emitting metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    for (const kind of ["missing", "unknown", 7]){
      const result = await runCli(directory, kind);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /kind debe ser exactamente "static" o "motion"/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation CLI reports separate validation and test metrics for all EDO modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    const result = await runCli(directory, "static");
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.partitionCounts.training, 1);
    assert.equal(output.partitionCounts.validation, 1);
    assert.equal(output.partitionCounts.test, 1);
    for (const model of ["off", "first", "second"]){
      assert.equal(output.test.metricsByKind.static[model].count, 1);
      assert.equal(output.test.metricsByKind.static[model].accuracy, 1);
    }
    assert.equal(output.test.metricsByKindAndComponents["static:left"].off.count, 1);
    assert.equal(output.test.metricsByKind.motion, null);
    assert.equal(output.split.sessionSeparationChecked, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation CLI accepts unified-format motion captures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    const result = await runCli(directory, "motion");
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.test.metricsByKind.motion.off.count, 1);
    assert.equal(output.test.metricsByKind.motion.off.accuracy, 1);
    assert.equal(output.test.metricsByKind.static, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation CLI compares explicit EDO parameter candidates on the same held-out captures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    const candidates = [
      { id: "first-tau-0.12", model: "first", tau: 0.12 },
      { id: "second-zeta-1.1-omega-18", model: "second", zeta: 1.1, omegaN: 18 }
    ];
    const result = await runCli(directory, "static", 20, candidates);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.filterConfigurations.slice(-2), [
      { id: "first-tau-0.12", model: "first", tau: 0.12, zeta: 0.9, omegaN: 14 },
      { id: "second-zeta-1.1-omega-18", model: "second", tau: 0.06, zeta: 1.1, omegaN: 18 }
    ]);
    assert.equal(output.validation.metricsByKind.static["first-tau-0.12"].count, 1);
    assert.equal(output.test.metricsByKind.static["second-zeta-1.1-omega-18"].count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation CLI rejects invalid parameter candidates rather than substituting defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    const result = await runCli(directory, "static", 20, [
      { id: "invalid-tau", model: "first", tau: 0 }
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /tau debe estar entre/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation CLI reports unconfirmed static predictions as rejects without latency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sena-track-eval-"));
  try {
    const result = await runCli(directory, "static", 14);
    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(result.stdout).test.metricsByKind.static.off;
    assert.equal(metrics.falseRejects, 1);
    assert.equal(metrics.meanLatencyMs, null);
    assert.equal(metrics.latencySampleCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

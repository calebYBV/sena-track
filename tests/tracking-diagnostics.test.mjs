import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_FILTER_CONFIG } from "../js/filters.js";
import { createTrackingDiagnostics } from "../js/trackingDiagnostics.js";

const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.06 };
const dt = 1000 / 30;

function hand(centerX, frameIndex, noise = 0){
  return Array.from({ length: 21 }, (_, index) => {
    const phase = frameIndex * 1.71 + index * 0.83;
    const jitterX = noise * (Math.sin(phase) + 0.4 * Math.sin(phase * 0.61));
    const jitterY = noise * (Math.cos(phase * 1.13) + 0.3 * Math.sin(phase * 0.37));
    if (index === 0) return { x: centerX + jitterX, y: 0.4 + jitterY, z: 0 };
    if (index === 9) return { x: centerX + jitterX, y: 0.5 + jitterY, z: 0 };
    return {
      x: centerX + (index % 5) * 0.008 + jitterX,
      y: 0.4 + Math.floor(index / 5) * 0.012 + jitterY,
      z: 0
    };
  });
}

function face(centerX, frameIndex, noise = 0){
  return Array.from({ length: 478 }, (_, index) => {
    const phase = frameIndex * 1.31 + index * 0.73;
    const jitterX = noise * Math.sin(phase);
    const jitterY = noise * Math.cos(phase * 0.91);
    if (index === 234) return { x: centerX - 0.1 + jitterX, y: 0.4 + jitterY, z: 0 };
    if (index === 454) return { x: centerX + 0.1 + jitterX, y: 0.4 + jitterY, z: 0 };
    return {
      x: centerX + ((index % 25) - 12) * 0.006 + jitterX,
      y: 0.4 + (Math.floor(index / 25) - 9) * 0.006 + jitterY,
      z: 0
    };
  });
}

function frame({ left, right, facePoints }){
  return {
    hands: {
      ...(left ? { Left: left } : {}),
      ...(right ? { Right: right } : {})
    },
    ...(facePoints ? { faceLandmarks: facePoints } : {})
  };
}

function push(analyzer, raw, filtered, time, filterConfig = config, aspect = 4 / 3){
  return analyzer.update(raw, filtered, time, aspect, filterConfig);
}

function collectQuiet({ regions = ["left"], rawNoise = 0.00004,
  filteredNoise = rawNoise * 0.35, count = 100 } = {}){
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < count; i++){
    const raw = frame({
      ...(regions.includes("left") ? { left: hand(0.3, i, rawNoise) } : {}),
      ...(regions.includes("right") ? { right: hand(0.7, i, rawNoise) } : {}),
      ...(regions.includes("face") ? { facePoints: face(0.5, i, rawNoise) } : {})
    });
    const filtered = frame({
      ...(regions.includes("left") ? { left: hand(0.3, i, filteredNoise) } : {}),
      ...(regions.includes("right") ? { right: hand(0.7, i, filteredNoise) } : {}),
      ...(regions.includes("face") ? { facePoints: face(0.5, i, filteredNoise) } : {})
    });
    result = push(analyzer, raw, filtered, i * dt);
  }
  return { analyzer, result };
}

function trajectory(index, time = index * dt){
  return 0.5 + 0.035 * Math.sin(time / 155) + 0.018 * Math.sin(time / 61);
}

test("one quiet hand with small tracking noise yields paired vibration estimates", () => {
  const { result } = collectQuiet({ regions: ["left"] });
  assert.ok(result.displacementRaw > 0);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.equal(result.regionCount, 1);
  assert.match(result.quietReason, /ventana quieta/i);
});

test("two quiet hands are measured together with equal regional weighting", () => {
  const { result } = collectQuiet({ regions: ["left", "right"] });
  assert.equal(result.regionCount, 2);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.match(result.status, /2 regiones/);
});

test("face-only tracking uses face width as its normalization scale", () => {
  const { result } = collectQuiet({ regions: ["face"] });
  assert.equal(result.regionCount, 1);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.match(result.note, /ancho facial/);
});

test("continuous voluntary motion updates displacement and does not qualify as quiet", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 100; i++){
    const raw = frame({ left: hand(trajectory(i), i) });
    const filtered = frame({ left: hand(trajectory(i - 2), i) });
    result = push(analyzer, raw, filtered, i * dt);
  }
  assert.ok(result.displacementRaw > 0);
  assert.equal(result.vibrationRaw, null);
  assert.match(result.quietReason, /Analizando quietud/);
  assert.ok(Math.abs(result.lagMs - 2 * dt) < 1e-6);
});

test("general displacement reports known normalized 2D speeds in percent of region scale per second", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 5; i++){
    const raw = frame({ left: hand(0.3 + i * 0.0075, i) });
    const filtered = frame({ left: hand(0.3 + i * 0.00375, i) });
    result = push(analyzer, raw, filtered, i * 100);
  }
  assert.ok(Math.abs(result.displacementRaw - 100) < 1e-8);
  assert.ok(Math.abs(result.displacementFiltered - 50) < 1e-8);
});

test("alternating rest and movement clears old quiet evidence and reacquires a stable window", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 60; i++){
    const x = i < 30 ? 0.3 : trajectory(i);
    const raw = frame({ left: hand(x, i, 0.00002) });
    result = push(analyzer, raw, raw, i * dt);
  }
  assert.equal(result.vibrationRaw, null);
  for (let i = 60; i < 160; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    const filtered = frame({ left: hand(0.3, i, 0.00002) });
    result = push(analyzer, raw, filtered, i * dt);
  }
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
});

test("a tracking gap longer than the pairing limit discards the old window", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 80; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    push(analyzer, raw, raw, i * dt);
  }
  const resumed = frame({ left: hand(0.3, 100, 0.00004) });
  const result = push(analyzer, resumed, resumed, 80 * dt + 300);
  assert.equal(result.displacementRaw, null);
  assert.match(result.status, /pérdida temporal/i);
});

test("appearance and disappearance of a region creates a new paired segment", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 20; i++){
    const both = frame({ left: hand(0.3, i), right: hand(0.7, i) });
    push(analyzer, both, both, i * dt);
  }
  const one = frame({ left: hand(0.3, 20) });
  const changed = push(analyzer, one, one, 20 * dt);
  assert.equal(changed.displacementRaw, null);
  assert.match(changed.status, /cambió la región/i);
  const resumed = push(analyzer, one, one, 21 * dt);
  assert.equal(resumed.displacementRaw, null);
  const reappeared = frame({ left: hand(0.3, 22), right: hand(0.7, 22) });
  const appeared = push(analyzer, reappeared, reappeared, 22 * dt);
  assert.match(appeared.status, /cambió la región/i);
});

test("left-to-right identity changes do not connect unrelated hand trajectories", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 10; i++){
    const left = frame({ left: hand(0.3, i) });
    push(analyzer, left, left, i * dt);
  }
  const right = frame({ right: hand(0.7, 10) });
  const changed = push(analyzer, right, right, 10 * dt);
  assert.equal(changed.displacementRaw, null);
  assert.match(changed.status, /cambió la región/i);
});

test("large same-region jumps reset continuity instead of linking swapped identities", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 10; i++){
    const both = frame({ left: hand(0.3, i), right: hand(0.7, i) });
    push(analyzer, both, both, i * dt);
  }
  const swapped = frame({ left: hand(0.7, 10), right: hand(0.3, 10) });
  const result = push(analyzer, swapped, swapped, 10 * dt);
  assert.equal(result.displacementRaw, null);
  assert.match(result.status, /salto de identidad\/lateralidad/i);
});

test("uniform-time lag estimation is stable across frame rates and jittered timestamps", () => {
  for (const fps of [15, 30, 60]){
    const analyzer = createTrackingDiagnostics();
    const period = 1000 / fps;
    const count = fps * 4;
    let result;
    for (let i = 0; i < count; i++){
      const time = i * period + (i % 3) * period * 0.025;
      const rawX = trajectory(i, time);
      const filteredX = trajectory(i, time - 80);
      const raw = frame({ left: hand(rawX, i) });
      const filtered = frame({ left: hand(filteredX, i) });
      result = push(analyzer, raw, filtered, time);
    }
    assert.ok(result.lagMs >= 40 && result.lagMs <= 140,
      `${fps}fps estimated ${result.lagMs}ms`);
  }
});

test("constant-velocity motion has insufficient temporal information for lag", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 100; i++){
    const raw = frame({ left: hand(0.2 + i * 0.0003, i) });
    const filtered = frame({ left: hand(0.2 + i * 0.0003, i) });
    result = push(analyzer, raw, filtered, i * dt);
  }
  assert.equal(result.lagMs, null);
  assert.match(result.lagReason, /constante|cambios de velocidad/i);
});

test("the diagnostic reports lower observed vibration when the filtered branch is smoother", () => {
  const { result } = collectQuiet({ rawNoise: 0.00005, filteredNoise: 0.00001 });
  assert.ok(result.vibrationReduction > 0);
  assert.equal(result.vibrationAssessment, "EDO reduce la vibración");
});

test("the diagnostic reports greater observed vibration when the filtered branch is noisier", () => {
  const { result } = collectQuiet({ rawNoise: 0.00002, filteredNoise: 0.00008 });
  assert.ok(result.vibrationReduction < 0);
  assert.equal(result.vibrationAssessment, "EDO aumenta la vibración");
});

test("identical stationary branches are valid but have no calculable percent or measurable difference", () => {
  const { result } = collectQuiet({ rawNoise: 0, filteredNoise: 0 });
  assert.equal(result.vibrationRaw, 0);
  assert.equal(result.vibrationFiltered, 0);
  assert.equal(result.vibrationReduction, null);
  assert.equal(result.vibrationAssessment, "Sin diferencia medible");
});

test("changing EDO parameters resets paired history before collecting new measurements", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 100; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    push(analyzer, raw, raw, i * dt);
  }
  const changed = { ...config, tau: 0.12 };
  const sample = frame({ left: hand(0.3, 101, 0.00004) });
  const reset = push(analyzer, sample, sample, 100 * dt, changed);
  assert.equal(reset.displacementRaw, null);
  assert.equal(reset.vibrationRaw, null);
  assert.match(reset.status, /sincronizando/);
});

test("diagnostics produce measurements without any recognition-state input", () => {
  const { result } = collectQuiet({ regions: ["left"] });
  assert.ok(result.displacementRaw > 0);
  assert.ok(result.vibrationRaw > 0);
});

test("the camera updates diagnostics outside recognition and resets them on stop/sign-out", async () => {
  const camera = await readFile(new URL("../js/camera.js", import.meta.url), "utf8");
  const appAuth = await readFile(new URL("../js/appAuth.js", import.meta.url), "utf8");
  const processFrameAt = camera.indexOf("function processFrame()");
  const updateAt = camera.indexOf(
    "updateTrackingMeasurements(rawFrame, filteredFrame, timestamp)", processFrameAt
  );
  const captureFlagAt = camera.indexOf("const isCapturing =", updateAt);
  assert.ok(updateAt >= 0 && captureFlagAt > updateAt);
  assert.doesNotMatch(camera.slice(updateAt, captureFlagAt), /state\.recognitionEnabled/);
  assert.match(camera, /resetTrackingDiagnostics\("Cámara inactiva/);
  assert.match(appAuth, /async onSignedOut\(\)\s*\{\s*camera\.stop\(\)/);
});

test("reset on camera stop or sign-out clears all observations and safely reacquires", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 100; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    push(analyzer, raw, raw, i * dt);
  }
  const reset = analyzer.reset("Cámara inactiva; datos de seguimiento no disponibles.");
  assert.equal(reset.displacementRaw, null);
  assert.equal(reset.vibrationRaw, null);
  const resumed = frame({ left: hand(0.3, 101) });
  const first = push(analyzer, resumed, resumed, 5000);
  assert.equal(first.displacementRaw, null);
  assert.match(first.status, /sincronizando el primer par/i);
});

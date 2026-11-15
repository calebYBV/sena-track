import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_FILTER_CONFIG } from "../js/filters.js";
import {
  createTrackingDiagnostics,
  createTrackingDiagnosticsSession
} from "../js/trackingDiagnostics.js";

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

function collectQuietAtIntervals(intervalAt, duration = 5000){
  const analyzer = createTrackingDiagnostics();
  let time = 0, index = 0, result, maxProgress = 0;
  const progressValues = [];
  while (time <= duration){
    const raw = frame({ left: hand(0.3, index, 0.00004) });
    const filtered = frame({ left: hand(0.3, index, 0.00002) });
    result = push(analyzer, raw, filtered, time);
    maxProgress = Math.max(maxProgress, result.vibrationProgress);
    progressValues.push(result.vibrationProgress);
    time += intervalAt(index);
    index++;
  }
  return { result, maxProgress, count: index, progressValues };
}

function collectSyntheticQuiet(makeLandmarks, rawAmplitude, filteredAmplitude){
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 100; i++){
    const raw = frame({ left: makeLandmarks(i, rawAmplitude) });
    const filtered = frame({ left: makeLandmarks(i, filteredAmplitude) });
    result = push(analyzer, raw, filtered, i * dt);
  }
  return result;
}

function translatedHand(frameIndex, amplitude){
  const phase = frameIndex * 1.71;
  const dx = amplitude * Math.sin(phase);
  const dy = amplitude * Math.cos(phase * 0.73);
  return hand(0.3, 0).map(point => ({
    ...point,
    x: point.x + dx,
    y: point.y + dy
  }));
}

function internallyVaryingHand(frameIndex, amplitude){
  const delta = amplitude * Math.sin(frameIndex * 1.71);
  return hand(0.3, 0).map((point, index) => ({
    ...point,
    x: point.x + (index === 1 ? delta : index === 2 ? -delta : 0)
  }));
}

function trajectory(index, time = index * dt){
  return 0.5 + 0.035 * Math.sin(time / 155) + 0.018 * Math.sin(time / 61);
}

test("one quiet hand with small tracking noise yields paired vibration estimates", () => {
  const { result } = collectQuiet({ regions: ["left"] });
  assert.ok(result.displacementRaw > 0);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.equal(result.regionCount, 1);
  assert.match(result.quietReason, /medición disponible/i);
});

test("two quiet hands are measured together with equal regional weighting", () => {
  const { result } = collectQuiet({ regions: ["left", "right"] });
  assert.equal(result.regionCount, 2);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.match(result.status, /2 regiones/);
});

test("vibration normalization gives a hand and a higher-landmark-count face equal regional weight", () => {
  const aspect = 4 / 3;
  const handPoints = hand(0.3, 0);
  const facePoints = face(0.5, 0);
  const handScale = Math.hypot(
    (handPoints[0].x - handPoints[9].x) * aspect,
    handPoints[0].y - handPoints[9].y
  );
  const faceScale = Math.hypot(
    (facePoints[234].x - facePoints[454].x) * aspect,
    facePoints[234].y - facePoints[454].y
  );
  const translate = (points, scale, amplitude, index) => {
    const dx = amplitude * scale / aspect * Math.sin(index * 1.71);
    return points.map(point => ({ ...point, x: point.x + dx }));
  };
  const handAnalyzer = createTrackingDiagnostics();
  const combinedAnalyzer = createTrackingDiagnostics();
  let handResult, combinedResult;
  for (let i = 0; i < 100; i++){
    const rawHand = translate(handPoints, handScale, 0.0004, i);
    const filteredHand = translate(handPoints, handScale, 0.00004, i);
    const rawFace = translate(facePoints, faceScale, 0.0004, i);
    const filteredFace = translate(facePoints, faceScale, 0.00004, i);
    handResult = push(handAnalyzer, frame({ left: rawHand }),
      frame({ left: filteredHand }), i * dt, config, aspect);
    combinedResult = push(combinedAnalyzer,
      frame({ left: rawHand, facePoints: rawFace }),
      frame({ left: filteredHand, facePoints: filteredFace }), i * dt, config, aspect);
  }
  assert.ok(Math.abs(combinedResult.vibrationRaw - handResult.vibrationRaw) < 1e-9);
  assert.ok(Math.abs(combinedResult.vibrationFiltered - handResult.vibrationFiltered) < 1e-9);
});

test("face-only tracking uses face width as its normalization scale", () => {
  const { result } = collectQuiet({ regions: ["face"] });
  assert.equal(result.regionCount, 1);
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.match(result.note, /ancho facial/);
});

test("quiet detection is computed per region so a stable hand is not blocked by face motion", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 110; i++){
    const rawFace = face(0.5 + 0.08 * Math.sin(i * 0.5), i, 0.003);
    const filteredFace = face(0.5 + 0.04 * Math.sin(i * 0.5), i, 0.0015);
    const raw = frame({ left: hand(0.3, i, 0.00003), facePoints: rawFace });
    const filtered = frame({ left: hand(0.3, i, 0.000015), facePoints: filteredFace });
    result = push(analyzer, raw, filtered, i * dt);
  }
  assert.ok(result.vibrationRaw > 0);
  assert.equal(result.vibrationRegionCount, 1);
  assert.match(result.quietReason, /medición disponible/i);
});

test("robust quiet-window acquisition tolerates normal frame-to-frame landmark jitter", () => {
  const { result } = collectQuiet({
    regions: ["left", "right", "face"],
    rawNoise: 0.0002,
    filteredNoise: 0.0001
  });
  assert.ok(result.vibrationRaw > result.vibrationFiltered);
  assert.match(result.quietReason, /medición disponible/i);
});

test("quiet acquisition completes after five seconds from 8 through 60 FPS", () => {
  for (const fps of [8, 10, 12, 15, 24, 30, 60]){
    const { result, maxProgress, progressValues } =
      collectQuietAtIntervals(() => 1000 / fps);
    assert.ok(result.vibrationRaw !== null, `${fps}fps did not calculate vibration`);
    assert.equal(result.vibrationProgress, 100);
    assert.equal(result.vibrationRegionCount, 1);
    assert.equal(result.vibrationState, "medicion-disponible");
    assert.equal(maxProgress, 100);
    assert.ok(progressValues.some(progress => progress > 0 && progress < 100));
    assert.match(result.quietReason, /medición disponible/i);
  }
});

test("acquisition reports state transitions that match the tracking and measurement phases", () => {
  const analyzer = createTrackingDiagnostics();
  const missing = frame({});
  assert.equal(push(analyzer, missing, missing, 0).vibrationState, "sin-seguimiento");

  const seen = new Set();
  for (let i = 0; i <= 150; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    const filtered = frame({ left: hand(0.3, i, 0.00002) });
    seen.add(push(analyzer, raw, filtered, i * dt).vibrationState);
  }
  for (const phase of ["adquiriendo-muestras", "analizando-quietud",
    "midiendo-vibracion", "medicion-disponible"]){
    assert.ok(seen.has(phase), `missing acquisition phase ${phase}`);
  }
});

test("quiet acquisition tolerates irregular timestamps without requiring exact window endpoints", () => {
  const { result, maxProgress, count, progressValues } = collectQuietAtIntervals(index =>
    (1000 / 30) * (1 + 0.22 * Math.sin(index * 1.7)));
  assert.ok(count > 140);
  assert.ok(result.vibrationRaw !== null);
  assert.equal(result.vibrationProgress, 100);
  assert.equal(maxProgress, 100);
  assert.ok(progressValues.some(progress => progress > 0 && progress < 100));
});

test("quiet acquisition tolerates irregular timestamps at low camera frame rates", () => {
  for (const fps of [8, 10, 12, 15]){
    const { result, maxProgress, progressValues } = collectQuietAtIntervals(index =>
      (1000 / fps) * (1 + 0.12 * Math.sin(index * 1.7)));
    assert.ok(result.vibrationRaw !== null,
      `${fps}fps irregular timestamps did not measure: ${JSON.stringify(result)}`);
    assert.equal(result.vibrationRegionCount, 1);
    assert.equal(result.vibrationState, "medicion-disponible");
    assert.equal(result.vibrationProgress, 100);
    assert.equal(maxProgress, 100);
    assert.ok(progressValues.some(progress => progress > 0 && progress < 100));
  }
});

test("voluntary motion at camera frame rates does not qualify as a quiet segment", () => {
  for (const fps of [15, 24, 30, 60]){
    const analyzer = createTrackingDiagnostics();
    const period = 1000 / fps;
    let result;
    for (let i = 0; i <= fps * 5; i++){
      const time = i * period;
      const raw = frame({ left: hand(trajectory(i, time), i) });
      result = push(analyzer, raw, raw, time);
    }
    assert.equal(result.vibrationRaw, null, `${fps}fps produced false vibration`);
  }
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
  assert.match(result.quietReason, /Movimiento detectado|Evaluando una ventana estable/);
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
  assert.ok(Math.abs(result.displacementChange - 50) < 1e-8);
  assert.equal(result.displacementAssessment, "Menor desplazamiento observado con EDO");
});

test("relative displacement reports an increase with a negative signed difference", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 5; i++){
    const raw = frame({ left: hand(0.3 + i * 0.0075, i) });
    const filtered = frame({ left: hand(0.3 + i * 0.01125, i) });
    result = push(analyzer, raw, filtered, i * 100);
  }
  assert.ok(Math.abs(result.displacementChange + 50) < 1e-8);
  assert.equal(result.displacementAssessment, "Mayor desplazamiento observado con EDO");
});

test("relative displacement is not calculated for a near-zero baseline", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 5; i++){
    const raw = frame({ left: hand(0.3 + i * 0.0000005, i) });
    const filtered = frame({ left: hand(0.3 + i * 0.00000025, i) });
    result = push(analyzer, raw, filtered, i * 100);
  }
  assert.ok(result.displacementRaw <= 0.01);
  assert.equal(result.displacementChange, null);
  assert.match(result.displacementAssessment, /valor base demasiado pequeño/);
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
  assert.equal(result.vibrationState, "seguimiento-interrumpido");
});

test("a new or missing region does not interrupt an existing region's acquisition", () => {
  const analyzer = createTrackingDiagnostics();
  let result;
  for (let i = 0; i < 20; i++){
    const both = frame({ left: hand(0.3, i), right: hand(0.7, i) });
    result = push(analyzer, both, both, i * dt);
  }
  for (let i = 20; i < 110; i++){
    const one = frame({ left: hand(0.3, i, 0.00004) });
    result = push(analyzer, one, one, i * dt);
  }
  for (let i = 110; i < 145; i++){
    const both = frame({
      left: hand(0.3, i, 0.00004),
      right: hand(0.7, i, 0.00004)
    });
    result = push(analyzer, both, both, i * dt);
  }
  assert.ok(result.vibrationRaw > 0);
  assert.equal(result.vibrationRegionCount, 1);
});

test("regional aggregation includes only windows with comparable temporal coverage", () => {
  const analyzer = createTrackingDiagnostics();
  const fps = 15;
  const period = 1000 / fps;
  let result;
  for (let i = 0; i <= 75; i++){
    const raw = frame({
      left: hand(0.3, i, 0.00004),
      ...(i >= 52 ? { right: hand(0.7, i, 0.00004) } : {})
    });
    const filtered = frame({
      left: hand(0.3, i, 0.00002),
      ...(i >= 52 ? { right: hand(0.7, i, 0.00002) } : {})
    });
    result = push(analyzer, raw, filtered, i * period);
  }
  assert.ok(result.vibrationRaw > 0);
  assert.equal(result.vibrationRegionCount, 1);

  for (let i = 76; i <= 100; i++){
    const raw = frame({
      left: hand(0.3, i, 0.00004),
      right: hand(0.7, i, 0.00004)
    });
    const filtered = frame({
      left: hand(0.3, i, 0.00002),
      right: hand(0.7, i, 0.00002)
    });
    result = push(analyzer, raw, filtered, i * period);
  }
  assert.ok(result.vibrationRaw > 0);
  assert.equal(result.vibrationRegionCount, 2);
});

test("left-to-right identity changes do not connect unrelated hand trajectories", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 10; i++){
    const left = frame({ left: hand(0.3, i) });
    push(analyzer, left, left, i * dt);
  }
  const right = frame({ right: hand(0.7, 10) });
  const changed = push(analyzer, right, right, 10 * dt);
  assert.equal(changed.vibrationRaw, null);
  assert.equal(changed.vibrationRegionCount, 0);
});

test("large same-region jumps reset continuity instead of linking swapped identities", () => {
  const analyzer = createTrackingDiagnostics();
  for (let i = 0; i < 10; i++){
    const both = frame({ left: hand(0.3, i), right: hand(0.7, i) });
    push(analyzer, both, both, i * dt);
  }
  const swapped = frame({ left: hand(0.7, 10), right: hand(0.3, 10) });
  const result = push(analyzer, swapped, swapped, 10 * dt);
  assert.equal(result.vibrationRaw, null);
  assert.equal(result.vibrationRegionCount, 0);
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

test("common landmark translation noise is measured and EDO reduction is reflected", () => {
  const result = collectSyntheticQuiet(translatedHand, 0.00003, 0.000005);
  assert.ok(result.vibrationRaw > 0.01);
  assert.ok(result.vibrationFiltered < result.vibrationRaw);
  assert.ok(result.vibrationReduction > 0);
  assert.equal(result.vibrationAssessment, "EDO reduce la vibración");
});

test("common landmark translation noise reflects vibration introduced by EDO", () => {
  const result = collectSyntheticQuiet(translatedHand, 0.00001, 0.00005);
  assert.ok(result.vibrationFiltered > result.vibrationRaw);
  assert.ok(result.vibrationReduction < 0);
  assert.equal(result.vibrationAssessment, "EDO aumenta la vibración");
});

test("internal landmark variation with a stable centroid is measured and reduced by EDO", () => {
  const result = collectSyntheticQuiet(internallyVaryingHand, 0.0001, 0.00001);
  assert.ok(result.vibrationRaw > 0.01);
  assert.ok(result.vibrationFiltered < result.vibrationRaw);
  assert.ok(result.vibrationReduction > 0);
  assert.equal(result.vibrationAssessment, "EDO reduce la vibración");
});

test("internal landmark variation with a stable centroid reflects vibration introduced by EDO", () => {
  const result = collectSyntheticQuiet(internallyVaryingHand, 0.00005, 0.0001);
  assert.ok(result.vibrationFiltered > result.vibrationRaw);
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

test("tracking diagnostics no longer expose temporal-lag metrics", () => {
  const { result } = collectQuiet({ regions: ["left"] });
  assert.equal("lagMs" in result, false);
  assert.equal("lagReason" in result, false);
});

test("diagnostic session gates acquisition, resets transitions, and rejects stale frames", () => {
  const resets = [];
  const updates = [];
  const session = createTrackingDiagnosticsSession({
    onReset: (reason, active) => resets.push({ reason, active }),
    onUpdate: (...args) => updates.push(args)
  });
  const raw = frame({ left: hand(0.3, 0) });
  assert.equal(session.update(raw, raw, 0), false);
  assert.equal(updates.length, 0);

  assert.equal(session.setActive(true), true);
  const firstGeneration = session.generation();
  assert.equal(session.update(raw, raw, 10, firstGeneration), true);
  assert.equal(updates.length, 1);
  assert.equal(session.setActive(false), true);
  assert.equal(session.isActive(), false);
  assert.equal(session.update(raw, raw, 20, firstGeneration), false);

  assert.equal(session.setActive(true), true);
  const secondGeneration = session.generation();
  assert.notEqual(firstGeneration, secondGeneration);
  assert.equal(session.update(raw, raw, 30, firstGeneration), false);
  assert.equal(session.update(raw, raw, 40, secondGeneration), true);
  assert.equal(updates.length, 2);
  assert.deepEqual(resets.map(reset => reset.active), [true, false, true]);
});

test("stopping and restarting recognition starts a clean diagnostic measurement session", () => {
  const analyzer = createTrackingDiagnostics();
  let latest = null;
  const session = createTrackingDiagnosticsSession({
    onReset: reason => {
      latest = analyzer.reset(reason);
    },
    onUpdate: (raw, filtered, time) => {
      latest = push(analyzer, raw, filtered, time);
    }
  });
  session.setActive(true);
  const firstGeneration = session.generation();
  for (let i = 0; i < 110; i++){
    const raw = frame({ left: hand(0.3, i, 0.00004) });
    const filtered = frame({ left: hand(0.3, i, 0.00002) });
    session.update(raw, filtered, i * dt, firstGeneration);
  }
  assert.ok(latest.vibrationRaw > 0);

  session.setActive(false);
  assert.equal(latest.displacementRaw, null);
  assert.equal(latest.vibrationRaw, null);
  assert.equal(latest.vibrationProgress, 0);
  assert.equal(session.update(frame({ left: hand(0.3, 111) }),
    frame({ left: hand(0.3, 111) }), 4000, firstGeneration), false);

  session.setActive(true);
  const secondGeneration = session.generation();
  const firstFrame = frame({ left: hand(0.3, 120) });
  session.update(firstFrame, firstFrame, 10000, secondGeneration);
  assert.equal(latest.displacementRaw, null);
  assert.equal(latest.vibrationRaw, null);
  for (let i = 1; i < 110; i++){
    const raw = frame({ left: hand(0.3, 120 + i, 0.00004) });
    const filtered = frame({ left: hand(0.3, 120 + i, 0.00002) });
    session.update(raw, filtered, 10000 + i * dt, secondGeneration);
  }
  assert.ok(latest.vibrationRaw > 0);
});

test("camera gates diagnostic callbacks but keeps MediaPipe, EDO, and training capture in the frame loop", async () => {
  const camera = await readFile(new URL("../js/camera.js", import.meta.url), "utf8");
  const training = await readFile(new URL("../js/training.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const appAuth = await readFile(new URL("../js/appAuth.js", import.meta.url), "utf8");
  const processFrameAt = camera.indexOf("function processFrame()");
  const processFrame = camera.slice(processFrameAt);
  assert.match(processFrame, /landmarker\.detectForVideo\(video, timestamp\)/);
  assert.match(processFrame, /edo\.process\(rawLandmarks, identity, timestamp, state\.filterConfig\)/);
  assert.match(processFrame, /diagnosticsSession\.update\([\s\S]*?diagnosticsGeneration\s*\)/);
  assert.match(camera, /onUpdate:\s*\(rawFrame, filteredFrame, timestamp\)\s*=>\s*\{\s*ui\.updateCoordinateTrace/);
  assert.match(camera, /ui\.updateCoordinateTrace\(rawFrame, filteredFrame, timestamp\);\s*updateTrackingMeasurements\(rawFrame, filteredFrame, timestamp\);/);
  assert.match(processFrame, /if \(isCapturing\)\s*\{\s*capture\(/);
  assert.match(training, /state\.onRecognitionChange\?\.\(state\.recognitionEnabled\)/);
  assert.match(training, /setRecognitionEnabled\(true\)/);
  assert.match(app, /state\.onRecognitionChange = enabled => camera\.setDiagnosticsActive\(enabled\)/);
  assert.match(camera, /diagnosticsSession\.setActive\(false\)/);
  assert.match(camera, /diagnosticsSession\.reset\("Métricas reiniciadas por cambio de filtro\."\)/);
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  isCurrentRecognitionResult,
  isRecognitionActive,
  recognitionBranch,
  resetRecognitionForModeChange,
  selectUnifiedPrediction,
  selectActivePrediction,
  shouldProcessEdo,
  shouldAutoAppendPhrase
} from "../js/recognitionState.js";

test("recognition is only active while the global toggle is enabled", () => {
  assert.equal(isRecognitionActive({ recognitionEnabled: false, motion: null }), false);
  assert.equal(isRecognitionActive({ recognitionEnabled: true, motion: null }), true);
  assert.equal(isRecognitionActive({ recognitionEnabled: false, motion: { purpose: "recognize" } }), true);
});

test("immediate duplicate events are suppressed but intentional repeats can be appended", () => {
  const state = { recognitionEnabled: true, lastRecognitionLabel: null, lastRecognitionAt: 0 };
  assert.equal(shouldAutoAppendPhrase(state, "Gracias", 1000), true);
  assert.equal(shouldAutoAppendPhrase(state, "Gracias", 1050), false);
  assert.equal(shouldAutoAppendPhrase(state, "Gracias", 1500), true);
  assert.equal(shouldAutoAppendPhrase(state, "Gracias", 1550), false);
});

test("automatic phrase addition is ignored while recognition is disabled", () => {
  const state = { recognitionEnabled: false, lastRecognitionLabel: null, lastRecognitionAt: 0 };
  assert.equal(shouldAutoAppendPhrase(state, "Hola", 500), false);
});

test("recognition modes select one active branch and reset only incompatible state", () => {
  const state = {
    recognitionMode: "edo",
    recognitionGeneration: 4,
    recognitionEnabled: true,
    phrase: "Hola",
    committed: "Hola",
    cand: "Adiós",
    candCount: 6,
    motion: {
      purpose: "recognize",
      frames: [{ time: 1 }],
      lastComparedAt: 10,
      armed: false,
      segmentActive: true
    }
  };
  assert.equal(recognitionBranch(state), "filtered");
  assert.equal(shouldProcessEdo(state), true);
  assert.equal(selectActivePrediction({ label: "Raw" }, { label: "EDO" }, "edo").label, "EDO");
  const generation = state.recognitionGeneration;
  assert.equal(resetRecognitionForModeChange(state, "mediapipe"), true);
  assert.equal(recognitionBranch(state), "raw");
  assert.equal(shouldProcessEdo(state), true);
  assert.equal(state.recognitionEnabled, true);
  assert.equal(state.phrase, "Hola");
  assert.equal(state.committed, "Hola");
  assert.deepEqual(state.motion.frames, []);
  assert.equal(state.motion.armed, true);
  assert.equal(state.motion.segmentActive, false);
  assert.equal(state.motion.lastComparedAt, 0);
  assert.equal(state.cand, null);
  assert.equal(isCurrentRecognitionResult(state, generation), false);
  assert.equal(resetRecognitionForModeChange(state, "mediapipe"), false);
  assert.throws(() => resetRecognitionForModeChange(state, "invalid"), RangeError);
});

test("EDO frame work is skipped in idle Solo MediaPipe mode unless comparison is requested", () => {
  const state = {
    recognitionMode: "mediapipe",
    recognitionEnabled: false,
    motion: null,
    capState: null,
    filterConfig: { compareVisual: false }
  };
  assert.equal(shouldProcessEdo(state), false);
  state.filterConfig.compareVisual = true;
  assert.equal(shouldProcessEdo(state), true);
  state.filterConfig.compareVisual = false;
  state.recognitionEnabled = true;
  assert.equal(shouldProcessEdo(state), true);
});

test("stale recognition generations cannot append words after a mode switch", () => {
  const state = {
    recognitionEnabled: true,
    recognitionMode: "edo",
    recognitionGeneration: 1,
    lastRecognitionLabel: null,
    lastRecognitionAt: 0
  };
  resetRecognitionForModeChange(state, "mediapipe");
  assert.equal(shouldAutoAppendPhrase(state, "Hola", 1000, 1), false);
  assert.equal(shouldAutoAppendPhrase(state, "Hola", 1000, 2), true);
});

test("unified prediction accepts independent routes only when they agree", () => {
  const posture = { label: "5", src: "postura" };
  const motion = { label: "Gracias", src: "trayectoria" };
  assert.equal(selectUnifiedPrediction(posture, null).label, "5");
  assert.equal(selectUnifiedPrediction(null, motion).label, "Gracias");
  assert.deepEqual(selectUnifiedPrediction(posture, motion), {
    label: null, reason: "ambiguous", candidates: ["5", "Gracias"]
  });
  assert.equal(selectUnifiedPrediction(posture, { ...posture, src: "trayectoria" }).src,
    "postura y trayectoria");
  assert.equal(selectUnifiedPrediction(
    { reason: "ambiguous", candidates: ["5", "Gracias"] }, posture).reason, "ambiguous");
});

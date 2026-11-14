import test from "node:test";
import assert from "node:assert/strict";
import {
  isCurrentRecognitionResult,
  isRecognitionActive,
  resetRecognitionForFilterChange,
  selectUnifiedPrediction,
  selectActivePrediction,
  shouldAutoAppendPhrase
} from "../js/recognitionState.js";
import { DEFAULT_FILTER_CONFIG, normalizeActiveFilterConfig } from "../js/filters.js";

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

test("recognition selects only filtered predictions and resets temporal state on filter changes", () => {
  const state = {
    recognitionMode: "mediapipe",
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
  assert.equal(selectActivePrediction({ label: "EDO" }).label, "EDO");
  const generation = state.recognitionGeneration;
  resetRecognitionForFilterChange(state);
  assert.equal(state.recognitionEnabled, true);
  assert.equal(state.phrase, "Hola");
  assert.equal(state.committed, null);
  assert.deepEqual(state.motion.frames, []);
  assert.equal(state.motion.armed, true);
  assert.equal(state.motion.segmentActive, false);
  assert.equal(state.motion.lastComparedAt, 0);
  assert.equal(state.cand, null);
  assert.equal(isCurrentRecognitionResult(state, generation), false);
});

test("legacy Solo MediaPipe state cannot disable EDO frame processing", () => {
  const state = {
    recognitionMode: "mediapipe",
    recognitionEnabled: false,
    motion: null,
    capState: null,
    filterConfig: { ...DEFAULT_FILTER_CONFIG, model: "off", compareVisual: false }
  };
  assert.equal(normalizeActiveFilterConfig(state.filterConfig).model, "first");
});

test("only an EDO prediction can be selected for recognition", () => {
  const filtered = { label: "EDO" };
  assert.equal(selectActivePrediction(filtered), filtered);
  assert.equal(selectActivePrediction(null), null);
});

test("stale recognition generations cannot append words after a filter change", () => {
  const state = {
    recognitionEnabled: true,
    recognitionGeneration: 1,
    lastRecognitionLabel: null,
    lastRecognitionAt: 0
  };
  resetRecognitionForFilterChange(state);
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

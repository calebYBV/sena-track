import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecognitionActive,
  selectUnifiedPrediction,
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

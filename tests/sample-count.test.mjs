import test from "node:test";
import assert from "node:assert/strict";
import { countUniqueCaptures } from "../js/sampleCount.js";

test("capture counts deduplicate a repeated stored capture id", () => {
  assert.equal(countUniqueCaptures([
    { captureId: "capture-a", syncId: "stored-a" },
    { captureId: "capture-a", syncId: "stored-copy-a" },
    { syncId: "capture-b" }
  ]), 2);
});

test("legacy examples without capture ids count as individual records", () => {
  const first = { l: "A" }, second = { l: "A" };
  assert.equal(countUniqueCaptures([first, second, first]), 2);
});

test("distinct sync ids remain separate even when timestamps match", () => {
  assert.equal(countUniqueCaptures([
    { syncId: "row-a", captureMeta: { capturedAt: "2026-10-18T20:00:00.000Z" } },
    { syncId: "row-b", captureMeta: { capturedAt: "2026-10-18T20:00:00.000Z" } }
  ]), 2);
});

test("capture ids deduplicate rows before their distinct sync ids", () => {
  assert.equal(countUniqueCaptures([
    { captureId: "capture-a", syncId: "row-a" },
    { captureId: "capture-a", syncId: "row-b" }
  ]), 1);
});

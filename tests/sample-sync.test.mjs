import test from "node:test";
import assert from "node:assert/strict";
import { isSampleRecognizable, restoreCachedSample } from "../js/sampleSync.js";

function capture(syncStatus, syncId = "capture-001"){
  return {
    l: "Prueba", kind: "static", formatVersion: 1,
    f: Array(63).fill(0), syncStatus, syncId
  };
}

test("only explicitly confirmed sample statuses are recognizable", () => {
  for (const status of ["saved", "local"]){
    assert.equal(isSampleRecognizable(capture(status)), true);
  }
  for (const status of ["pending", "invalid", "unverified", "other", "", undefined]){
    assert.equal(isSampleRecognizable(capture(status)), false, String(status));
  }
  assert.equal(isSampleRecognizable(null), false);
});

test("a bare syncId cannot authorize an unknown or missing status", () => {
  for (const status of [undefined, "other", "unverified"]){
    const restored = restoreCachedSample(capture(status), "static");
    assert.equal(restored.syncStatus, "unverified");
    assert.equal(isSampleRecognizable(restored), false);
  }
});

test("a previously saved account-scoped cached sample is available locally", () => {
  for (const status of ["saved", "local"]){
    const restored = restoreCachedSample(capture(status), "static");
    assert.equal(restored.syncStatus, "local");
    assert.equal(isSampleRecognizable(restored), true);
  }
});

test("missing or invalid identifiers cannot assert a previously confirmed cache entry", () => {
  for (const syncId of ["", null, "bad/id"]){
    const restored = restoreCachedSample(capture("saved", syncId), "static");
    assert.equal(restored.syncStatus, "unverified");
  }
});

test("pending and malformed samples are preserved but not recognized", () => {
  const pending = restoreCachedSample(capture("pending"), "static");
  assert.equal(pending.syncStatus, "pending");
  assert.equal(isSampleRecognizable(pending), false);
  const malformed = capture("saved");
  malformed.f = [0];
  const restored = restoreCachedSample(malformed, "static");
  assert.equal(restored.syncStatus, "invalid");
  assert.equal(restored.f.length, 1);
  assert.equal(isSampleRecognizable(restored), false);
});

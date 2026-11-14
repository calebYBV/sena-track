import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateVibrationReduction,
  createEdoFilter,
  DEFAULT_FILTER_CONFIG,
  estimateTrackingLag,
  FILTER_TRACKING_PAUSE_MS,
  normalizeActiveFilterConfig
} from "../js/filters.js";

const point = x => [{ x, y: x * 2, z: -x }];

test("active filter configuration safely migrates disabled and invalid legacy models to first order", () => {
  assert.equal(normalizeActiveFilterConfig({ model: "off" }).model, "first");
  assert.equal(normalizeActiveFilterConfig({ model: "unknown" }).model, "first");
  assert.equal(normalizeActiveFilterConfig({ model: "second", zeta: 1.1 }).model, "second");
});

test("first-order filter initializes from a valid sample and converges monotonically", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.06 };
  assert.deepEqual(filter.process(point(0), "hand:Left", 0, config), point(0));
  const values = [30, 60, 90, 120].map(time =>
    filter.process(point(1), "hand:Left", time, config)[0].x);
  assert.ok(values.every(Number.isFinite));
  assert.ok(values[0] > 0 && values[0] < values[1] && values[1] < values[2] && values[2] < values[3]);
  assert.ok(values[3] < 1);
});

test("first-order filter uses explicit Euler with tau-quarter substeps and elapsed time", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.1 };
  filter.process(point(0), "hand:Left", 0, config);
  const result = filter.process(point(1), "hand:Left", 50, config)[0].x;
  assert.ok(Math.abs(result - 0.4375) < 1e-12);
});

test("second-order filter remains finite and bounded for jumps and variable frame times", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "second", zeta: 0.9, omegaN: 14 };
  filter.process(point(0), "face", 100, config);
  const values = [116, 150, 183, 220, 260, 293, 327, 360].map(time =>
    filter.process(point(1), "face", time, config)[0]);
  for (const value of values){
    assert.ok(Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
    assert.ok(value.x >= 0 && value.x <= 1.1);
  }
  assert.ok(values.at(-1).x > values[0].x);
});

test("second-order filter uses semi-implicit Euler and conservative substeps", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "second", zeta: 1, omegaN: 10 };
  filter.process(point(0), "face", 100, config);
  const result = filter.process(point(1), "face", 110, config)[0].x;
  assert.ok(Math.abs(result - 0.00724375) < 1e-12);
});

test("tracks are independent by identity and reset after loss, pauses, or configuration changes", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.1 };
  filter.process(point(0), "hand:Left", 0, config);
  filter.process(point(1), "hand:Right", 0, config);
  const left = filter.process(point(1), "hand:Left", 30, config)[0].x;
  const right = filter.process(point(0), "hand:Right", 30, config)[0].x;
  assert.ok(left > 0 && left < 1);
  assert.ok(right > 0 && right < 1);

  filter.retain([]);
  assert.deepEqual(filter.process(point(0.7), "hand:Left", 60, config), point(0.7));
  assert.deepEqual(filter.process(point(0.2), "hand:Left", 60 + FILTER_TRACKING_PAUSE_MS + 1, config), point(0.2));
  const changed = { ...config, tau: 0.2 };
  assert.deepEqual(filter.process(point(0.4), "hand:Left", 730, changed), point(0.4));
});

test("invalid measurements and filter parameters are rejected", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.1 };
  assert.throws(() => filter.process([{ x: Number.NaN, y: 0, z: 0 }], "face", 0, config), TypeError);
  assert.throws(() => filter.process(point(0), "face", 0, { ...config, tau: 0.001 }), RangeError);
});

test("disabled filter returns independent raw landmark objects", () => {
  const filter = createEdoFilter();
  const input = point(0.3);
  const output = filter.process(input, "hand:Right", 5, { ...DEFAULT_FILTER_CONFIG, model: "off" });
  assert.deepEqual(output, input);
  assert.notEqual(output[0], input[0]);
});

test("a repeated timestamp does not advance filter state twice", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.1 };
  filter.process(point(0), "hand:Right", 100, config);
  const first = filter.process(point(1), "hand:Right", 120, config);
  const repeated = filter.process(point(0), "hand:Right", 120, config);
  assert.deepEqual(repeated, first);
});

test("face yaw and roll follow the shortest path across the circular boundary", () => {
  const filter = createEdoFilter();
  const config = { ...DEFAULT_FILTER_CONFIG, model: "first", tau: 0.1 };
  const features = value => Array.from({ length: 32 }, (_, index) => ({
    x: index === 29 || index === 31 ? value : 0,
    y: 0,
    z: 0
  }));
  filter.process(features(0.99), "face:features", 0, config);
  const output = filter.process(features(-0.99), "face:features", 30, config);
  assert.ok(output[29].x > 0.9 || output[29].x < -0.9);
  assert.ok(output[31].x > 0.9 || output[31].x < -0.9);
});

test("vibration reduction preserves improvements, regressions, and non-calculable baselines", () => {
  assert.ok(Math.abs(calculateVibrationReduction(0.1, 0.07) - 30) < 1e-9);
  assert.ok(Math.abs(calculateVibrationReduction(0.1, 0.12) + 20) < 1e-9);
  assert.equal(calculateVibrationReduction(0, 0.01), null);
});

test("lag estimator detects temporal offset and rejects stationary trajectories", () => {
  const positions = Array.from({ length: 48 }, (_, i) =>
    Math.sin(i * 0.31) + 0.2 * Math.sin(i * 0.73));
  const samples = positions.map((x, i) => ({
    raw: { x, y: 0.4 + x * 0.25 },
    filtered: { x: positions[Math.max(0, i - 2)], y: 0.4 + positions[Math.max(0, i - 2)] * 0.25 },
    time: i * 33.3,
    aspect: 4 / 3
  }));
  const lag = estimateTrackingLag(samples);
  assert.ok(lag > 45 && lag < 90);
  const stationary = samples.map(sample => ({
    ...sample, raw: { x: 0.3, y: 0.4 }, filtered: { x: 0.3, y: 0.4 }
  }));
  assert.equal(estimateTrackingLag(stationary), null);
});

test("lag estimation is invariant to different mean velocities in raw and filtered tracks", () => {
  const oscillation = i => Math.sin(i * 0.24) + 0.35 * Math.sin(i * 0.79);
  const samples = Array.from({ length: 80 }, (_, i) => ({
    raw: { x: 0.1 * i + oscillation(i), y: 0 },
    filtered: { x: oscillation(Math.max(0, i - 2)), y: 0 },
    time: i * 33.333,
    aspect: 1
  }));
  const lag = estimateTrackingLag(samples);
  assert.ok(Math.abs(lag - 66.666) < 1);
});

test("filter comparison measures the same quiet and moving traces for all three models", () => {
  const models = ["off", "first", "second"];
  const errors = Object.fromEntries(models.map(model => [model, []]));
  const quietValues = Object.fromEntries(models.map(model => [model, []]));
  const filters = Object.fromEntries(models.map(model => [model, createEdoFilter()]));
  const configs = Object.fromEntries(models.map(model => [model, {
    ...DEFAULT_FILTER_CONFIG, model
  }]));

  for (let i = 0; i < 240; i++){
    const timestamp = i * 33.333;
    const truth = 0.4 + 0.12 * Math.sin(i * 0.08);
    const noise = 0.025 * (Math.sin(i * 1.71) + 0.6 * Math.sin(i * 2.39));
    const input = [{ x: truth + noise, y: 0.5 + noise, z: 0 }];
    for (const model of models){
      const actual = filters[model].process(input, "hand:Left", timestamp, configs[model])[0].x;
      errors[model].push((actual - truth) ** 2);
    }

    const quietNoise = 0.025 * (Math.sin(i * 1.71) + 0.6 * Math.sin(i * 2.39));
    const quietInput = [{ x: 0.4 + quietNoise, y: 0.5 + quietNoise, z: 0 }];
    for (const model of models){
      quietValues[model].push(filters[model].process(
        quietInput, "quiet:hand", timestamp, configs[model]
      )[0].x);
    }
  }

  const rmse = Object.fromEntries(models.map(model => [model,
    Math.sqrt(errors[model].reduce((sum, value) => sum + value, 0) / errors[model].length)
  ]));
  const deviation = model => {
    const values = quietValues[model].slice(20);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  };
  assert.ok(rmse.first < rmse.off);
  assert.ok(rmse.second > rmse.off);
  assert.ok(deviation("first") < deviation("off"));
  assert.ok(deviation("second") < deviation("off"));
});

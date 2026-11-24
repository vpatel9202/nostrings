// Pure parts of the benchmark's report: percentiles, Wilson intervals, and
// the focus and cursor watch. No apps, no model calls.
import assert from "node:assert/strict";
import test from "node:test";
import { median, p90, percentile, wilson } from "../bench/lib/stats.mjs";
import { foldWatch } from "../bench/lib/watch.mjs";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test("p90 is the nearest-rank value and skips missing data", () => {
  assert.equal(p90([]), null);
  assert.equal(p90([null, undefined]), null);
  assert.equal(p90([7]), 7);
  assert.equal(p90([1, 2, 3]), 3);
  assert.equal(p90([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 9);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 10);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("Wilson 95% interval for pass rates", () => {
  assert.equal(wilson(0, 0), null);
  const half = wilson(5, 10);
  near(half.lo, 0.2366);
  near(half.hi, 0.7634);
  const none = wilson(0, 10);
  assert.equal(none.lo, 0);
  near(none.hi, 0.2775);
  const all = wilson(10, 10);
  near(all.lo, 0.7225);
  assert.equal(all.hi, 1);
  const one = wilson(1, 1);
  near(one.lo, 0.2065);
  assert.equal(one.hi, 1);
});

test("focus steals count departures from the starting app", () => {
  const s = (app, x = 100, y = 100) => ({ app, x, y });
  assert.equal(foldWatch([]), null);
  assert.equal(foldWatch([null, null]), null);
  const quiet = foldWatch([s("a"), s("a"), s("a")]);
  assert.equal(quiet.focusSteals, 0);
  assert.equal(quiet.cursorMoved, false);
  // Away, away, back, away again: two departures.
  const stolen = foldWatch([s("a"), s("b"), s("c"), s("a"), s("b")]);
  assert.equal(stolen.focusSteals, 2);
  assert.deepEqual(stolen.otherApps.sort(), ["b", "c"]);
});

test("cursor movement beyond the tolerance counts", () => {
  const s = (x, y) => ({ app: "a", x, y });
  assert.equal(foldWatch([s(10, 10), s(11, 11)]).cursorMoved, false);
  const moved = foldWatch([s(10, 10), s(10, 10), s(40, 50), s(10, 10)]);
  assert.equal(moved.cursorMoved, true);
  assert.equal(moved.cursorMaxPx, 50);
});

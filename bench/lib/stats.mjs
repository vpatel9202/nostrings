// Pure statistics for the report. No dependencies, so the root `npm test`
// can import this file without installing the bench's packages.

const present = (values) => values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);

export function median(values) {
  const v = present(values);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Nearest-rank percentile: the smallest value with at least q of the sample
// at or below it. With few runs per cell p90 is the slowest or costliest run,
// which is the honest reading of "how bad does it get".
export function percentile(values, q) {
  const v = present(values);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

export const p90 = (values) => percentile(values, 0.9);

// Wilson score interval for a pass rate: `passes` of `n` runs, z = 1.96 for
// 95%. Unlike the normal approximation it stays inside [0, 1] and is not
// degenerate at 0/n or n/n. Returns null when there are no runs.
export function wilson(passes, n, z = 1.96) {
  if (!n) return null;
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

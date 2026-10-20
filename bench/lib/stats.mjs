const Z = 1.959963984540054;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Wilson score interval for k successes out of n.
export function wilson(k, n) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + Z * Z / n;
  const center = (p + Z * Z / (2 * n)) / denom;
  const half = Z * Math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// Newcombe's hybrid score interval for p1 - p2 (method 10).
export function newcombe(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p1 - p2;
  return [d - Math.hypot(p1 - l1, u2 - p2), d + Math.hypot(u1 - p1, p2 - l2)];
}

function binomial(n, k) {
  let c = 1;
  for (let i = 1; i <= k; i++) c = c * (n - i + 1) / i;
  return c;
}

// Two-sided exact sign test: k of n pairs went one way.
export function signTest(k, n) {
  if (!n) return null;
  const tail = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= tail; i++) p += binomial(n, i);
  return Math.min(1, 2 * p / 2 ** n);
}

// How often the two-sided sign test reaches p < alpha over n pairs when neither arm is faster.
export function signTestRate(n, alpha) {
  let rate = 0;
  for (let k = 0; k <= n; k++) if (n && signTest(k, n) < alpha) rate += binomial(n, k) / 2 ** n;
  return rate;
}

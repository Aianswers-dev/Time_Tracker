/**
 * Math.hypot(a, b), bit for bit, without its allocation. (V8's builtin is not inlined and boxes its
 * arguments into a new array on every call: tens of KB a frame in the traffic loops.) The same steps
 * as V8's builtins/math.tq: both magnitudes scaled by the larger, the squares summed (its Kahan
 * compensation is exactly 0 for two terms), then sqrt(sum) times the larger; identical on 2e7 random
 * and edge-case pairs in node and in Chromium.
 */
export function hypot2(a: number, b: number): number {
  if (a !== a || b !== b) return a === Infinity || a === -Infinity || b === Infinity || b === -Infinity ? Infinity : NaN;
  const x = Math.abs(a);
  const y = Math.abs(b);
  const max = x > y ? x : y;
  if (max === Infinity) return Infinity;
  if (max === 0) return 0;
  const nx = x / max;
  const ny = y / max;
  return Math.sqrt(nx * nx + ny * ny) * max;
}

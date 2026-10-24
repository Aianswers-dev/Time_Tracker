import * as THREE from 'three';

/** Map (x east, y north) metres + height -> three.js world position. */
export function toWorld(x: number, y: number, h = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, h, -y);
}

/** three.js world position -> map [x, y]. */
export function fromWorld(v: THREE.Vector3): [number, number] {
  return [v.x, -v.z];
}

/**
 * Compass heading (0 = north, clockwise) -> three.js rotation.y for an object
 * whose forward is local -Z.
 */
export function headingToRotY(heading: number): number {
  return -heading;
}

/** Unit forward vector in map coordinates for a compass heading. */
export function headingDir(heading: number): [number, number] {
  return [Math.sin(heading), Math.cos(heading)];
}

/** Compass heading of the map-space vector (dx, dy). */
export function headingOf(dx: number, dy: number): number {
  return Math.atan2(dx, dy);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Point and heading at distance `s` along a polyline with cumulative distances. */
export function pointAlong(pts: Float32Array, cum: Float32Array, s: number): { x: number; y: number; heading: number; i: number } {
  const n = cum.length;
  if (s <= 0) return { x: pts[0], y: pts[1], heading: headingOf(pts[2] - pts[0], pts[3] - pts[1]), i: 0 };
  if (s >= cum[n - 1]) {
    const j = n - 2;
    return {
      x: pts[2 * n - 2],
      y: pts[2 * n - 1],
      heading: headingOf(pts[2 * n - 2] - pts[2 * j], pts[2 * n - 1] - pts[2 * j + 1]),
      i: j,
    };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  const x0 = pts[2 * lo];
  const y0 = pts[2 * lo + 1];
  const x1 = pts[2 * hi];
  const y1 = pts[2 * hi + 1];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, heading: headingOf(x1 - x0, y1 - y0), i: lo };
}

/** Cumulative distance array for a flat polyline. */
export function cumulative(pts: Float32Array): Float32Array {
  const n = pts.length / 2;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  return cum;
}

/**
 * Project point (x, y) onto a polyline, searching vertices [from, to).
 * Returns distance along, lateral offset (+ = right of travel direction) and segment index.
 */
export function projectOnto(
  pts: Float32Array,
  cum: Float32Array,
  x: number,
  y: number,
  from = 0,
  to = cum.length - 1,
): { s: number; offset: number; dist: number; i: number } {
  let best = { s: 0, offset: 0, dist: Infinity, i: 0 };
  const end = Math.min(to, cum.length - 1);
  for (let i = Math.max(0, from); i < end; i++) {
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const dx = pts[2 * i + 2] - ax;
    const dy = pts[2 * i + 3] - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best.dist) {
      const len = Math.sqrt(len2);
      // right of travel: cross((dx,dy),(x-ax,y-ay)) < 0 means right in a y-up frame
      const cross = dx * (y - ay) - dy * (x - ax);
      best = { s: cum[i] + t * len, offset: -cross / len, dist: d, i };
    }
  }
  return best;
}

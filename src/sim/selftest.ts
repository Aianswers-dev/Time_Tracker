/**
 * Driving-model sanity checks. Not part of the app bundle.
 *   npx -y tsx src/sim/selftest.ts
 * Prints turning circle, 0-50 km/h, stopping distance, top speed, Metro joint
 * angles in a U-turn, plus a few interlock checks, and fails loudly if any is
 * outside the expected band.
 */
import type { BusSpec, BusType, DriveInput, MapData } from '../types';
import { BusPhysics } from './physics';
import { BusControls } from './controls';
import { buildCollider, type SimCollider } from './collider';
import { Heights } from '../data/height';

const FALLBACK: Record<BusType, BusSpec> = {
  rigid: {
    type: 'rigid', width: 2.5, height: 3.2, wheelbase: 6.1, frontOverhang: 2.75, maxSteer: 0.72, mass: 13000,
    sections: [{ length: 12.5, axleFromFront: 8.85, hitchFromFront: 0, rearHitchFromFront: 12.5 }],
  },
  glider: {
    type: 'glider', width: 2.5, height: 3.2, wheelbase: 6.1, frontOverhang: 2.75, maxSteer: 0.72, mass: 13000,
    sections: [{ length: 12.5, axleFromFront: 8.85, hitchFromFront: 0, rearHitchFromFront: 12.5 }],
  },
  metro: {
    type: 'metro', width: 2.55, height: 3.4, wheelbase: 5.9, frontOverhang: 2.7, maxSteer: 0.7, mass: 30000,
    sections: [
      { length: 9.6, axleFromFront: 8.6, hitchFromFront: 0, rearHitchFromFront: 9.6 },
      { length: 7.5, axleFromFront: 6.4, hitchFromFront: 0, rearHitchFromFront: 7.5 },
      { length: 7.6, axleFromFront: 5.0, hitchFromFront: 0, rearHitchFromFront: 7.6 },
    ],
  },
};

async function specs(): Promise<Record<BusType, BusSpec>> {
  try {
    const m = await import('../bus/spec');
    return { rigid: m.specFor('rigid'), glider: m.specFor('glider'), metro: m.specFor('metro') };
  } catch (e) {
    console.log('(bus module not importable in node, using fallback specs)', String(e).slice(0, 80));
    return FALLBACK;
  }
}

const input = (o: Partial<DriveInput> = {}): DriveInput => ({
  throttle: 0, brake: 0, steer: 0, gear: 'D', pressed: new Set(), held: new Set(), ...o,
});

const DT = 1 / 60;
let failures = 0;
function check(name: string, value: number, lo: number, hi: number, unit: string): void {
  const ok = value >= lo && value <= hi;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(42)} ${value.toFixed(2).padStart(8)} ${unit.padEnd(6)} [${lo}..${hi}]`);
}

function sim(spec: BusSpec) {
  const p = new BusPhysics(spec);
  const c = new BusControls();
  p.reset(0, 0, 0);
  const step = (i: DriveInput) => {
    c.update(DT, i, p.pose);
    p.update(DT, i, c);
  };
  return { p, c, step };
}

function zeroTo50(spec: BusSpec): number {
  const { p, step } = sim(spec);
  let t = 0;
  while (p.pose.speed < 50 / 3.6 && t < 60) {
    step(input({ throttle: 1 }));
    t += DT;
  }
  return t;
}

function topSpeed(spec: BusSpec): number {
  const { p, step } = sim(spec);
  for (let t = 0; t < 120; t += DT) step(input({ throttle: 1 }));
  return p.pose.speed * 3.6;
}

function stopping(spec: BusSpec, kmh: number): number {
  const { p, step } = sim(spec);
  while (p.pose.speed < kmh / 3.6) step(input({ throttle: 1 }));
  const x0 = p.pose.x;
  const y0 = p.pose.y;
  let t = 0;
  while (p.pose.speed > 0.01 && t < 30) {
    step(input({ brake: 1 }));
    t += DT;
  }
  return Math.hypot(p.pose.x - x0, p.pose.y - y0);
}

function turningCircle(spec: BusSpec): { kerb: number; wall: number; rear: number } {
  const { p, step } = sim(spec);
  const pts: { kx: number; ky: number; wx: number; wy: number; rx: number; ry: number }[] = [];
  for (let t = 0; t < 60; t += DT) {
    // Hold a crawl (~1.2 m/s) at full lock.
    const v = p.pose.speed;
    step(input({ steer: 1, throttle: v < 1.2 ? 0.25 : 0, brake: v > 1.4 ? 0.2 : 0 }));
    if (t > 8 && Math.round(t / DT) % 6 === 0) {
      const h = p.pose.heading;
      const fx = Math.sin(h);
      const fy = Math.cos(h);
      // Turning right: outside is the left (-right vector).
      const lx = -fy;
      const ly = fx;
      const wb = spec.wheelbase;
      const track = spec.width / 2 - 0.12;
      const fo = spec.sections[0].axleFromFront;
      pts.push({
        kx: p.pose.x + fx * wb + lx * track,
        ky: p.pose.y + fy * wb + ly * track,
        wx: p.pose.x + fx * fo + lx * (spec.width / 2),
        wy: p.pose.y + fy * fo + ly * (spec.width / 2),
        rx: p.pose.x,
        ry: p.pose.y,
      });
    }
  }
  const diam = (k: 'k' | 'w' | 'r') => {
    let best = 0;
    for (const a of pts)
      for (const b of pts) {
        const d = Math.hypot(a[`${k}x`] - b[`${k}x`], a[`${k}y`] - b[`${k}y`]);
        if (d > best) best = d;
      }
    return best;
  };
  return { kerb: diam('k'), wall: diam('w'), rear: diam('r') };
}

function metroUTurn(spec: BusSpec): { maxJoint: number; finite: boolean } {
  const { p, step } = sim(spec);
  let maxJ = 0;
  let finite = true;
  const run = (secs: number, steer: number, target: number, gear: DriveInput['gear'] = 'D') => {
    for (let t = 0; t < secs; t += DT) {
      const v = Math.abs(p.pose.speed);
      step(input({ steer, gear, throttle: v < target ? 0.35 : 0, brake: v > target + 0.4 ? 0.3 : 0 }));
      for (const j of p.joints) maxJ = Math.max(maxJ, Math.abs(j));
      for (const s of p.pose.sections) if (!Number.isFinite(s.x) || !Number.isFinite(s.heading)) finite = false;
    }
  };
  run(10, 0, 4);
  run(25, 1, 2.5);
  run(20, -1, 3);
  run(8, 0, 0);
  // Reverse with lock on: jackknife protection should stop it at the joint limit.
  run(20, 0.6, 1.5, 'R');
  return { maxJoint: (maxJ * 180) / Math.PI, finite };
}

function interlocks(spec: BusSpec): void {
  // S at standstill must not reverse.
  {
    const { p, step } = sim(spec);
    for (let t = 0; t < 3; t += DT) step(input({ brake: 1 }));
    check('brake held at standstill: speed', p.pose.speed, 0, 0, 'm/s');
  }
  // Doors open: throttle ignored.
  {
    const { p, c, step } = sim(spec);
    step(input({ pressed: new Set(['doors']) }));
    for (let t = 0; t < 4; t += DT) step(input({ throttle: 1 }));
    check('doors open + throttle: distance', Math.hypot(p.pose.x, p.pose.y), 0, 0.05, 'm');
    check('doors open fraction', c.doorOpen, 0.95, 1, '');
  }
  // Park brake holds against full throttle.
  {
    const { p, step } = sim(spec);
    step(input({ pressed: new Set(['parkBrake']) }));
    for (let t = 0; t < 3; t += DT) step(input({ throttle: 1 }));
    check('park brake + throttle: distance', Math.hypot(p.pose.x, p.pose.y), 0, 0.05, 'm');
  }
  // Idle creep in D.
  {
    const { p, step } = sim(spec);
    for (let t = 0; t < 20; t += DT) step(input());
    check('idle creep speed', p.pose.speed * 3.6, 1, 6, 'km/h');
  }
  // Reverse speed limit.
  {
    const { p, step } = sim(spec);
    for (let t = 0; t < 20; t += DT) step(input({ gear: 'R', throttle: 1 }));
    check('reverse governed speed', -p.pose.speed * 3.6, 6, 12, 'km/h');
  }
  // Coast-down from 60 with the retarder.
  {
    const { p, step } = sim(spec);
    while (p.pose.speed < 60 / 3.6) step(input({ throttle: 1 }));
    let t = 0;
    while (p.pose.speed > 40 / 3.6 && t < 60) {
      step(input());
      t += DT;
    }
    check('coast 60->40 km/h (retarder)', t, 2.5, 12, 's');
  }
}

function frameRateIndependence(spec: BusSpec): void {
  const run = (dt: number) => {
    const p = new BusPhysics(spec);
    const c = new BusControls();
    p.reset(0, 0, 0);
    for (let t = 0; t < 12; t += dt) {
      const i = input({ throttle: 1, steer: t > 6 ? 0.4 : 0 });
      c.update(dt, i, p.pose);
      p.update(dt, i, c);
    }
    return p.pose;
  };
  const a = run(1 / 144);
  const b = run(1 / 20);
  check('frame-rate independence (144 vs 20 fps)', Math.hypot(a.x - b.x, a.y - b.y), 0, 1.5, 'm');
}

// ---------------------------------------------------------------------------
// Synthetic maps for the collider and the 3D tests.

interface RoadDef {
  pts: number[];
  z: number[];
  width?: number;
  bridge?: boolean;
  tunnel?: boolean;
  oneway?: boolean;
  kind?: number;
}

function makeMap(o: {
  roads: RoadDef[];
  buildings?: { pts: number[]; z?: number; height: number; minHeight?: number }[];
  water?: number[][];
  ground?: (x: number, y: number) => number;
  bounds?: [number, number, number, number];
  platforms?: { pts: number[]; underground: boolean }[];
  /** Bus route polylines (x, y pairs) with their heights. */
  routes?: { pts: number[]; z: number[] }[];
}): MapData {
  const bounds = o.bounds ?? [-400, -400, 400, 400];
  const cell = 5;
  const x0 = bounds[0] - 250;
  const y0 = bounds[1] - 250;
  const nx = Math.ceil((bounds[2] - bounds[0] + 500) / cell) + 1;
  const ny = Math.ceil((bounds[3] - bounds[1] + 500) / cell) + 1;
  const h = new Float32Array(nx * ny);
  const g = o.ground ?? (() => 0);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = g(x0 + i * cell, y0 + j * cell);
  return {
    bounds,
    roads: o.roads.map((r) => ({
      kind: r.kind ?? 3,
      width: r.width ?? 7,
      lanes: 2,
      oneway: !!r.oneway,
      bridge: !!r.bridge,
      tunnel: !!r.tunnel,
      layer: 0,
      link: false,
      bus: false,
      pts: new Float32Array(r.pts),
      z: new Float32Array(r.z),
    })),
    rail: [],
    signals: new Float32Array(0),
    crossings: new Float32Array(0),
    buildings: (o.buildings ?? []).map((b) => ({ height: b.height, minHeight: b.minHeight ?? 0, kind: 0, part: false, pts: new Float32Array(b.pts), z: b.z ?? 0 })),
    areas: [],
    water: (o.water ?? []).map((pts) => ({ kind: 0, pts: new Float32Array(pts), holes: [] })),
    trees: new Float32Array(0),
    stops: [],
    routes: (o.routes ?? []).map((r) => ({ id: 't', name: '', dir: 0, headsign: '', color: '#000000', textColor: '#ffffff', operator: 'BT', trips: 1, pts: new Float32Array(r.pts), cum: new Float32Array(r.pts.length / 2), z: new Float32Array(r.z), length: 0, stops: [] })),
    platforms: (o.platforms ?? []).map((p) => ({ name: '', ref: '', pts: new Float32Array(p.pts), area: true, covered: true, layer: p.underground ? -1 : 0, underground: p.underground })),
    terrain: { waterLevel: 0.5, attribution: '', grids: [{ name: 'test', x0, y0, cell, nx, ny, h }] },
  } as unknown as MapData;
}

const box = (x: number, y: number, w: number, d = w) => [x, y, x + w, y, x + w, y + d, x, y + d];

function world(data: MapData) {
  return buildCollider(data, { heights: new Heights(data) });
}

/** Drive a bus on a map; returns per-step samples. */
function drive(spec: BusSpec, col: SimCollider, start: [number, number, number, number], secs: number, inp: (t: number, p: BusPhysics) => Partial<DriveInput>) {
  const p = new BusPhysics(spec);
  const c = new BusControls();
  p.reset(start[0], start[1], start[2], start[3]);
  const out: { t: number; x: number; y: number; z: number; zf: number; v: number; water: boolean; hit: boolean }[] = [];
  for (let t = 0; t < secs; t += DT) {
    const i = input(inp(t, p));
    c.update(DT, i, p.pose);
    const r = p.update(DT, i, c, col);
    const s0 = p.pose.sections[0];
    const zf = (s0.z ?? 0) + Math.tan(s0.pitch ?? 0) * spec.wheelbase;
    out.push({ t, x: p.pose.x, y: p.pose.y, z: p.pose.z ?? 0, zf, v: p.pose.speed, water: r.water, hit: r.hit });
  }
  return { p, c, out };
}

const minOf = (a: number[]) => a.reduce((m, v) => Math.min(m, v), Infinity);
const maxOf = (a: number[]) => a.reduce((m, v) => Math.max(m, v), -Infinity);

function colliderBox(spec: BusSpec): void {
  // A 20 x 20 m block 30 m ahead, plus a road with an awning over it.
  const data = makeMap({
    roads: [{ pts: [-100, -100, -100, 100], z: [0, 0] }],
    buildings: [
      { pts: box(-10, 30, 20), height: 10 },
      { pts: box(-104, 0, 8), height: 6 }, // awning over the road: must be ignored
    ],
  });
  const col = world(data);
  check('collider: awning over road excluded', col.stats.solid, 1, 1, '');
  const { p, out } = drive(spec, col, [0, 0, 0, 0], 20, () => ({ throttle: 1 }));
  check('collider: front never past the wall', maxOf(out.map((s) => s.y)) + spec.sections[0].axleFromFront, 29.5, 30.05, 'm');
  check('collider: head-on, stopped at the wall', Math.abs(p.pose.speed), 0, 0.5, 'm/s');
  // Head-on at speed: one thump with the full speed into the wall.
  const hp = new BusPhysics(spec);
  const hc = new BusControls();
  hp.reset(0, 5, 0, 0);
  hp.pose.speed = 8;
  let maxImpact = 0;
  for (let t = 0; t < 4; t += DT) {
    const i = input({ throttle: 0.3 });
    hc.update(DT, i, hp.pose);
    maxImpact = Math.max(maxImpact, hp.update(DT, i, hc, col).impact);
  }
  check('collider: head-on impact reported (m/s into the wall)', maxImpact, 6, 9, 'm/s');
  // Snap back to the road.
  p.reset(p.pose.x, p.pose.y, p.pose.heading);
  check('reset: snapped next to the road', Math.abs(p.pose.x - -100), 0, 3.6, 'm');
}

function viaduct(spec: BusSpec): void {
  // A viaduct (deck at 10 m) north-south over a street at ground level (0 m) running east-west.
  const data = makeMap({
    roads: [
      { pts: [0, -300, 0, 300], z: [10, 10], bridge: true, width: 7.4 },
      { pts: [-300, 0, 300, 0], z: [0, 0], width: 7 },
    ],
  });
  const col = world(data);
  console.log(`     walls: ${col.stats.walls} (parapets ${col.stats.parapets}, tunnel ${col.stats.tunnelWalls}, retaining ${col.stats.retainingWalls})`);
  // Along the deck, over the street.
  const a = drive(spec, col, [0, -200, 0, 10], 30, () => ({ throttle: 0.7 }));
  const zs = a.out.filter((s) => s.t > 0.5).map((s) => s.z);
  check('viaduct: stays on the deck over the street (min z)', minOf(zs), 9.9, 10.1, 'm');
  check('viaduct: drove across the street below', a.p.pose.y, 30, 300, 'm');
  // Steer hard for the edge: the parapet keeps it on.
  const b = drive(spec, col, [0, -250, 0, 10], 25, (t) => ({ throttle: 0.6, steer: t > 2 ? 0.8 : 0 }));
  const xs = b.out.map((s) => Math.abs(s.x));
  check("viaduct: can't drive off the edge (min z)", minOf(b.out.map((s) => s.z)), 9.9, 10.1, 'm');
  check('viaduct: kept between the parapets (|x| max)', maxOf(xs), 0, 4.4 + 1.3, 'm');
  // The street below passes under the viaduct (parapets are up at deck level).
  const c = drive(spec, col, [-150, -1.75, Math.PI / 2, 0], 25, () => ({ throttle: 0.7 }));
  check('street under the viaduct: passes beneath', c.p.pose.x, 40, 300, 'm');
  check('street under the viaduct: stays at street level (max z)', maxOf(c.out.map((s) => s.z)), -0.1, 0.1, 'm');
}

function tunnel(spec: BusSpec): void {
  // A hill at 20 m with a tunnel at 10 m under it (west-east, y = 0), and a tall building above the tunnel.
  const data = makeMap({
    roads: [
      { pts: [-300, 0, 300, 0], z: [10, 10], tunnel: true, width: 7.4 },
      { pts: [-300, 60, 300, 60], z: [20, 20], width: 7 },
    ],
    buildings: [{ pts: box(60, -15, 40, 30), z: 20, height: 40 }],
    ground: () => 20,
  });
  const col = world(data);
  const a = drive(spec, col, [-250, -1.75, Math.PI / 2, 10], 35, () => ({ throttle: 0.7 }));
  const zs = a.out.filter((s) => s.t > 0.5).map((s) => s.z);
  check('tunnel: stays in the tunnel (max z)', maxOf(zs), 9.9, 10.1, 'm');
  check('tunnel: passes under the building above', a.p.pose.x, 120, 300, 'm');
  // Turn into the tunnel wall: it holds.
  const b = drive(spec, col, [-250, -1.75, Math.PI / 2, 10], 20, (t) => ({ throttle: 0.6, steer: t > 2 ? -0.8 : 0 }));
  check('tunnel: kept inside the walls (|y| max)', maxOf(b.out.map((s) => Math.abs(s.y))), 0, 4.4 + 1.3, 'm');
  check('tunnel: still underground (max z)', maxOf(b.out.map((s) => s.z)), 9.9, 10.1, 'm');
  // The same building stops a bus at street level.
  const c = drive(spec, col, [80, -60, 0, 20], 15, () => ({ throttle: 0.8 }));
  check('street level: the building above the tunnel is solid', c.p.pose.y + spec.sections[0].axleFromFront, -16, -14.9, 'm');
}

function tunnelCurve(spec: BusSpec): void {
  // A tight single-lane tunnel bend (radius 22 m, 3.9 m wide, like the KGS ramps) at 10 m under ground
  // at 20 m: a bus placed straight on the bend has its rear axles off the carriageway.
  const pts: number[] = [];
  const zs: number[] = [];
  for (let a = 0; a <= 180; a += 10) {
    const r = (a * Math.PI) / 180;
    pts.push(Math.sin(r) * 22, -Math.cos(r) * 22 + 22);
    zs.push(10);
  }
  const data = makeMap({ roads: [{ pts, z: zs, tunnel: true, width: 3.9 }], ground: () => 20 });
  const col = world(data);
  // Rear axle at the 45 degree point, facing along the tangent.
  const r = Math.PI / 4;
  const run = drive(spec, col, [Math.sin(r) * 22, -Math.cos(r) * 22 + 22, Math.PI / 2 - r, 10], 6, () => ({ throttle: 0.3 }));
  const zs2 = run.p.pose.sections.map((sp) => sp.z ?? 0);
  check(`curved tunnel: every section stays underground (max z, ${zs2.length} sections)`, maxOf(zs2), 9.5, 10.5, 'm');
}

function wallSlide(spec: BusSpec, kind: 'parapet' | 'tunnel'): void {
  // A wide (16 m) viaduct or tunnel running north; its parapets stand at x = +-8.6 m, its tunnel walls
  // (as the world draws them) at +-8.9 m.
  const roads = [{ pts: [0, -400, 0, 400], z: [10, 10], width: 16, bridge: kind === 'parapet', tunnel: kind === 'tunnel' }];
  const data = makeMap(kind === 'parapet' ? { roads } : { roads, ground: () => 20 });
  const col = world(data);
  const WALL = kind === 'parapet' ? 8.6 : 8.9;
  const ang = (20 * Math.PI) / 180;
  // Placed at 20 degrees with the front right corner 1 m short of the right-hand wall, at 30 km/h.
  const s0 = spec.sections[0];
  const x0 = WALL - 1 - (s0.axleFromFront * Math.sin(ang) + (spec.width / 2) * Math.cos(ang));
  const p = new BusPhysics(spec);
  const c = new BusControls();
  p.reset(x0, -300, ang, 10);
  p.pose.speed = 30 / 3.6;
  const maxCornerX = () => {
    let m = -Infinity;
    for (let i = 0; i < p.pose.sections.length; i++) {
      const sp = p.pose.sections[i];
      const ss = spec.sections[i];
      const fx = Math.sin(sp.heading);
      const fy = Math.cos(sp.heading);
      for (const u of [ss.axleFromFront, ss.axleFromFront - ss.length]) for (const w of [-spec.width / 2, spec.width / 2]) m = Math.max(m, sp.x + fx * u + fy * w);
    }
    return m;
  };
  let firstTouch = NaN;
  let lastTouch = NaN;
  let worst = -Infinity;
  let minV = Infinity;
  let y4 = 0;
  let v6 = 0;
  for (let t = 0; t < 8; t += DT) {
    // 0-4 s: throttle with the wheel held into the wall. Then steer away for 0.8 s and straighten up.
    const i = input(t < 4 ? { throttle: 0.4, steer: 0.6 } : t < 4.8 ? { throttle: 0.5, steer: -0.5 } : { throttle: 0.5 });
    c.update(DT, i, p.pose);
    p.update(DT, i, c, col);
    const mx = maxCornerX();
    worst = Math.max(worst, mx);
    const touching = mx > WALL - 0.05;
    if (touching && !Number.isFinite(firstTouch)) firstTouch = t;
    if (touching) lastTouch = t;
    if (Number.isFinite(firstTouch) && t > firstTouch + 0.5 && t < 4) minV = Math.min(minV, p.pose.speed);
    if (t < 4) y4 = p.pose.y;
    if (t < 6) v6 = p.pose.speed;
  }
  const label = `${kind}`;
  check(`wall slide (${label}): hit the wall`, Number.isFinite(firstTouch) ? 1 : 0, 1, 1, '');
  check(`wall slide (${label}): min speed scraping with the wheel held in`, minV, 1, 20, 'm/s');
  check(`wall slide (${label}): distance along the wall in 4 s`, y4 + 300, 12, 60, 'm');
  check(`wall slide (${label}): clear of the wall after steering away`, lastTouch - 4, -4, 2, 's');
  check(`wall slide (${label}): moving 2 s after steering away`, v6, 2, 20, 'm/s');
  check(`wall slide (${label}): never through the wall (max corner x)`, worst, 0, WALL + 0.05, 'm');
}

/**
 * Tunnel tubes as the world draws them: a carriageway splitting off another shares one hall with it (no
 * wall between them while the other's edge is within ~3.6 m of the wall line), a nose wall closes the
 * wedge where they part, and beside an underground platform the wall stands past its far edge.
 */
function tubeRules(): void {
  const s10 = Math.sin((10 * Math.PI) / 180);
  const c10 = Math.cos((10 * Math.PI) / 180);
  const data = makeMap({
    roads: [
      { pts: [0, -200, 0, -40, 0, 200], z: [10, 10, 10], width: 7.4, tunnel: true, kind: 7 },
      { pts: [0, -40, 200 * s10, -40 + 200 * c10], z: [10, 10], width: 7.4, tunnel: true, kind: 7 },
      { pts: [300, -200, 300, 200], z: [10, 10], width: 7.4, tunnel: true, kind: 7 },
      { pts: [-300, -200, -300, 200], z: [10, 10], width: 7.4, tunnel: true, kind: 7 },
      { pts: [-288, -200, -288, 200], z: [10, 10], width: 7.4, tunnel: true, kind: 7 },
    ],
    platforms: [
      { pts: [303.9, -30, 309, -30, 309, 30, 303.9, 30], underground: true },
      { pts: [-295.9, -30, -292.1, -30, -292.1, 30, -295.9, 30], underground: true },
    ],
    ground: () => 30,
    bounds: [-400, -400, 400, 400],
  });
  const col = world(data);
  const W = col.walls;
  // Walls of a road crossing the line x = const between y0 and y1 (or the horizontal line y = const).
  const wallsAcross = (road: number, x0: number, x1: number, y: number) => {
    let n = 0;
    for (let i = 0; i < W.count; i++) {
      if (W.road[i] !== road) continue;
      const ya = W.ay[i];
      const yb = W.by[i];
      if ((ya - y) * (yb - y) > 0 || ya === yb) continue;
      const x = W.ax[i] + ((W.bx[i] - W.ax[i]) * (y - ya)) / (yb - ya);
      if (x > x0 && x < x1) n++;
    }
    return n;
  };
  const bWest = (y: number) => (y + 40) * (s10 / c10) - 3.7 / c10; // the split road's left edge
  check('tube: wall along the far side of the through tube', wallsAcross(0, -5, -4, 101), 1, 1, '');
  check('tube: wall on the near side well past the split', wallsAcross(0, 4, 5, 151), 1, 1, '');
  let inHall = 0;
  for (const y of [-30, -10, 0, 10, 20]) inHall += wallsAcross(0, 1, bWest(y) - 0.2, y) + wallsAcross(1, 1, bWest(y) - 0.2, y);
  check('tube: no wall in the shared hall between the two carriageways', inHall, 0, 0, '');
  let nose = 0;
  for (let i = 0; i < W.count; i++) if (W.road[i] === 0 && Math.abs(W.bx[i] - W.ax[i]) > 2 * Math.abs(W.by[i] - W.ay[i]) && W.ax[i] > 3 && W.ay[i] > 0) nose++;
  check('tube: a nose wall closes the wedge where the carriageways part', nose, 1, 2, '');
  let px = NaN;
  for (let i = 0; i < W.count; i++) if (W.road[i] === 2 && W.ax[i] > 300 && Math.abs(W.ay[i]) < 10) px = W.ax[i];
  check('tube: wall beside an underground platform stands past its far edge', px - 309, 0.4, 1.5, 'm');
  check('tube: wall away from the platform at the usual line', wallsAcross(2, 304.5, 304.7, 101), 1, 1, '');
  // An island platform between two tubes 12 m apart: one shared hall, no wall either side of it.
  check('tube: no wall beside an island platform (shared hall)', wallsAcross(3, -299, -289, 1) + wallsAcross(4, -299, -289, 1), 0, 0, '');
  check('tube: walls between the two tubes again past the island platform', wallsAcross(3, -299, -289, 101) + wallsAcross(4, -299, -289, 101), 2, 2, '');
}

function grade(spec: BusSpec): void {
  // A 6 % ramp: 0 m at y = 0 up to 30 m at y = 500 (on an embankment), then flat.
  const data = makeMap({ roads: [{ pts: [0, -100, 0, 0, 0, 500, 0, 700], z: [0, 0, 30, 30], width: 8 }] });
  const col = world(data);
  const zAt = (y: number) => Math.max(0, Math.min(30, y * 0.06));
  const rollFrom = (secs: number, inp: Partial<DriveInput>, v0 = 0) => {
    const r = drive(spec, col, [0, 200, 0, zAt(200)], secs, (t, p) => {
      if (t === 0 && v0) p.pose.speed = v0;
      return inp;
    });
    return r;
  };
  // Coasting uphill from 36 km/h vs on the flat.
  const up = rollFrom(4, { gear: 'N' }, 10);
  const flat = drive(spec, col, [0, 520, 0, 30], 4, (t, p) => {
    if (t === 0) p.pose.speed = 10;
    return { gear: 'N' };
  });
  const decelUp = (10 - up.p.pose.speed) / 4;
  const decelFlat = (10 - flat.p.pose.speed) / 4;
  check('grade: extra decel coasting up 6 % (g sin)', decelUp - decelFlat, 0.5, 0.65, 'm/s2');
  check('grade: z follows the ramp', Math.abs((up.p.pose.z ?? 0) - zAt(up.p.pose.y)), 0, 0.15, 'm');
  check('grade: pitch matches 6 %', Math.tan(up.p.grade) * 100, 5.5, 6.5, '%');
  // Parked on the hill: rolls back without brakes, park brake holds.
  const roll = rollFrom(6, { gear: 'N' });
  check('grade: rolls back with no brake (speed)', roll.p.pose.speed, -10, -0.5, 'm/s');
  const pb = drive(spec, col, [0, 200, 0, zAt(200)], 6, (t) => ({ gear: 'N', pressed: new Set(t === 0 ? ['parkBrake' as const] : []) }));
  check('grade: park brake holds on 6 %', Math.abs(pb.p.pose.speed), 0, 0.01, 'm/s');
  // Hill-start assist: stop on the hill, release the brake, throttle a second later: no roll-back.
  let y0 = 0;
  let minY = Infinity;
  const ha = drive(spec, col, [0, 200, 0, zAt(200)], 6, (t, p) => {
    if (t < 1) return { brake: 1 };
    if (t < 1 + DT) y0 = p.pose.y;
    if (t > 1) minY = Math.min(minY, p.pose.y);
    return t < 2 ? {} : { throttle: 0.6 };
  });
  check('grade: hill-start assist, roll-back before pulling away', y0 - minY, 0, 0.05, 'm');
  check('grade: hill-start assist, then pulls away uphill', ha.p.pose.y - y0, 0.5, 100, 'm');
  // Hill start at full throttle.
  const hs = rollFrom(15, { throttle: 1 });
  check('grade: full-throttle hill start, speed after 15 s', hs.p.pose.speed * 3.6, 25, 60, 'km/h');
}

function river(spec: BusSpec): void {
  // Land at 3 m with a riverside road; the river (water at 0.5 m, bed at -4 m) east of x = 40.
  const data = makeMap({
    roads: [{ pts: [0, -300, 0, 300], z: [3, 3], width: 7 }],
    water: [[40, -400, 400, -400, 400, 400, 40, 400]],
    ground: (x) => (x < 30 ? 3 : x < 45 ? 3 - ((x - 30) / 15) * 7 : -4),
  });
  const col = world(data);
  const r = drive(spec, col, [0, 0, Math.PI / 2, 3], 12, (t) => ({ throttle: t < 6 ? 0.6 : 0 }));
  const splash = r.out.find((s) => s.water);
  check('river: splash when the bus goes under the water level', splash ? 1 : 0, 1, 1, '');
  check('river: front axle at/below the water (+0.3) at the splash', splash ? splash.zf : NaN, -5, 0.81, 'm');
  check('river: recovered onto the road (|x|)', Math.abs(r.p.pose.x), 0, 4, 'm');
  check('river: recovered at road level (z)', r.p.pose.z ?? 0, 2.9, 3.1, 'm');
}

/** Every section's road height over a run (rear axles). */
function sectionZs(p: BusPhysics): number[] {
  return p.pose.sections.map((sp) => sp.z ?? 0);
}

function levelsAfterReset(spec: BusSpec): void {
  // A viaduct deck at 10 m that starts at y = 0 (no ramp in the data), over a street at ground level
  // (y = -8, under where the trailers are). A bus placed with its front section on the deck and the
  // rest over the street: every section is on the deck's level, and stays there driving on.
  const data = makeMap({
    roads: [
      { pts: [0, 0, 0, 300], z: [10, 10], bridge: true, width: 7.4 },
      { pts: [-300, -8, 300, -8], z: [0, 0], width: 7 },
    ],
  });
  const col = world(data);
  let minZ = Infinity;
  let maxZ = -Infinity;
  let first: number[] = [];
  const r = drive(spec, col, [0, 3, 0, 10], 10, (t, p) => {
    const zs = sectionZs(p);
    if (t === 0) first = zs;
    else {
      minZ = Math.min(minZ, ...zs);
      maxZ = Math.max(maxZ, ...zs);
    }
    return { throttle: 0.4 };
  });
  check(`reset onto a deck edge: sections on the deck's level (min z, ${spec.sections.length} sections)`, minOf(first.length ? first : [NaN]), 9.4, 10.1, 'm');
  check('reset onto a deck edge: no section drops driving on (min z)', minZ, 9.4, 10.1, 'm');
  check('reset onto a deck edge: no section climbs (max z)', maxZ, 9.9, 10.6, 'm');
  check('reset onto a deck edge: drove onto the deck', r.p.pose.y, 20, 300, 'm');
  // Backspace (reset in place) at the same spot: back on the deck, every section on its level.
  const p = new BusPhysics(spec);
  const c = new BusControls();
  p.reset(0.5, 3, 0.05, 10);
  p.update(DT, input(), c, col);
  p.reset(p.pose.x, p.pose.y, p.pose.heading);
  p.update(DT, input(), c, col);
  check('Backspace on a deck edge: every section on the deck (min z)', minOf(sectionZs(p)), 9.4, 10.1, 'm');
}

function noDriveOffEdge(spec: BusSpec): void {
  // A viaduct deck at 10 m with a gap in its east parapet (a bus route's GTFS line runs off the deck
  // there, which opens the wall): driving through the gap, the bus stops at the deck's edge instead of
  // dropping 10 m, and can back away again.
  const ang = Math.atan2(12, 140);
  const data = makeMap({
    roads: [{ pts: [0, -300, 0, 300], z: [10, 10], bridge: true, width: 7.4 }],
    routes: [{ pts: [0, -200, 12, -60], z: [10, 10] }],
  });
  const col = world(data);
  let maxFX = -Infinity;
  const r = drive(spec, col, [-15 * Math.tan(ang), -215, ang, 10], 22, (_t, p) => {
    const fx = p.pose.x + Math.sin(p.pose.heading) * spec.wheelbase;
    maxFX = Math.max(maxFX, fx);
    return { throttle: 0.45 };
  });
  check("deck edge with no parapet: doesn't drop off (min z, all sections)", minOf(r.out.map((s) => s.z).concat(sectionZs(r.p))), 9.9, 10.1, 'm');
  check('deck edge with no parapet: front axle stops at the edge (max x)', maxFX, 3.0, 3.7 + 0.6 + 0.2, 'm');
  const late = r.out.filter((s) => s.t > 18);
  check('deck edge with no parapet: held there (progress in the last 4 s)', Math.hypot(late[late.length - 1].x - late[0].x, late[late.length - 1].y - late[0].y), 0, 4, 'm');
  const y0 = r.p.pose.y;
  for (let t = 0; t < 4; t += DT) {
    const i = input({ gear: 'R', throttle: 0.5 });
    r.c.update(DT, i, r.p.pose);
    r.p.update(DT, i, r.c, col);
  }
  check('deck edge with no parapet: can back away from the edge', y0 - r.p.pose.y, 1, 40, 'm');
  // Placed in mid-air beside the deck (nothing under either axle of the front section): it falls.
  const f = drive(spec, col, [-12, -150, 0, 10], 4, () => ({}));
  check('placed in mid-air beside the deck: falls to the ground (z)', f.p.pose.z ?? 0, -0.1, 0.1, 'm');
}

function stationBays(spec: BusSpec): void {
  // A busway (7.4 m, at 10 m) with a platform whose kerb is 8.2 m from the centreline (PA Hospital on a
  // viaduct, Mater Hill in a cutting): along the bay, 1.6 m off the kerb (beyond the busway's own
  // surface), the bus stays at the busway's level.
  for (const kind of ['viaduct', 'cutting'] as const) {
    const data = makeMap({
      roads: [{ pts: [0, -300, 0, 300], z: [10, 10], bridge: kind === 'viaduct', width: 7.4, kind: 7 }],
      platforms: [{ pts: [8.2, -40, 12, -40, 12, 40, 8.2, 40], underground: false }],
      ground: kind === 'viaduct' ? () => 3 : (x) => 10 + Math.min(6, Math.max(0, Math.abs(x) - 4.2) * 0.5),
    });
    const col = world(data);
    const r = drive(spec, col, [6.6, -55, 0, 10], 8, () => ({ throttle: 0.3 }));
    const zs = r.out.map((s) => s.z).concat(sectionZs(r.p));
    check(`station bay (${kind}): stays at the busway's level (min z)`, minOf(zs), 9.9, 10.1, 'm');
    check(`station bay (${kind}): stays at the busway's level (max z)`, maxOf(zs), 9.9, 10.1, 'm');
    check(`station bay (${kind}): drove along the bay`, r.p.pose.y + 55, 8, 100, 'm');
    check(`station bay (${kind}): the bay is drivable and has a surface`, col.surface(6.6, 0, 10, 2.2).z, 9.95, 10.05, 'm');
  }
}

function stepsAndGrades(spec: BusSpec): void {
  // A 0.8 m step down where two ways meet at different heights (a data join): followed, not a thump.
  {
    const data = makeMap({
      roads: [
        { pts: [0, -300, 0, 0], z: [1, 1], width: 7 },
        { pts: [0, 0, 0, 300], z: [0.2, 0.2], width: 7 },
      ],
    });
    const col = world(data);
    let maxImpact = 0;
    const r = drive(spec, col, [-1.75, -60, 0, 1], 8, (t, p) => {
      if (t === 0) p.pose.speed = 11;
      return { throttle: 0.4 };
    });
    for (const s of r.out) maxImpact = Math.max(maxImpact, s.hit ? 99 : 0);
    const p = new BusPhysics(spec);
    const c = new BusControls();
    p.reset(-1.75, -60, 0, 1);
    p.pose.speed = 11;
    for (let t = 0; t < 8; t += DT) {
      const i = input({ throttle: 0.4 });
      c.update(DT, i, p.pose);
      maxImpact = Math.max(maxImpact, p.update(DT, i, c, col).impact);
    }
    check('0.8 m step down at 40 km/h: no impact', maxImpact, 0, 0.5, 'm/s');
    check('0.8 m step down: on the lower road after it', p.pose.z ?? 0, 0.15, 0.25, 'm');
  }
  // An 8 % climb mapped with a vertex every 6 m: the height follows the grade (no steps a few metres
  // past each vertex), and so it does past a flat side street crossing it.
  const pts: number[] = [];
  const zs: number[] = [];
  for (let y = -300; y <= 300; y += 6) {
    pts.push(0, y);
    zs.push(30 + y * 0.08);
  }
  const data = makeMap({
    roads: [
      { pts, z: zs, width: 14 },
      { pts: [-150, 0.3, 150, 0.3], z: [30.02, 30.02], width: 7.4 },
    ],
  });
  const col = world(data);
  let worst = 0;
  for (const lat of [-1.75, -5.35]) {
    for (const v0 of [4, 11]) {
      drive(spec, col, [lat, -60, 0, 30 - 60 * 0.08], 120 / v0 / 1.0 > 20 ? 20 : 120 / v0, (t, p) => {
        if (t === 0) p.pose.speed = v0;
        if (t > 0.5) worst = Math.max(worst, Math.abs((p.pose.z ?? 0) - (30 + p.pose.y * 0.08)));
        return { throttle: p.pose.speed < v0 ? 0.5 : 0 };
      });
    }
  }
  check('8 % grade with vertices and a side street: height error', worst, 0, 0.08, 'm');
}

async function main(): Promise<void> {
  const S = await specs();
  console.log('--- rigid ---');
  const tc = turningCircle(S.rigid);
  check('kerb-to-kerb turning circle (diameter)', tc.kerb, 18.5, 23, 'm');
  check('wall-to-wall turning circle (diameter)', tc.wall, 22, 26.5, 'm');
  console.log(`     rear axle circle diameter ${tc.rear.toFixed(2)} m`);
  check('0-50 km/h', zeroTo50(S.rigid), 10, 16, 's');
  check('stopping distance from 60 km/h', stopping(S.rigid, 60), 30, 45, 'm');
  check('governed top speed', topSpeed(S.rigid), 77, 81, 'km/h');
  interlocks(S.rigid);
  frameRateIndependence(S.rigid);
  colliderBox(S.rigid);
  console.log('--- 3D (rigid) ---');
  tubeRules();
  viaduct(S.rigid);
  tunnel(S.rigid);
  tunnelCurve(S.rigid);
  wallSlide(S.rigid, 'parapet');
  wallSlide(S.rigid, 'tunnel');
  grade(S.rigid);
  river(S.rigid);
  levelsAfterReset(S.rigid);
  noDriveOffEdge(S.rigid);
  stationBays(S.rigid);
  stepsAndGrades(S.rigid);
  console.log('--- glider ---');
  check('0-50 km/h', zeroTo50(S.glider), 10, 16, 's');
  console.log('--- metro ---');
  const mt = turningCircle(S.metro);
  check('kerb-to-kerb turning circle (diameter)', mt.kerb, 18.5, 26, 'm');
  check('0-50 km/h', zeroTo50(S.metro), 9, 16, 's');
  check('stopping distance from 60 km/h', stopping(S.metro, 60), 30, 45, 'm');
  check('governed top speed', topSpeed(S.metro), 67, 71, 'km/h');
  const u = metroUTurn(S.metro);
  check('U-turn + reverse: max joint angle', u.maxJoint, 10, 50.01, 'deg');
  check('U-turn: state finite', u.finite ? 1 : 0, 1, 1, '');
  console.log('--- 3D (metro) ---');
  viaduct(S.metro);
  tunnel(S.metro);
  tunnelCurve(S.metro);
  wallSlide(S.metro, 'parapet');
  wallSlide(S.metro, 'tunnel');
  grade(S.metro);
  levelsAfterReset(S.metro);
  noDriveOffEdge(S.metro);
  stationBays(S.metro);
  stepsAndGrades(S.metro);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

if (typeof window === 'undefined') void main();

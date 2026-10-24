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
    routes: [],
    platforms: [],
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
  viaduct(S.rigid);
  tunnel(S.rigid);
  tunnelCurve(S.rigid);
  grade(S.rigid);
  river(S.rigid);
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
  grade(S.metro);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

if (typeof window === 'undefined') void main();

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
import { buildCollider } from './collider';

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

function colliderBox(spec: BusSpec): void {
  // A 20 x 20 m block 30 m ahead, plus a road that does not touch it.
  const sq = (x: number, y: number, s: number) => new Float32Array([x, y, x + s, y, x + s, y + s, x, y + s]);
  const data = {
    bounds: [-200, -200, 200, 200],
    roads: [{ kind: 3, width: 7, lanes: 2, oneway: false, bridge: false, tunnel: false, layer: 0, link: false, bus: false, pts: new Float32Array([-100, -100, -100, 100]) }],
    rail: [],
    signals: new Float32Array(0),
    crossings: new Float32Array(0),
    buildings: [
      { height: 10, minHeight: 0, kind: 0, part: false, pts: sq(-10, 30, 20) },
      // An awning over the road: must be ignored.
      { height: 6, minHeight: 0, kind: 0, part: false, pts: sq(-104, 0, 8) },
    ],
    areas: [],
    water: [],
    trees: new Float32Array(0),
    stops: [],
    routes: [],
  } as unknown as MapData;
  const col = buildCollider(data);
  check('collider: awning over road excluded', col.stats.solid, 1, 1, '');
  const { p, c } = sim(spec);
  let maxImpact = 0;
  let maxFront = -Infinity;
  for (let t = 0; t < 20; t += DT) {
    const i = input({ throttle: 1 });
    c.update(DT, i, p.pose);
    const r = p.update(DT, i, c, col);
    maxImpact = Math.max(maxImpact, r.impact);
    maxFront = Math.max(maxFront, p.pose.y + spec.sections[0].axleFromFront);
  }
  check('collider: front never past the wall', maxFront, 29.5, 30.05, 'm');
  check('collider: impact reported', maxImpact, 3, 30, 'm/s');
  // Snap back to the road.
  p.reset(p.pose.x, p.pose.y, p.pose.heading);
  check('reset: snapped next to the road', Math.abs(p.pose.x - -100), 0, 3.6, 'm');
}

async function main(): Promise<void> {
  const S = await specs();
  console.log('--- rigid ---');
  const tc = turningCircle(S.rigid);
  check('kerb-to-kerb turning circle (diameter)', tc.kerb, 19.5, 23, 'm');
  check('wall-to-wall turning circle (diameter)', tc.wall, 22, 26.5, 'm');
  console.log(`     rear axle circle diameter ${tc.rear.toFixed(2)} m`);
  check('0-50 km/h', zeroTo50(S.rigid), 10, 16, 's');
  check('stopping distance from 60 km/h', stopping(S.rigid, 60), 30, 45, 'm');
  check('governed top speed', topSpeed(S.rigid), 77, 81, 'km/h');
  interlocks(S.rigid);
  frameRateIndependence(S.rigid);
  colliderBox(S.rigid);
  console.log('--- glider ---');
  check('0-50 km/h', zeroTo50(S.glider), 10, 16, 's');
  console.log('--- metro ---');
  const mt = turningCircle(S.metro);
  check('kerb-to-kerb turning circle (diameter)', mt.kerb, 19, 26, 'm');
  check('0-50 km/h', zeroTo50(S.metro), 9, 16, 's');
  check('stopping distance from 60 km/h', stopping(S.metro, 60), 30, 45, 'm');
  check('governed top speed', topSpeed(S.metro), 67, 71, 'km/h');
  const u = metroUTurn(S.metro);
  check('U-turn + reverse: max joint angle', u.maxJoint, 10, 50.01, 'deg');
  check('U-turn: state finite', u.finite ? 1 : 0, 1, 1, '');
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

if (typeof window === 'undefined') void main();

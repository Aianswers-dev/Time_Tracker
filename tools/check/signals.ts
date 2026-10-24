/**
 * Traffic-signal checks over the whole map (no browser):
 *
 *   npx -y tsx tools/check/signals.ts [--routes] [--verbose]
 *
 * 1. Every signalised junction: every incoming arm, asked from its stop line
 *    the way a vehicle arrives (signalStateAt with direction and level), sees
 *    green within one cycle, and no two arms that cross or merge (not roughly
 *    opposite) are green at the same time.
 * 2. Every lane of the AI car graph into a signalised node sees green within
 *    a cycle (the same lookup the AI cars and buses use).
 * 3. With --routes: every route's track signals (both directions), asked the
 *    way the player's guide (and the AI buses, traffic.ts signalPlan) ask, see
 *    green within a cycle; and where the AI cars' junction node is the same
 *    junction, the guide and the cars agree (per cent of a 240 s window).
 *
 * Exits non-zero when a check fails.
 */
import * as THREE from 'three';
import { loadMapNode } from './load';
import { signalsFor, phaseLight } from '../../src/data/signals';
import { CarTraffic } from '../../src/game/cars';
import { trackFor } from '../../src/game/track';
import type { WorldHandle } from '../../src/types';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const data = loadMapNode();
const t0 = performance.now();
const model = signalsFor(data);
console.log(`signal model: ${model.junctions.length} junctions from ${data.signals.length / 2} signal nodes in ${(performance.now() - t0).toFixed(0)} ms`);
let fail = 0;
const STEP = 0.5;
const gb = args.indexOf('--guide-back');
// --guide-back N: the old guide query (lane tangent N m before the stop line, no level); default: approachDir.
const GUIDE_BACK = gb >= 0 ? Number(args[gb + 1]) : -1;

// ---- 1. junction arms
let arms = 0;
let dead = 0;
let conflicts = 0;
let controlled = 0;
const phaseCount = new Map<number, number>();
for (const j of model.junctions) {
  phaseCount.set(j.phases.length, (phaseCount.get(j.phases.length) ?? 0) + 1);
  if (!j.phases.length) continue;
  controlled++;
  const inc = j.arms.filter((a) => a.incoming);
  const green = new Array(inc.length).fill(0);
  for (let t = 0; t < j.cycle; t += STEP) {
    const on: number[] = [];
    inc.forEach((a, i) => {
      const d = Math.min(a.stop + 3, 20);
      const st = model.stateAt(j.x + a.ux * d, j.y + a.uy * d, t, -a.ux, -a.uy, a.z);
      if (st === 'green') {
        green[i]++;
        on.push(i);
      }
    });
    for (let p = 0; p < on.length; p++) {
      for (let q = p + 1; q < on.length; q++) {
        const A = inc[on[p]];
        const B = inc[on[q]];
        if (A.ux * B.ux + A.uy * B.uy > -0.7) {
          conflicts++;
          if (verbose || conflicts <= 10) console.log(`  CONFLICT junction (${j.x.toFixed(0)},${j.y.toFixed(0)}) arms #${A.road} and #${B.road} green together at t=${t}`);
        }
      }
    }
  }
  inc.forEach((a, i) => {
    arms++;
    if (!green[i]) {
      dead++;
      console.log(`  NEVER GREEN junction (${j.x.toFixed(0)},${j.y.toFixed(0)}) arm #${a.road} ${data.roads[a.road].name ?? ''} u(${a.ux.toFixed(2)},${a.uy.toFixed(2)})`);
    }
  });
}
console.log(`junctions: ${controlled} controlled (phases: ${[...phaseCount].sort().map(([k, v]) => `${k}:${v}`).join(' ')}), ${arms} incoming arms, ${dead} never green, ${conflicts} conflicting-green samples`);
if (dead || conflicts) fail++;

// ---- 2. AI car graph
const world: WorldHandle = {
  update() {},
  signalStateAt: (x, y, t, dx, dy, z) => model.stateAt(x, y, t, dx, dy, z),
};
const cars = new CarTraffic(new THREE.Scene(), data, world);
/* eslint-disable @typescript-eslint/no-explicit-any */
const C = cars as any;
let lanes = 0;
let deadLanes = 0;
for (let lane = 0; lane < C.edges.length * 2; lane++) {
  const e = C.edges[lane >> 1];
  if (e.oneway && lane & 1) continue;
  const n = C.endNode(lane);
  const nd = C.nodes[n];
  if (!nd.sig || nd.deg < 3) continue;
  lanes++;
  const [dx, dy] = C.laneEndDir(lane);
  let g = false;
  for (let t = 0; t < 130 && !g; t += STEP) g = cars.signalFor(n, dx, dy, t) !== 'red';
  if (!g) {
    deadLanes++;
    if (verbose || deadLanes <= 10) console.log(`  CAR LANE NEVER GREEN node ${n} (${nd.x.toFixed(0)},${nd.y.toFixed(0)}) dir (${dx.toFixed(2)},${dy.toFixed(2)})`);
  }
}
console.log(`car graph: ${lanes} lanes into signalised nodes, ${deadLanes} never green`);
if (deadLanes) fail++;

// ---- 3. routes
if (args.includes('--routes')) {
  let sigs = 0;
  let deadSigs = 0;
  let pairs = 0;
  let agreeSum = 0;
  const bad: string[] = [];
  const t1 = performance.now();
  // Car lanes (not bus-only edges) by end node.
  const lanesInto = new Map<number, number[]>();
  for (let lane = 0; lane < C.edges.length * 2; lane++) {
    const e = C.edges[lane >> 1];
    if (e.bus || (e.oneway && lane & 1)) continue;
    const n = C.endNode(lane);
    let l = lanesInto.get(n);
    if (!l) lanesInto.set(n, (l = []));
    l.push(lane);
  }
  for (const r of data.routes) {
    const tr = trackFor(r, data);
    const tmp = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
    const jl = cars.junctionsAlong(tr);
    for (const sg of tr.signals) {
      // Asked the way the guide asks (guide.ts): the approach chord into the junction, on the lane's level.
      const z = tr.zAt(sg.s);
      tr.sample(sg.s, tmp);
      const ad = GUIDE_BACK < 0 ? model.approachDir(sg.x, sg.y, z, (q, o) => tr.sample(q, o as typeof tmp), sg.s) : null;
      if (GUIDE_BACK >= 0) tr.sample(sg.s - GUIDE_BACK, tmp);
      const hx = ad ? ad.dx : tmp.hx;
      const hy = ad ? ad.dy : tmp.hy;
      const zq = GUIDE_BACK < 0 ? z : undefined;
      const qx = ad ? ad.x : sg.x;
      const qy = ad ? ad.y : sg.y;
      sigs++;
      let g = false;
      for (let t = 0; t < 130 && !g; t += STEP) g = model.stateAt(qx, qy, t, hx, hy, zq) !== 'red';
      if (!g) {
        deadSigs++;
        console.log(`  ROUTE ${r.id}/${r.dir} signal s=${sg.s.toFixed(0)} (${sg.x.toFixed(0)},${sg.y.toFixed(0)}) never green`);
      }
      // The AI cars' light for the same junction (when its stop line is near this one).
      const gj = model.junctionAt(qx, qy, hx, hy, zq);
      const bj = jl.find((j) => {
        if (!j.sig || Math.abs(j.stopS - sg.s) > 25) return false;
        const nd = C.nodes[j.node];
        return model.junctionAt(nd.x - j.inX * 10, nd.y - j.inY * 10, j.inX, j.inY, nd.z) === gj;
      });
      if (!bj) continue;
      // The car lane into that node that arrives the way the route does, asked as canGo asks.
      let lane = -1;
      let bd = 0.7;
      for (const l of lanesInto.get(bj.node) ?? []) {
        const [lx, ly] = C.laneEndDir(l);
        const d = lx * bj.inX + ly * bj.inY;
        if (d > bd) {
          bd = d;
          lane = l;
        }
      }
      if (lane < 0) continue;
      const [ldx, ldy] = C.laneEndDir(lane);
      const ai = (t: number) => cars.signalFor(bj.node, ldx, ldy, t);
      const guide = (t: number) => model.stateAt(qx, qy, t, hx, hy, zq);
      if (ai(0) === null || guide(0) === null) continue;
      let same = 0;
      let n = 0;
      for (let t = 0; t < 240; t += 1) {
        n++;
        if ((ai(t) === 'red') === (guide(t) === 'red')) same++;
      }
      pairs++;
      agreeSum += same / n;
      if (same / n < 0.9) bad.push(`  DISAGREE ${r.id}/${r.dir}@${sg.s.toFixed(0)} (${sg.x.toFixed(0)},${sg.y.toFixed(0)}) guide vs cars agree ${((100 * same) / n).toFixed(0)}%`);
    }
  }
  for (const b of bad.slice(0, verbose ? bad.length : 15)) console.log(b);
  console.log(`routes: ${sigs} track signals, ${deadSigs} never green; guide vs cars at ${pairs} shared lights: mean agreement ${((100 * agreeSum) / Math.max(1, pairs)).toFixed(1)}%, ${bad.length} below 90% (${((performance.now() - t1) / 1000).toFixed(0)} s)`);
  if (deadSigs) fail++;
}
void phaseLight;
if (fail) {
  console.log('FAILED');
  process.exit(1);
}
console.log('OK');

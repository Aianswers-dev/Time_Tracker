/**
 * Street furniture: traffic signals (with a deterministic phase cycle shared
 * by the lamp shader and signalStateAt), stop lines, pedestrian crossings,
 * street lights that glow at night, railway track and overhead masts, and bus
 * stop shelters.
 */
import * as THREE from 'three';
import { RoadKind } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import { cellInstances } from './instcells';
import type { RoadIndex } from './roadindex';
import { type RI, markMaterial, roadAt, structMaterial } from './roads';
import { U, patch } from './shaders';
import { IdGrid, MASK_WATER, hash1, walk, yieldFrame } from './util';
import { SIGNAL_AMBER, signalsFor, type Light, type SignalJunction } from '../data/signals';

// ---------------------------------------------------------------------------
// Signal timing: junctions, arms and phases come from the shared signal model
// (src/data/signals.ts). Each head carries its phase's window (offset, cycle,
// green start, green length) so the lamp shader and signalStateAt agree.

export type Junction = SignalJunction;
export type { Light };

const SIGNAL_GLSL = /* glsl */ `
uniform float uSignalTime;
varying float vLamp;
varying vec4 vSig;
varying float vGroup;
float sigState(vec4 sg, float group, float t) {
  // sg = (offset, cycle, green start, green length); returns 0 red, 1 amber, 2 green
  float cyc = sg.y;
  float d = mod(mod(t + sg.x, cyc) - sg.z, cyc);
  if (d < sg.w) return 2.0;
  if (d < sg.w + ${SIGNAL_AMBER.toFixed(1)}) return 1.0;
  return 0.0;
}
`;

// ---------------------------------------------------------------------------
// Templates

function headTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'aLamp', size: 1, type: 'f32' }]);
  // housing: 0.34 w x 1.0 h x 0.24 d, front faces local +z (map -y)
  g.box(0, 0, -0.5, 0.5, 1, 0, 0.17, 0.12, -1);
  // backboard
  g.box(0, 0.13, -0.62, 0.62, 1, 0, 0.3, 0.012, -2);
  for (let i = 0; i < 3; i++) {
    const yc = 0.33 - i * 0.33;
    const r = 0.115;
    const n = 10;
    const z = -0.125; // map y; three z = +0.125 (front)
    const c = g.vert(0, yc, z, i);
    let prev = -1;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const v = g.vert(Math.cos(a) * r, yc + Math.sin(a) * r, z, i);
      if (prev >= 0) g.tri(c, prev, v, 0, 0, 1);
      prev = v;
    }
    // visor
    g.box(0, -0.2, yc + 0.125, yc + 0.14, 1, 0, 0.13, 0.08, -1);
  }
  return g.build();
}

function poleTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([]);
  g.cylinder(0, 0, 0, 1, 0.5, 7);
  return g.build();
}

function boxTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([]);
  g.box(0, 0, -0.5, 0.5, 1, 0, 0.5, 0.5);
  return g.build();
}

/** Street light: pole 9 m, outreach arm toward local +x, luminaire at the end. */
function streetLightTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'aGlow', size: 1, type: 'f32' }]);
  g.cylinder(0, 0, 0, 9, 0.11, 6, 0);
  g.beam(0, 8.8, 0, 2.4, 9.25, 0, 0.05, 0);
  g.box(2.55, 0, 9.12, 9.3, 1, 0, 0.42, 0.16, 0);
  // lens (glows at night)
  const a = g.vert(2.15, 9.11, -0.13, 1);
  const b = g.vert(2.95, 9.11, -0.13, 1);
  const c = g.vert(2.95, 9.11, 0.13, 1);
  const d = g.vert(2.15, 9.11, 0.13, 1);
  g.quad(a, b, c, d, 0, -1, 0);
  return g.build();
}

function shelterTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'color', size: 3, type: 'u8', normalized: true }]);
  const steel = [58, 62, 66];
  const glass = [120, 140, 150];
  const ad = [235, 235, 225];
  // posts
  for (const x of [-1.9, 1.9]) for (const y of [-0.7, 0.6]) g.box(x, y, 0, 2.6, 1, 0, 0.04, 0.04, ...steel);
  // roof
  g.box(0, -0.05, 2.6, 2.72, 1, 0, 2.1, 0.95, ...steel);
  // back glass panel (map +y is the back)
  g.box(0, 0.62, 0.15, 2.4, 1, 0, 1.85, 0.015, ...glass);
  // advertising panel at one end
  g.box(1.95, 0, 0.1, 2.3, 0, 1, 0.65, 0.06, ...ad);
  // bench
  g.box(0, 0.35, 0.45, 0.5, 1, 0, 1.2, 0.18, ...steel);
  // stop sign pole at the kerb
  g.cylinder(-2.6, -0.9, 0, 2.8, 0.04, 5, 200, 200, 200);
  g.box(-2.6, -0.9, 2.1, 2.75, 1, 0, 0.22, 0.02, 250, 250, 245);
  return g.build();
}

// ---------------------------------------------------------------------------

export interface Signals {
  junctions: Junction[];
  grid: IdGrid;
  /**
   * Light for a vehicle at (x, y) travelling (dirX, dirY) (unit, map coords) on
   * level z, from the shared signal model: the junction on that level whose
   * arms fit the travel direction, and the arm pointing back along it. Null
   * where no signal controls the approach.
   */
  stateAt(x: number, y: number, t: number, dirX?: number, dirY?: number, z?: number): Light | null;
}

export async function buildFurniture(ctx: Ctx, roads: { infos: RI[]; index: RoadIndex }, progress: (f: number) => void): Promise<Signals> {
  const { data, R } = ctx;
  const index = roads.index;
  const infos = roads.infos;
  const marks = new MeshGeo([{ name: 'aMark', size: 3, type: 'f32' }]);

  // ---- junctions, arms and phases from the shared signal model
  const model = signalsFor(data);
  const junctions: Junction[] = model.junctions;
  interface Head {
    x: number;
    y: number;
    h: number;
    fx: number;
    fy: number;
    j: number;
    group: number;
  }
  const heads: Head[] = [];
  const poles: { x: number; y: number; z: number; h: number }[] = [];
  const arms: { x: number; y: number; dx: number; dy: number; len: number; h: number }[] = [];

  const stopLine = (sx: number, sy: number, tx: number, ty: number, o0: number, o1: number, h: number) => {
    // across the lanes; t = travel direction, left normal l = (-ty, tx)
    const lx = -ty;
    const ly = tx;
    const w = 0.22;
    const a = marks.vert(sx + lx * o0 - tx * w, h, sy + ly * o0 - ty * w, 0, 0, 0);
    const b = marks.vert(sx + lx * o1 - tx * w, h, sy + ly * o1 - ty * w, 0, 0, 0);
    const c = marks.vert(sx + lx * o1 + tx * w, h, sy + ly * o1 + ty * w, 0, 0, 0);
    const d = marks.vert(sx + lx * o0 + tx * w, h, sy + ly * o0 + ty * w, 0, 0, 0);
    marks.up(a, b, c, d);
  };

  junctions.forEach((jn, ji) => {
    if (!jn.phases.length) return;
    for (const a of jn.arms) {
      // (an approach no signal faces has no light: src/data/signals.ts)
      if (!a.incoming || a.phase < 0) continue;
      // Stop line clear of the widest other road, in the open (not inside a tunnel portal).
      const ds = Math.min(a.stop, a.open - 1);
      if (ds < 4) continue;
      const lift = infos[a.road].lift;
      const sx = a.ox + a.ux * ds;
      const sy = a.oy + a.uy * ds;
      const tx = -a.ux;
      const ty = -a.uy;
      const lx = -ty;
      const ly = tx;
      const group = a.phase;
      // stop line across the incoming lanes (left half for two-way roads)
      if (a.kind !== RoadKind.Service) stopLine(sx, sy, tx, ty, a.oneway ? -a.hw + 0.3 : 0.2, a.hw - 0.3, a.z + lift + 0.005);
      // primary pole on the left kerb
      const px = sx + lx * (a.hw + 0.9);
      const py = sy + ly * (a.hw + 0.9);
      if (index.penetrationZ(px, py, a.z, 3) > -0.3) continue;
      const base = a.z + 0.15;
      poles.push({ x: px, y: py, z: base, h: 4.6 });
      heads.push({ x: px, y: py, h: base + 3.4, fx: a.ux, fy: a.uy, j: ji, group });
      const multi = (a.oneway ? a.lanes : a.lanes / 2) >= 2 || a.kind <= RoadKind.Secondary;
      if (multi) {
        const len = Math.min(a.oneway ? a.hw * 1.3 : a.hw * 0.9, 9);
        poles.push({ x: px, y: py, z: base, h: 6.4 });
        arms.push({ x: px, y: py, dx: -lx, dy: -ly, len, h: base + 6.2 });
        heads.push({ x: px - lx * len, y: py - ly * len, h: base + 5.6, fx: a.ux, fy: a.uy, j: ji, group });
      }
      // far-side right pole (across the junction) for major roads
      if (a.kind <= RoadKind.Secondary) {
        // (across the box, not as far out as a set-back stop line)
        const df = Math.min(ds, 22);
        const fx = a.ox - a.ux * df - lx * (a.oneway ? a.hw + 0.9 : 1.5);
        const fy = a.oy - a.uy * df - ly * (a.oneway ? a.hw + 0.9 : 1.5);
        if (index.penetrationZ(fx, fy, a.z, 3) < -0.3) {
          poles.push({ x: fx, y: fy, z: base, h: 4.6 });
          heads.push({ x: fx, y: fy, h: base + 3.4, fx: a.ux, fy: a.uy, j: ji, group });
        }
      }
    }
  });
  progress(0.25);
  await yieldFrame();

  // ---- signal meshes
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const struct = structMaterial(ctx, 'furn');
  {
    const poleMat = patch(new THREE.MeshLambertMaterial({ color: 0x8c9294 }), { key: 'pole' });
    const pmM = new Float32Array(poles.length * 16);
    poles.forEach((p, i) => {
      m4.makeScale(0.2, p.h, 0.2).setPosition(p.x, p.z, -p.y);
      m4.toArray(pmM, i * 16);
    });
    const amM = new Float32Array(arms.length * 16);
    arms.forEach((a, i) => {
      const ang = Math.atan2(a.dy, a.dx); // local +x -> map direction (dx, dy)
      q.setFromAxisAngle(yAxis, ang);
      v.set(a.x + (a.dx * a.len) / 2, a.h, -(a.y + (a.dy * a.len) / 2));
      sc.set(a.len, 0.16, 0.16);
      m4.compose(v, q, sc);
      m4.toArray(amM, i * 16);
    });
    const headMat = patch(new THREE.MeshLambertMaterial({ color: 0x1a1c1e }), {
      key: 'sighead',
      vertexPars: 'attribute float aLamp;\nattribute vec4 iSig;\nattribute float iGroup;\nvarying float vLamp;\nvarying vec4 vSig;\nvarying float vGroup;',
      vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvLamp = aLamp;\nvSig = iSig;\nvGroup = iGroup;']],
      fragmentPars: SIGNAL_GLSL,
      fragment: [
        [
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          `vec3 base = diffuse;
          vec3 lampGlow = vec3(0.0);
          if (vLamp < -1.5) base = vec3(0.02);
          else if (vLamp > -0.5) {
            float st = sigState(vSig, vGroup, uSignalTime);
            float idx = floor(vLamp + 0.5);
            vec3 lc = idx < 0.5 ? vec3(1.0, 0.08, 0.04) : idx < 1.5 ? vec3(1.0, 0.55, 0.0) : vec3(0.1, 1.0, 0.45);
            float on = (idx < 0.5 && st < 0.5) || (idx > 0.5 && idx < 1.5 && st > 0.5 && st < 1.5) || (idx > 1.5 && st > 1.5) ? 1.0 : 0.0;
            base = lc * 0.08;
            lampGlow = lc * on * 4.0;
          }
          vec4 diffuseColor = vec4( base, opacity );`,
        ],
        ['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + lampGlow;'],
      ],
    });
    const hgeo = headTemplate();
    const hmM = new Float32Array(heads.length * 16);
    const sigAttr = new Float32Array(heads.length * 4);
    const grpAttr = new Float32Array(heads.length);
    heads.forEach((h, i) => {
      // local +z (front) should face map direction (fx, fy) -> three (fx, 0, -fy)
      const ang = Math.atan2(h.fx, -h.fy);
      q.setFromAxisAngle(yAxis, ang);
      v.set(h.x, h.h, -h.y);
      sc.set(1, 1, 1);
      m4.compose(v, q, sc);
      m4.toArray(hmM, i * 16);
      const j = junctions[h.j];
      const ph = j.phases[h.group];
      sigAttr.set([j.offset, j.cycle, ph.start, ph.green], i * 4);
      grpAttr[i] = h.group;
    });
    // within 1.2 km (a signal head is under a pixel beyond), shadows from those near the shadow box
    const sig = { range: 1200, castShadow: true, receiveShadow: true };
    cellInstances(ctx, poleTemplate(), poleMat, pmM, [], { ...sig, name: 'signal-poles' });
    cellInstances(ctx, boxTemplate(), poleMat, amM, [], { ...sig, name: 'signal-arms' });
    cellInstances(
      ctx,
      hgeo,
      headMat,
      hmM,
      [
        { name: 'iSig', size: 4, data: sigAttr },
        { name: 'iGroup', size: 1, data: grpAttr },
      ],
      { ...sig, name: 'signal-heads' },
    );
  }
  progress(0.35);
  await yieldFrame();

  // ---- pedestrian crossings
  const cr = data.crossings;
  const jgrid = new IdGrid(R[0], R[1], R[2], R[3], 50);
  junctions.forEach((j, i) => jgrid.addPoint(i, j.x, j.y));
  const nearJunction = (x: number, y: number, r: number) => {
    let hit = false;
    jgrid.query(x - r, y - r, x + r, y + r, (i) => {
      if (Math.hypot(junctions[i].x - x, junctions[i].y - y) < r) hit = true;
    });
    return hit;
  };
  for (let i = 0; i < cr.length; i += 2) {
    const x = cr[i];
    const y = cr[i + 1];
    const nr = index.nearest(x, y, 6);
    if (!nr) continue;
    const rd = infos[nr.road].r;
    if (rd.kind === RoadKind.Motorway || rd.kind === RoadKind.Service || rd.tunnel) continue;
    const hw = infos[nr.road].hw;
    const tx = nr.dx;
    const ty = nr.dy;
    const lx = -ty;
    const ly = tx;
    const h = nr.z + infos[nr.road].lift + 0.005;
    const signalised = nearJunction(x, y, 40);
    const P = (a: number, b: number) => [nr.px + tx * a + lx * b, nr.py + ty * a + ly * b];
    const quad = (a0: number, a1: number, b0: number, b1: number) => {
      const p0 = P(a0, b0);
      const p1 = P(a1, b0);
      const p2 = P(a1, b1);
      const p3 = P(a0, b1);
      const ia = marks.vert(p0[0], h, p0[1], 0, 0, 0);
      const ib = marks.vert(p1[0], h, p1[1], 0, 0, 0);
      const ic = marks.vert(p2[0], h, p2[1], 0, 0, 0);
      const id = marks.vert(p3[0], h, p3[1], 0, 0, 0);
      marks.up(ia, ib, ic, id);
    };
    if (signalised) {
      // two parallel lines bounding the walk
      quad(-1.7, -1.45, -hw + 0.2, hw - 0.2);
      quad(1.45, 1.7, -hw + 0.2, hw - 0.2);
    } else {
      for (let b = -hw + 0.4; b < hw - 0.5; b += 1.1) quad(-1.6, 1.6, b, b + 0.55);
    }
  }
  {
    const mm = new THREE.Mesh(marks.build(), markMaterial(ctx));
    mm.name = 'crossings';
    mm.receiveShadow = true;
    mm.frustumCulled = false;
    ctx.root.add(mm);
  }
  progress(0.45);
  await yieldFrame();

  // ---- street lights
  {
    interface SL {
      x: number;
      y: number;
      /** Pole base and road surface heights. */
      z: number;
      zr: number;
      ang: number;
    }
    const lights: SL[] = [];
    for (const ri of infos) {
      const rd = ri.r;
      if (rd.tunnel || rd.kind === RoadKind.Pedestrian || rd.kind === RoadKind.Service || rd.kind === RoadKind.Busway) continue;
      const major = rd.kind <= RoadKind.Tertiary;
      const step = rd.kind === RoadKind.Motorway ? 48 : major ? 36 : 55;
      const sides = rd.kind <= RoadKind.Primary && !rd.oneway && rd.width > 12 ? [1, -1] : [1];
      for (const side of sides) {
        const phase = hash1(ri.i * 3 + side) * step + (side < 0 ? step / 2 : 0);
        for (let s = phase; s < ri.len - 3; s += step) {
          const c = roadAt(ri, s);
          const off = ri.hw + (rd.bridge ? 0.5 : 1.0);
          const x = c.x + c.nx * side * off;
          const y = c.y + c.ny * side * off;
          if (index.penetrationZ(x, y, c.z, 3, ri.i) > -0.4) continue;
          if (!rd.bridge && ctx.mask.has(x, y, MASK_WATER)) continue;
          // arm points back over the road: local +x -> map (-nx*side, -ny*side)
          const dx = -c.nx * side;
          const dy = -c.ny * side;
          lights.push({ x, y, z: c.z + (rd.bridge ? 0.95 : 0.15), zr: c.z, ang: Math.atan2(dy, dx) });
        }
      }
    }
    const tpl = streetLightTemplate();
    const poleMat = patch(new THREE.MeshLambertMaterial({ color: 0x9a9fa2 }), {
      key: 'slight',
      vertexPars: 'attribute float aGlow;\nvarying float vGlow;',
      vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;']],
      fragmentPars: 'varying float vGlow;',
      fragment: [['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + vec3(1.0, 0.82, 0.55) * vGlow * (0.3 + uNight * 5.0);']],
    });
    const glowTex = ctx.tex.glow;
    const glowMat = patch(
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd9a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      {
        key: 'glow',
        fogFade: true,
        projectAnchor: '// W_PROJECT',
        vertex: [
          [
            '#include <project_vertex>',
            `vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float gsz = length(instanceMatrix[0].xyz);
            mvPosition.xy += position.xy * gsz;
            gl_Position = projectionMatrix * mvPosition;
            // W_PROJECT`,
          ],
        ],
        fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * uNight * 1.3, opacity );']],
      },
    );
    const poolMat = patch(
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffc98a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      {
        key: 'pool',
        fogFade: true,
        fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * uNight * 0.75, opacity );']],
      },
    );
    const quadGeo = new THREE.PlaneGeometry(1, 1);
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const CH = 1500;
    const nx = Math.ceil((R[2] - R[0]) / CH);
    const byChunk = new Map<number, SL[]>();
    for (const l of lights) {
      const key = Math.max(0, Math.floor((l.y - R[1]) / CH)) * nx + Math.max(0, Math.min(nx - 1, Math.floor((l.x - R[0]) / CH)));
      let a = byChunk.get(key);
      if (!a) {
        a = [];
        byChunk.set(key, a);
      }
      a.push(l);
    }
    // the poles (a hairline beyond 1.5 km), shadows from those near the shadow box; glows and pools by 1.5 km chunk
    const poleM = new Float32Array(lights.length * 16);
    lights.forEach((l, i) => {
      q.setFromAxisAngle(yAxis, l.ang);
      v.set(l.x, l.z, -l.y);
      m4.compose(v, q, sc.set(1, 1, 1));
      m4.toArray(poleM, i * 16);
    });
    cellInstances(ctx, tpl, poleMat, poleM, [], { name: 'streetlights', range: 1500, castShadow: true, receiveShadow: true });
    for (const [key, ls] of byChunk) {
      const n = ls.length;
      const gm = new THREE.InstancedMesh(quadGeo, glowMat, n);
      const om = new THREE.InstancedMesh(poolGeo, poolMat, n);
      let cx = 0;
      let cz = 0;
      ls.forEach((l, i) => {
        const hx = l.x + Math.cos(l.ang) * 2.55;
        const hz = -l.y - Math.sin(l.ang) * 2.55;
        m4.makeScale(3.2, 3.2, 3.2).setPosition(hx, l.z + 9.0, hz);
        gm.setMatrixAt(i, m4);
        m4.makeScale(17, 1, 17).setPosition(hx, l.zr + 0.25, hz);
        om.setMatrixAt(i, m4);
        cx += l.x;
        cz -= l.y;
      });
      for (const m of [gm, om]) {
        m.computeBoundingSphere();
        m.name = `streetlights-${key}`;
        ctx.root.add(m);
      }
      gm.renderOrder = 5;
      om.renderOrder = 4;
      cx /= n;
      cz /= n;
      ctx.cull.push({ obj: gm, x: cx, z: cz, range: 6000 });
      ctx.cull.push({ obj: om, x: cx, z: cz, range: 2600 });
      nightOnly.push(gm, om);
    }
    ctx.tick.push(() => {
      // glows and light pools only exist after dusk
      if (U.uNight.value < 0.02) for (const o of nightOnly) o.visible = false;
    });
  }
  progress(0.65);
  await yieldFrame();

  // ---- railway overhead masts (the track bed itself is built with the roads)
  {
    const masts: { x: number; y: number; z: number; ang: number }[] = [];
    for (const rl of data.rail) {
      if (rl.tunnel) continue;
      const p = rl.pts;
      if (p.length < 4) continue;
      let vi = 0;
      walk(p, 60, (x, y, dx, dy, s) => {
        // height along the line at s
        let acc = 0;
        let z = rl.z[0];
        for (vi = 0; vi + 1 < rl.z.length; vi++) {
          const L = Math.hypot(p[2 * vi + 2] - p[2 * vi], p[2 * vi + 3] - p[2 * vi + 1]);
          if (acc + L >= s) {
            z = rl.z[vi] + (rl.z[vi + 1] - rl.z[vi]) * ((s - acc) / (L || 1));
            break;
          }
          acc += L;
        }
        const mx = x - dy * 3.2;
        const my = y + dx * 3.2;
        if (index.penetrationZ(mx, my, z, 4) > -0.5 || (!rl.bridge && ctx.mask.has(mx, my, MASK_WATER))) return;
        masts.push({ x: mx, y: my, z, ang: Math.atan2(-dx, dy) });
      }, 20);
    }
    // masts: pole + cantilever over the track
    const mg = new MeshGeo([{ name: 'color', size: 3, type: 'u8', normalized: true }]);
    mg.box(0, 0, 0, 7.2, 1, 0, 0.12, 0.12, 120, 124, 126);
    mg.beam(0, 6.6, 0, 3.6, 6.6, 0, 0.05, 120, 124, 126);
    mg.beam(0, 7.1, 0, 3.6, 6.65, 0, 0.03, 120, 124, 126);
    const mastGeo = mg.build();
    const mastM = new Float32Array(masts.length * 16);
    masts.forEach((m, i) => {
      q.setFromAxisAngle(yAxis, m.ang);
      m4.compose(v.set(m.x, m.z, -m.y), q, sc.set(1, 1, 1));
      m4.toArray(mastM, i * 16);
    });
    cellInstances(ctx, mastGeo, struct, mastM, [], { name: 'rail-masts', range: 1500, castShadow: true });
  }
  progress(0.8);
  await yieldFrame();

  // ---- bus stop shelters
  {
    const tpl = shelterTemplate();
    const items: { x: number; y: number; z: number; ang: number }[] = [];
    // Busway platforms draw their own canopies (src/game/platforms.ts).
    const platformBoxes = data.platforms.map((pf) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pf.pts.length; i += 2) {
        x0 = Math.min(x0, pf.pts[i]); x1 = Math.max(x1, pf.pts[i]);
        y0 = Math.min(y0, pf.pts[i + 1]); y1 = Math.max(y1, pf.pts[i + 1]);
      }
      return [x0 - 12, y0 - 12, x1 + 12, y1 + 12];
    });
    const nearPlatform = (x: number, y: number) => platformBoxes.some((bb) => x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3]);
    for (const st of data.stops) {
      if (nearPlatform(st.x, st.y)) continue;
      const nr = index.nearest(st.x, st.y, 25, (ri) => !infos[ri].r.tunnel && infos[ri].r.kind !== RoadKind.Motorway);
      if (!nr || Math.abs(nr.z - st.z) > 3) continue;
      const ri = infos[nr.road];
      if (ri.r.kind === RoadKind.Busway || ri.r.bus || ri.r.bridge) continue;
      // side of the road the stop is on
      const lx = -nr.dy;
      const ly = nr.dx;
      const side = (st.x - nr.px) * lx + (st.y - nr.py) * ly >= 0 ? 1 : -1;
      const off = ri.hw + 1.3;
      const x = nr.px + lx * side * off;
      const y = nr.py + ly * side * off;
      if (index.penetrationZ(x, y, nr.z, 3, nr.road) > -1 || ctx.mask.near(x, y, 1.5, 4)) continue;
      if (densityAt(ctx, x, y) > 0.6) continue;
      // template back (+map y) faces away from the road: local +y -> side normal
      const bx = lx * side;
      const by = ly * side;
      items.push({ x, y, z: nr.z + 0.15, ang: Math.atan2(-bx, by) });
    }
    const shM = new Float32Array(items.length * 16);
    items.forEach((it, i) => {
      q.setFromAxisAngle(yAxis, it.ang);
      m4.compose(v.set(it.x, it.z, -it.y), q, sc.set(1, 1, 1));
      m4.toArray(shM, i * 16);
    });
    cellInstances(ctx, tpl, struct, shM, [], { name: 'shelters', range: 1500, castShadow: true, receiveShadow: true });
  }
  progress(1);

  const grid = new IdGrid(R[0], R[1], R[2], R[3], 60);
  junctions.forEach((j, i) => grid.addPoint(i, j.x, j.y));
  return {
    junctions,
    grid,
    stateAt(x: number, y: number, t: number, dirX?: number, dirY?: number, z?: number): Light | null {
      return model.stateAt(x, y, t, dirX, dirY, z);
    },
  };
}

const nightOnly: THREE.Object3D[] = [];

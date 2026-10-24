// First-person driver's cab, modelled on photos of the Brisbane fleet:
//  - Volgren Optimus (Volvo B8RLE, Transport for Brisbane / CityGlider):
//    Volvo wrap-around dark-grey dash with the instrument binnacle on the
//    column, door controls on the left wing, switches on the right wing and a
//    console along the right wall, the go card driver console on a stalk to
//    the left of the wheel, a light-grey overhead console (destination sign
//    housing) across the top of the windscreen with a smoked roller blind,
//    an interior convex mirror and the "PLEASE HAIL DRIVER" sticker.
//  - Brisbane Metro (HESS lighTram 25): taller wrap-around windscreen, light
//    overhead console, big roller blind, digital cluster and camera-monitor
//    screens on the A-pillars instead of wing mirrors.
// The windscreen wraps round the corners to slim A-pillars. Everything is
// unlit (baked shading), ~11 draw calls including the saloon.
import * as THREE from 'three';
import type { BusType, Cab, CabState } from '../types';
import { layoutFor, type BodyLayout, type SectionLayout } from './spec';
import { ringAt } from './shell';
import { buildSaloon, DRIVER_PLATFORM } from './saloon';
import { playerSign } from './state';
import { M_INT, M_LEFT, M_RIGHT, mirrorTexture, mirrorUV, paintMirrors } from './mirror';
import {
  DYN, R_CCTV, R_CLUSTER, R_CONSOLE, R_DESTCTL, R_HAIL, R_OVERHEAD, R_RCONSOLE, R_READER, R_STICKER, R_STOP, R_SWITCH_L, R_SWITCH_R, R_TICKET, STA,
  drawCluster, drawStatic, drawStop, drawTicket, uvRect,
} from './cabtex';
import { GeoBuilder, canvasTexture, makeCanvas, mat4, rgb, type RGB } from './util';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;

interface Dims {
  metro: boolean;
  /** Windscreen glass bottom / top (the top is the overhead console's underside). */
  g0: number;
  g1: number;
  /** Dash top where it meets the glass, its crest, and its depth from the glass. */
  dashGlass: number;
  crest: number;
  depth: number;
  /** Cluster face centre and steering wheel centre (x, y, z' behind the nose). */
  cluster: THREE.Vector3;
  wheel: THREE.Vector3;
  /** Wheel plane tilt from horizontal. */
  tilt: number;
  /** z' of the overhead console's rear face. */
  ohRear: number;
  /** How far the driver's roller blind is pulled down. */
  blindDrop: number;
  col: { dash: RGB; top: RGB; binn: RGB; trim: RGB; over: RGB; pillar: RGB; cowl: RGB; lower: RGB };
}

function dimsFor(B: BodyLayout): Dims {
  if (B.type === 'metro')
    return {
      metro: true,
      g0: 0.98,
      g1: 2.62,
      dashGlass: 1.1,
      crest: 1.18,
      depth: 0.56,
      cluster: V(0.62, 1.4, 0.64),
      wheel: V(0.62, 1.3, 1.02),
      tilt: 22 * D2R,
      ohRear: 0.82,
      blindDrop: 0.26,
      col: { dash: rgb('#3a3d42'), top: rgb('#2c2f33'), binn: rgb('#26282c'), trim: rgb('#8e949b'), over: rgb('#d3d6d9'), pillar: rgb('#2b2e33'), cowl: rgb('#3a3d42'), lower: rgb('#a4aab1') },
    };
  return {
    metro: false,
    g0: 1.12,
    g1: 2.5,
    dashGlass: 1.19,
    crest: 1.25,
    depth: 0.5,
    cluster: V(0.62, 1.42, 0.6),
    wheel: V(0.62, 1.3, 1.0),
    tilt: 22 * D2R,
    ohRear: 0.66,
    blindDrop: 0.2,
    col: { dash: rgb('#3b3e43'), top: rgb('#2e3034'), binn: rgb('#2a2c30'), trim: rgb('#62676e'), over: rgb('#c3c7cb'), pillar: rgb('#34373c'), cowl: rgb('#45484d'), lower: rgb('#8f959c') },
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers (x, y, z' -> section-local via Z)

/** Smooth grid surface; normals from finite differences, flipped to face `toward`. */
function surface(gb: GeoBuilder, P: THREE.Vector3[][], c: RGB, toward: THREE.Vector3, uv?: [number, number]): void {
  const ni = P.length, nj = P[0].length;
  const idx: number[][] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < ni; i++) {
    idx.push([]);
    for (let j = 0; j < nj; j++) {
      a.subVectors(P[Math.min(i + 1, ni - 1)][j], P[Math.max(i - 1, 0)][j]);
      b.subVectors(P[i][Math.min(j + 1, nj - 1)], P[i][Math.max(j - 1, 0)]);
      n.crossVectors(a, b);
      if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
      n.normalize();
      if (n.dot(t.subVectors(toward, P[i][j])) < 0) n.negate();
      const p = P[i][j];
      idx[i].push(gb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, uv ? uv[0] : 0, uv ? uv[1] : 0, c));
    }
  }
  for (let i = 0; i < ni - 1; i++)
    for (let j = 0; j < nj - 1; j++) {
      gb.tri(idx[i][j], idx[i + 1][j], idx[i + 1][j + 1]);
      gb.tri(idx[i][j], idx[i + 1][j + 1], idx[i][j + 1]);
    }
}

/** Flat polygon (any shape) in the plane x = const, from (z, y) points. */
function capX(gb: GeoBuilder, x: number, pts: [number, number][], c: RGB, nx: number): void {
  const contour = pts.map(([z, y]) => new THREE.Vector2(z, y));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const base = gb.count;
  for (const [z, y] of pts) gb.vertex(x, y, z, nx, 0, 0, 0, 0, c);
  for (const [i, j, k] of tris) gb.tri(base + i, base + j, base + k);
}

/** Quad centred at c spanning w along `right` and h along `up`. */
function panel(gb: GeoBuilder, c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, w: number, h: number, uv: [number, number, number, number], col: RGB = [1, 1, 1]): void {
  const r = right.clone().multiplyScalar(w / 2);
  const u = up.clone().multiplyScalar(h / 2);
  gb.quad(c.clone().sub(r).sub(u), c.clone().add(r).sub(u), c.clone().add(r).add(u), c.clone().sub(r).add(u), col, uv);
}

/** Right/up vectors for a roll-free panel whose normal points along n. */
function basis(n: THREE.Vector3): { right: THREE.Vector3; up: THREE.Vector3; n: THREE.Vector3 } {
  const nn = n.clone().normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(nn).normalize();
  const up = nn.clone().cross(right).normalize();
  return { right, up, n: nn };
}

function facing(c: THREE.Vector3, target: THREE.Vector3) {
  return basis(target.clone().sub(c));
}

/** Box with a frame given by its centre and basis (for tilted housings). */
function orientedBox(gb: GeoBuilder, c: THREE.Vector3, f: { right: THREE.Vector3; up: THREE.Vector3; n: THREE.Vector3 }, w: number, h: number, d: number, col: RGB): void {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().makeBasis(f.right, f.up, f.n).setPosition(c.clone().addScaledVector(f.n, -d / 2));
  gb.add(g, m, col);
  g.dispose();
}

// ---------------------------------------------------------------------------

interface Built {
  furniture: THREE.BufferGeometry;
  panels: THREE.BufferGeometry;
  dynamic: THREE.BufferGeometry;
  mirrors: THREE.BufferGeometry;
  clear: THREE.BufferGeometry;
  wheelCenter: THREE.Vector3;
}

function buildCab(B: BodyLayout, sec: SectionLayout, d: Dims, eyeL: THREE.Vector3): Built {
  const zo = -sec.axleFromFront;
  const Z = (z: number) => z + zo;
  const P = (x: number, y: number, z: number) => V(x, y, Z(z));
  const xi = B.hw - 0.08;
  const metro = d.metro;
  const eye = eyeL.clone();
  /** z' of the inside of the front (windscreen) at (x, y), following the rounded corners. */
  const inner = (x: number, y: number): number => {
    const r = ringAt(B, sec, y);
    const hwI = r.hw - 0.06;
    const rf = Math.max(0.02, r.rf - 0.02);
    const cx = hwI - rf;
    let z = r.zf + 0.06;
    const ax = Math.abs(x);
    if (ax > cx) {
      const q = Math.min(rf, ax - cx);
      z += rf - Math.sqrt(Math.max(0, rf * rf - q * q));
    }
    return z;
  };
  /** Point on the inside of the glass at plan arc length t from the centre line: [|x|, z']. */
  const glassPt = (t: number, y: number): [number, number] => {
    const r = ringAt(B, sec, y);
    const hwI = r.hw - 0.06, rf = Math.max(0.02, r.rf - 0.02), cx = hwI - rf, z0 = r.zf + 0.06;
    if (t <= cx) return [t, z0];
    const arc = (rf * Math.PI) / 2;
    if (t <= cx + arc) {
      const th = (t - cx) / rf;
      return [cx + rf * Math.sin(th), z0 + rf * (1 - Math.cos(th))];
    }
    return [hwI, z0 + rf + (t - cx - arc)];
  };
  /** Arc length where the glass reaches z' = zt at height y. */
  const tAtZ = (zt: number, y: number): number => {
    let lo = 0, hi = 4;
    for (let k = 0; k < 28; k++) {
      const m = (lo + hi) / 2;
      if (glassPt(m, y)[1] < zt) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  const fur = new GeoBuilder();
  fur.shade = true;
  const pan = new GeoBuilder();
  const dyn = new GeoBuilder();
  const mir = new GeoBuilder();
  const clr = new GeoBuilder();
  clr.alpha = [];
  const C = d.col;
  const xs = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

  // --- driver's dash: moulded top that tucks under the glass, crest, rounded rear edge, knee panel
  const xa = 0.06;
  const prof: [number, number][] = [
    [-0.03, d.g0],
    [0, d.dashGlass],
    [0.08, d.dashGlass + 0.03],
    [0.22, d.crest - 0.006],
    [0.34, d.crest],
    [d.depth - 0.07, d.crest - 0.014],
    [d.depth - 0.02, d.crest - 0.05],
    [d.depth, d.crest - 0.1],
    [d.depth, d.crest - 0.2],
    [d.depth - 0.03, 0.95],
    [d.depth - 0.07, DRIVER_PLATFORM + 0.06],
  ];
  const dashRows = xs(xa, xi, 14).map((x) => {
    const zg = inner(x, d.dashGlass);
    return prof.map(([dz, y]) => P(x, y, zg + dz));
  });
  surface(fur, dashRows, C.dash, eye);
  // darker anti-glare top: re-colour the first four profile rows
  {
    const rows = xs(xa, xi, 14).map((x) => {
      const zg = inner(x, d.dashGlass);
      return prof.slice(0, 5).map(([dz, y]) => P(x, y + 0.002, zg + dz));
    });
    surface(fur, rows, C.top, eye);
  }
  {
    const zg = inner(xa, d.dashGlass);
    capX(fur, xa, [...prof.map(([dz, y]) => [Z(zg + dz), y] as [number, number]), [Z(zg - 0.03), DRIVER_PLATFORM + 0.06]], C.dash, -1);
  }
  // --- kerb-side cowl in front of the entrance (lower, so the doorway view stays open)
  const cowl: [number, number][] = [
    [-0.03, d.g0],
    [0, d.g0 + 0.04],
    [0.1, d.g0 + 0.065],
    [0.24, d.g0 + 0.065],
    [0.3, d.g0 + 0.03],
    [0.32, d.g0 - 0.03],
    [0.31, 0.5],
  ];
  surface(
    fur,
    xs(-xi, xa, 14).map((x) => {
      const zg = inner(x, d.g0);
      return cowl.map(([dz, y]) => P(x, y, zg + dz));
    }),
    C.cowl,
    eye,
  );
  // --- instrument binnacle on the column: hood over a recessed cluster face
  const cc = P(d.cluster.x, d.cluster.y, d.cluster.z);
  const cf = facing(cc, eye);
  const faceW = 0.5, faceH = 0.17;
  const FT = cc.clone().addScaledVector(cf.up, faceH / 2); // face top edge (centre)
  const FB = cc.clone().addScaledVector(cf.up, -faceH / 2);
  const zgc = Z(inner(d.cluster.x, d.dashGlass));
  const crestY = d.crest;
  const binn: [number, number][] = [
    [zgc + 0.17, crestY - 0.01],
    [FT.z - 0.13, FT.y - 0.06],
    [FT.z - 0.09, FT.y + 0.025],
    [FT.z - 0.03, FT.y + 0.055],
    [FT.z + 0.06, FT.y + 0.065],
    [FT.z + 0.13, FT.y + 0.05],
    [FT.z + 0.15, FT.y + 0.03],
    [FT.z + 0.12, FT.y + 0.018],
    [FT.z + 0.01, FT.y + 0.006],
    [FT.z, FT.y],
    [FB.z, FB.y],
    [FB.z + 0.03, FB.y - 0.012],
    [FB.z + 0.04, Math.max(crestY - 0.02, FB.y - 0.07)],
    [FB.z + 0.02, crestY - 0.08],
  ];
  const hx0 = d.cluster.x - 0.3, hx1 = d.cluster.x + 0.3;
  // hood shell (profile swept across, ends rounded by pulling the outer rows in)
  const hoodIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const hoodRows: THREE.Vector3[][] = [];
  for (const [i, x] of xs(hx0, hx1, 12).entries()) {
    const e = Math.abs(i / 12 - 0.5) * 2; // 0 centre .. 1 ends
    const k = e > 0.8 ? 1 - ((e - 0.8) / 0.2) ** 2 * 0.35 : 1;
    hoodRows.push(hoodIdx.map((j) => {
      const [z, y] = binn[j];
      return V(x, crestY + (y - crestY) * k, z);
    }));
  }
  surface(fur, hoodRows, C.binn, eye);
  const lower = [10, 11, 12, 13];
  surface(fur, xs(hx0, hx1, 2).map((x) => lower.map((j) => V(x, binn[j][1], binn[j][0]))), C.binn, eye);
  for (const [x, nx] of [[hx0, -1], [hx1, 1]] as [number, number][]) {
    const outline = binn.map(([z, y]) => [z, crestY + (y - crestY) * 0.65] as [number, number]);
    capX(fur, x, outline, C.binn, nx);
  }
  // cluster face
  panel(dyn, cc, cf.right, cf.up, faceW, faceH, uvRect(R_CLUSTER, DYN.w, DYN.h));
  // --- switch panels on the dash wings (door controls left, lights right)
  {
    const zl = inner(0.18, d.crest) + 0.3;
    const c1 = P(0.18, d.crest + 0.003, zl);
    const n1 = basis(V(0, 1, 0).lerp(eye.clone().sub(c1).normalize(), 0.35));
    panel(pan, c1, n1.right, n1.up, 0.2, 0.1, uvRect(R_SWITCH_L, STA.w, STA.h));
    const zr = inner(1.03, d.crest) + 0.3;
    const c2 = P(1.03, d.crest + 0.003, zr);
    const n2 = basis(V(0, 1, 0).lerp(eye.clone().sub(c2).normalize(), 0.35));
    panel(pan, c2, n2.right, n2.up, 0.2, 0.1, uvRect(R_SWITCH_R, STA.w, STA.h));
    // destination keypad on the kerb-side cowl
    const zk = inner(-0.42, d.g0) + 0.17;
    const c3 = P(-0.42, d.g0 + 0.068, zk);
    const n3 = basis(V(0, 1, 0).lerp(eye.clone().sub(c3).normalize(), 0.5));
    panel(pan, c3, n3.right, n3.up, 0.24, 0.15, uvRect(R_DESTCTL, STA.w, STA.h));
  }
  // --- right-hand console along the side wall (park brake, emergency buttons)
  {
    const z0 = 0.62, z1 = 1.5, x0 = xi - 0.2, y1 = DRIVER_PLATFORM + 0.42;
    fur.box(x0, DRIVER_PLATFORM, Z(z1), xi, y1, Z(z0), C.dash, 2 | 4 | 16);
    // decal runs front to back, top edge toward the wall (read by turning to the right)
    pan.quad(P(x0 + 0.01, y1 + 0.002, z0 + 0.05), P(x0 + 0.01, y1 + 0.002, z1 - 0.05), P(xi - 0.01, y1 + 0.002, z1 - 0.05), P(xi - 0.01, y1 + 0.002, z0 + 0.05), [1, 1, 1], uvRect(R_RCONSOLE, STA.w, STA.h));
  }
  // --- steering column and shroud
  const wc = P(d.wheel.x, d.wheel.y, d.wheel.z);
  const wn = V(0, Math.cos(d.tilt), Math.sin(d.tilt));
  const colEnd = wc.clone().addScaledVector(wn, -0.5);
  fur.rod(wc.clone().addScaledVector(wn, -0.04), colEnd, 0.045, rgb('#1c1d20'), 10);
  {
    const sc = wc.clone().addScaledVector(wn, -0.2);
    orientedBox(fur, sc, basis(wn.clone().negate().applyAxisAngle(V(1, 0, 0), -Math.PI / 2)), 0.16, 0.12, 0.26, rgb('#222428'));
  }
  fur.box(d.wheel.x - 0.12, DRIVER_PLATFORM, Z(d.wheel.z - 0.32), d.wheel.x + 0.12, colEnd.y + 0.05, Z(d.wheel.z - 0.1), rgb('#1f2024'));
  // --- go card driver console on a stalk, angled to the driver
  {
    const tc = P(0.16, metro ? 1.5 : 1.52, metro ? 0.92 : 0.9);
    const tf = facing(tc, eye);
    orientedBox(fur, tc.clone().addScaledVector(tf.n, -0.002), tf, 0.23, 0.23, 0.065, rgb('#2f3237'));
    panel(pan, tc.clone().addScaledVector(tf.n, 0.001), tf.right, tf.up, 0.22, 0.22, uvRect(R_CONSOLE, STA.w, STA.h));
    panel(dyn, tc.clone().addScaledVector(tf.n, 0.003).addScaledVector(tf.up, 0.039), tf.right, tf.up, 0.188, 0.106, uvRect(R_TICKET, DYN.w, DYN.h));
    const base = P(0.16, d.crest, inner(0.16, d.crest) + d.depth - 0.12);
    fur.rod(base, tc.clone().addScaledVector(tf.up, -0.1).addScaledVector(tf.n, -0.04), 0.022, rgb('#25272b'), 8);
  }
  // --- overhead console: the destination sign housing seen from inside
  {
    const rows = xs(-xi, xi, 20).map((x) => [P(x, d.g1, inner(x, d.g1) - 0.02), P(x, d.g1, d.ohRear)]);
    surface(fur, rows, C.over, eye);
    fur.quad(P(-xi, d.g1, d.ohRear), P(xi, d.g1, d.ohRear), P(xi, B.ceiling + 0.01, d.ohRear), P(-xi, B.ceiling + 0.01, d.ohRear), C.over);
    // shadow line where the console meets the glass, access-panel seam
    fur.quad(P(-xi, d.g1 - 0.002, d.ohRear - 0.16), P(xi, d.g1 - 0.002, d.ohRear - 0.16), P(xi, d.g1 - 0.002, d.ohRear - 0.15), P(-xi, d.g1 - 0.002, d.ohRear - 0.15), rgb('#8a8f95'));
    const ow = 1.0, oh = Math.min(0.17, B.ceiling - d.g1 - 0.02);
    pan.quad(P(-0.95, d.g1 + 0.01, d.ohRear + 0.004), P(-0.95 + ow, d.g1 + 0.01, d.ohRear + 0.004), P(-0.95 + ow, d.g1 + 0.01 + oh, d.ohRear + 0.004), P(-0.95, d.g1 + 0.01 + oh, d.ohRear + 0.004), [1, 1, 1], uvRect(R_OVERHEAD, STA.w, STA.h));
    // CCTV dome
    const dome = new THREE.SphereGeometry(0.05, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    fur.add(dome, mat4(-0.62, d.g1, Z(d.ohRear - 0.2)), rgb('#15171a'));
    dome.dispose();
    // roller-blind cassettes
    const cas: RGB = [C.over[0] * 0.8, C.over[1] * 0.8, C.over[2] * 0.8];
    for (const [a, b] of [[0.08, xi - 0.06], [-xi + 0.06, -0.08]]) {
      for (const [x0, x1] of xs(a, b, 6).slice(0, -1).map((x, i, arr) => [x, i + 1 < arr.length ? arr[i + 1] : b])) {
        const za = inner(x0, d.g1) + 0.01, zb = inner(x1, d.g1) + 0.01;
        fur.quad(P(x0, d.g1 - 0.045, za + 0.07), P(x1, d.g1 - 0.045, zb + 0.07), P(x1, d.g1, zb + 0.07), P(x0, d.g1, za + 0.07), cas);
        fur.quad(P(x0, d.g1 - 0.045, za), P(x1, d.g1 - 0.045, zb), P(x1, d.g1 - 0.045, zb + 0.07), P(x0, d.g1 - 0.045, za + 0.07), cas);
      }
    }
  }
  // --- A-pillars: slim moulded trim along the line where the wrapped windscreen
  // meets the first side window / the door, leaning back with the glass
  const firstOpen = (side: 1 | -1): number => {
    const zs = side > 0 ? sec.windowsR.map((w) => w.z0) : [...sec.windowsL.map((w) => w.z0), ...sec.doors.map((dd) => dd.z0)];
    return Math.min(...zs);
  };
  const pillarZ = { 1: firstOpen(1), [-1]: firstOpen(-1) } as Record<1 | -1, number>;
  /** |x| of the windscreen's side edge (the pillar line) at height y. */
  const glassEdge = (s: 1 | -1, y: number): number => glassPt(tAtZ(pillarZ[s], y) - 0.03, y)[0];
  const pillarYs = xs(d.g0 - 0.1, d.g1 + 0.01, 10);
  for (const s of [1, -1] as const) {
    const zA = pillarZ[s];
    const rows = pillarYs.map((y) => {
      const te = tAtZ(zA, y);
      const [xf, zf] = glassPt(te - 0.075, y);
      const [xr, zr] = glassPt(te + 0.012, y);
      const f = P(s * (xf - 0.01), y, zf + 0.006);
      const r = P(s * (xr - 0.012), y, zr);
      const m = f.clone().lerp(r, 0.5);
      // bulge inward (toward the cab centre / rearward)
      m.x -= s * 0.028;
      m.z += 0.022;
      const f2 = f.clone().lerp(m, 0.35);
      f2.x -= s * 0.012;
      const r2 = r.clone().lerp(m, 0.35);
      r2.x -= s * 0.012;
      return [f, f2, m, r2, r];
    });
    surface(fur, rows, C.pillar, eye);
  }
  // --- interior convex mirror on a stalk (shows the saloon)
  {
    const mc = P(-0.12, d.g1 - 0.1, d.ohRear - 0.3);
    const toEye = eye.clone().sub(mc).normalize();
    const mf = basis(toEye.add(V(0, 0, 1)).normalize());
    orientedBox(fur, mc.clone().addScaledVector(mf.n, -0.004), mf, 0.3, 0.12, 0.035, rgb('#1d1f23'));
    panel(mir, mc.clone().addScaledVector(mf.n, 0.001), mf.right, mf.up, 0.276, 0.1, mirrorUV(M_INT));
    fur.rod(P(-0.12, d.g1, d.ohRear - 0.34), mc.clone().addScaledVector(mf.up, 0.04).addScaledVector(mf.n, -0.025), 0.01, rgb('#1d1f23'), 6);
  }
  // --- Metro: camera-monitor screens on the A-pillars
  if (metro) {
    for (const s of [1, -1] as const) {
      const ym = d.g1 - 0.42;
      const xe = glassEdge(s, ym);
      const mc = P(s * (xe - 0.12), ym, pillarZ[s] + 0.04);
      const mf = facing(mc, eye);
      orientedBox(fur, mc.clone().addScaledVector(mf.n, -0.003), mf, 0.16, 0.27, 0.05, rgb('#17191c'));
      panel(mir, mc.clone().addScaledVector(mf.n, 0.001), mf.right, mf.up, 0.13, 0.24, mirrorUV(s > 0 ? M_RIGHT : M_LEFT));
      fur.rod(mc.clone().addScaledVector(mf.n, -0.03), P(s * (xe - 0.02), ym, pillarZ[s] - 0.02), 0.015, rgb('#17191c'), 6);
    }
  }
  // --- go card readers on the door poles
  for (const dd of sec.doors.slice(0, 2)) {
    const zr = dd.z1 + 0.06;
    const xr = -(xi - 0.25);
    fur.box(xr + 0.02, 1.08, Z(zr - 0.1), xr + 0.1, 1.32, Z(zr + 0.1), rgb('#d4d7db'));
    pan.quad(P(xr + 0.105, 1.09, zr + 0.09), P(xr + 0.105, 1.09, zr - 0.09), P(xr + 0.105, 1.31, zr - 0.09), P(xr + 0.105, 1.31, zr + 0.09), [1, 1, 1], uvRect(R_READER, STA.w, STA.h));
  }
  // --- driver's seat (no headrest, so looking back shows the saloon)
  {
    const sp = DRIVER_PLATFORM;
    const seat = rgb('#2c3038');
    fur.box(0.52, sp, Z(1.38), 0.72, sp + 0.36, Z(1.62), rgb('#1c1d20'));
    fur.box(0.38, sp + 0.36, Z(1.2), 0.86, sp + 0.5, Z(1.72), seat);
    const back = new THREE.BoxGeometry(0.48, 0.66, 0.1);
    fur.add(back, mat4(0.62, sp + 0.86, Z(1.8), -0.12), seat);
    back.dispose();
  }
  // --- stickers on the back of the driver's partition
  {
    const zp = 1.925;
    pan.quad(P(0.3, 1.0, zp), P(0.75, 1.0, zp), P(0.75, 1.14, zp), P(0.3, 1.14, zp), [1, 1, 1], uvRect(R_STICKER, STA.w, STA.h));
    pan.quad(P(0.8, 1.0, zp), P(1.1, 1.0, zp), P(1.1, 1.09, zp), P(0.8, 1.09, zp), [1, 1, 1], uvRect(R_CCTV, STA.w, STA.h));
  }
  // --- "PLEASE HAIL DRIVER" on the top of the glass (Optimus), reversed from inside
  if (!metro) {
    // matches the exterior sticker (paint.ts): kerb side of centre, just under the top frit
    const y0 = 2.348, y1 = 2.432;
    const x0 = -0.72, x1 = 0.28;
    pan.quad(P(x0, y0, inner(x0, y0) - 0.004), P(x1, y0, inner(x1, y0) - 0.004), P(x1, y1, inner(x1, y1) - 0.004), P(x0, y1, inner(x0, y1) - 0.004), [0.9, 0.9, 0.9], uvRect(R_HAIL, STA.w, STA.h));
  }
  // --- passenger display hanging behind the driver, facing the saloon
  panel(dyn, P(-0.25, metro ? 2.6 : 2.52, 2.06), V(1, 0, 0), V(0, 1, 0), 0.8, 0.15, uvRect(R_STOP, DYN.w, DYN.h));

  // --- clear parts: windscreen (a hint of glass, black frit along the top), roller blinds
  {
    const ysG = [d.g0 + 0.02, d.g1 - 0.06, d.g1 - 0.035, d.g1 - 0.015, d.g1];
    const us = xs(0, 1, 32);
    const xsG = us;
    const idx: number[][] = [];
    for (const u of us) {
      const row: number[] = [];
      for (const y of ysG) {
        const xl = glassEdge(-1, y), xr = glassEdge(1, y);
        // denser towards the wrapped corners
        const uu = 0.5 - 0.5 * Math.cos(Math.PI * u);
        const x = -xl + (xl + xr) * (0.35 * u + 0.65 * uu);
        const edge = Math.min(x + xl, xr - x);
        const top = Math.max(0, Math.min(1, (y - (d.g1 - 0.055)) / 0.04));
        const side = Math.max(0, Math.min(1, (0.05 - edge) / 0.05));
        const frit = Math.max(top, side);
        const a = 0.04 + 0.9 * frit;
        const k = (1 - frit) ** 3;
        row.push(clr.vertex(x, y, Z(inner(x, y) - 0.008), 0, 0, 1, 0, 0, [0.22 * k + 0.012, 0.27 * k + 0.014, 0.28 * k + 0.016], a));
      }
      idx.push(row);
    }
    for (let i = 0; i < xsG.length - 1; i++)
      for (let j = 0; j < ysG.length - 1; j++) {
        clr.tri(idx[i][j], idx[i + 1][j], idx[i + 1][j + 1]);
        clr.tri(idx[i][j], idx[i + 1][j + 1], idx[i][j + 1]);
      }
    // driver's smoked roller blind, partly down
    const by1 = d.g1 - 0.045, by0 = d.g1 - d.blindDrop;
    const bx = xs(metro ? 0.02 : 0.1, xi - 0.08, 8);
    const tint: RGB = metro ? [0.025, 0.028, 0.035] : [0.03, 0.035, 0.045];
    for (let i = 0; i < bx.length - 1; i++) {
      const xa2 = bx[i], xb2 = bx[i + 1];
      const za = inner(xa2, by0) + 0.05, zb = inner(xb2, by0) + 0.05;
      const ta = inner(xa2, by1) + 0.06, tb = inner(xb2, by1) + 0.06;
      clr.quad(P(xb2, by0, zb), P(xa2, by0, za), P(xa2, by1, ta), P(xb2, by1, tb), tint, undefined, metro ? 0.68 : 0.62);
      fur.quad(P(xb2, by0 - 0.022, zb), P(xa2, by0 - 0.022, za), P(xa2, by0, za), P(xb2, by0, zb), rgb('#25272b'));
    }
    // pull tab
    const tx = (bx[0] + bx[bx.length - 1]) / 2;
    const tz = inner(tx, by0) + 0.05;
    fur.box(tx - 0.03, by0 - 0.06, Z(tz - 0.005), tx + 0.03, by0 - 0.02, Z(tz + 0.005), rgb('#25272b'));
  }

  return {
    furniture: fur.build(),
    panels: pan.build(),
    dynamic: dyn.build(),
    mirrors: mir.build(),
    clear: clr.build(),
    wheelCenter: wc,
  };
}

/** Volvo-style bus wheel: thick rim, two low spokes and a big centre pad. */
function steeringWheelGeometry(): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  gb.shade = true;
  const black: RGB = rgb('#2a2c31');
  const rim = new THREE.TorusGeometry(0.25, 0.022, 8, 40);
  gb.add(rim, mat4(0, 0, 0, Math.PI / 2, 0, 0), black);
  rim.dispose();
  // spokes at about 4 and 8 o'clock (local -z is 12 o'clock, toward the windscreen)
  for (const a of [-0.38, Math.PI + 0.38]) {
    const dir = V(Math.cos(a), 0, -Math.sin(a));
    const len = 0.19;
    const spoke = new THREE.BoxGeometry(len, 0.024, 0.06);
    gb.add(spoke, mat4(dir.x * (0.07 + len / 2), -0.012, dir.z * (0.07 + len / 2), 0, a, 0), rgb('#33363c'));
    spoke.dispose();
  }
  {
    const spoke = new THREE.BoxGeometry(0.05, 0.022, 0.17);
    gb.add(spoke, mat4(0, -0.014, 0.15), rgb('#33363c'));
    spoke.dispose();
  }
  const pad = new THREE.CylinderGeometry(0.09, 0.1, 0.07, 20);
  gb.add(pad, mat4(0, -0.012, 0.012, 0, 0, 0, 1.25, 1, 1), rgb('#3a3d43'));
  pad.dispose();
  const badge = new THREE.CircleGeometry(0.025, 16);
  gb.add(badge, mat4(0, 0.0235, 0.0, -Math.PI / 2), rgb('#9aa1a9'));
  badge.dispose();
  // grip sections at 10 and 2 o'clock
  for (const a of [Math.PI * 0.75, Math.PI * 0.25]) {
    const g = new THREE.TorusGeometry(0.25, 0.025, 6, 8, 0.45);
    gb.add(g, mat4(0, 0, 0, Math.PI / 2, 0, a - 0.225), rgb('#34373d'));
    g.dispose();
  }
  return gb.build();
}

export function createCab(type: BusType): Cab {
  const B = layoutFor(type);
  const sec = B.sections[0];
  const metro = type === 'metro';
  const d = dimsFor(B);
  const Z = (z: number) => z - sec.axleFromFront;
  const group = new THREE.Group();
  group.name = 'cab';
  group.userData.busCab = true;
  const eye = new THREE.Vector3(B.eye.x, B.eye.y, Z(B.eye.z));

  const saloon = buildSaloon(B, sec, true);
  group.add(saloon.group);

  const built = buildCab(B, sec, d, eye);
  const furnMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const furniture = new THREE.Mesh(built.furniture, furnMat);
  furniture.name = 'cabFurniture';
  group.add(furniture);

  // steering wheel: built flat (local -z = 12 o'clock), tilted back toward the driver
  const wheelPivot = new THREE.Group();
  wheelPivot.position.copy(built.wheelCenter);
  wheelPivot.rotation.x = d.tilt;
  const wheelMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const wheel = new THREE.Mesh(steeringWheelGeometry(), wheelMat);
  wheel.name = 'steeringWheel';
  wheelPivot.add(wheel);
  group.add(wheelPivot);

  // canvases
  const dynC = makeCanvas(DYN.w, DYN.h);
  const dynTex = canvasTexture(dynC.canvas, true, false);
  const staC = makeCanvas(STA.w, STA.h);
  drawStatic(staC.ctx, metro);
  const staTex = canvasTexture(staC.canvas);

  const dynMat = new THREE.MeshBasicMaterial({ map: dynTex, toneMapped: false });
  const dynMesh = new THREE.Mesh(built.dynamic, dynMat);
  dynMesh.name = 'instruments';
  group.add(dynMesh);
  const staMat = new THREE.MeshBasicMaterial({ map: staTex, vertexColors: true });
  const staMesh = new THREE.Mesh(built.panels, staMat);
  staMesh.name = 'cabPanels';
  group.add(staMesh);
  const mirMat = new THREE.MeshBasicMaterial({ map: mirrorTexture(), color: metro ? 0xffffff : 0xe2e6ea, toneMapped: !metro });
  const mirMesh = new THREE.Mesh(built.mirrors, mirMat);
  mirMesh.name = 'cabMirrors';
  group.add(mirMesh);
  const clearMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const clear = new THREE.Mesh(built.clear, clearMat);
  clear.name = 'windscreen';
  clear.renderOrder = 3;
  group.add(clear);

  let lastKey = '';
  let lastDraw = -1;
  let lastT = 0;
  let trip = 0;
  let night: boolean | null = null;
  let mirKey = '';
  let mirT = -1;

  return {
    group,
    eye,
    update(st: CabState) {
      wheel.rotation.y = -st.steeringWheel;
      const dt = Math.max(0, Math.min(0.5, st.timeSeconds - lastT));
      lastT = st.timeSeconds;
      trip += (st.speedKmh / 3600) * dt;
      const flash = (st.timeSeconds * 1.5) % 1 < 0.5;
      if (night !== st.lights.headlights) {
        night = st.lights.headlights;
        saloon.setNight(night);
        const k = night ? 0.62 : 1;
        furnMat.color.setScalar(k);
        wheelMat.color.setScalar(k);
        staMat.color.setScalar(night ? 0.75 : 1);
      }
      // mirror reflections: repaint ~12 times a second while moving
      const mk = `${type}|${playerSign.route}|${night ? 1 : 0}`;
      if (mk !== mirKey || ((st.speedKmh > 0.5 || st.timeSeconds < mirT) && Math.abs(st.timeSeconds - mirT) > 0.08)) {
        mirKey = mk;
        mirT = st.timeSeconds;
        paintMirrors({ type, route: playerSign.route, dist: trip * 1000, night: !!night });
      }
      const L = st.lights;
      const key = [
        Math.round(st.speedKmh * 2),
        Math.round(st.rpm / 20),
        flash && (L.indicatorLeft || L.indicatorRight || L.hazards) ? 1 : 0,
        L.indicatorLeft ? 1 : 0, L.indicatorRight ? 1 : 0, L.hazards ? 1 : 0, L.headlights ? 1 : 0, L.reverse ? 1 : 0, L.brake ? 1 : 0,
        st.doorsOpen ? 1 : 0,
        st.stopRequested ? 1 : 0,
        Math.floor(st.timeSeconds),
        playerSign.route,
        st.gear ?? '',
      ].join(',');
      if (key !== lastKey && (st.timeSeconds - lastDraw > 0.05 || st.timeSeconds < lastDraw)) {
        lastKey = key;
        lastDraw = st.timeSeconds;
        drawCluster(dynC.ctx, { speed: st.speedKmh, rpm: st.rpm, flash, st, trip, metro });
        drawStop(dynC.ctx, st);
        drawTicket(dynC.ctx, st);
        dynTex.needsUpdate = true;
      }
    },
  };
}

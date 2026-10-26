/**
 * Small repeated objects spread over the whole map (signal heads, poles and
 * arms, bus shelters, railway masts, street-light poles) as one instanced draw
 * per pass, holding only what is near the camera.
 *
 * The instances are kept sorted by 250 m cell. Whenever the camera has moved
 * or turned enough, the cells within `range` that are in view (with a margin
 * for turning before the next refresh) are copied into the mesh, the ones near
 * the sun's shadow box first: the shadow pass draws just those (it trims the
 * instance count), the main pass draws them all.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { clamp } from './util';

const CELL = 250;
/** Refresh after the camera moves this far (m) or turns this much. */
const MOVE = 15;
const TURN_COS = Math.cos((9 * Math.PI) / 180);
/** Cells within this angle outside the view still count as in view. */
const VIEW_MARGIN = Math.sin((16 * Math.PI) / 180);

export interface CellInstanceOpts {
  name: string;
  /** Drawn while the camera is within this distance (m, horizontal, to the cell). */
  range: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Largest reach of one object from its origin (m), for the view test. */
  size?: number;
}

/**
 * `matrices` holds 16 floats per instance; `extra` per-instance attributes
 * (set on the geometry under their names) in the same order.
 */
export function cellInstances(
  ctx: Ctx,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: Float32Array,
  extra: { name: string; size: number; data: Float32Array }[],
  o: CellInstanceOpts,
): THREE.InstancedMesh {
  const n = matrices.length / 16;
  const [gx0, gy0, gx1, gy1] = ctx.R;
  const gnx = Math.max(1, Math.ceil((gx1 - gx0) / CELL));
  const gny = Math.max(1, Math.ceil((gy1 - gy0) / CELL));
  const cellOf = (k: number) => {
    const x = matrices[16 * k + 12];
    const y = -matrices[16 * k + 14];
    return clamp(Math.floor((y - gy0) / CELL), 0, gny - 1) * gnx + clamp(Math.floor((x - gx0) / CELL), 0, gnx - 1);
  };
  // sort by cell
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => cellOf(a) - cellOf(b));
  const M = new Float32Array(n * 16);
  const X = extra.map((e) => new Float32Array(n * e.size));
  const start = new Int32Array(gnx * gny);
  const count = new Int32Array(gnx * gny);
  const cy0 = new Float32Array(gnx * gny).fill(Infinity);
  const cy1 = new Float32Array(gnx * gny).fill(-Infinity);
  order.forEach((k, i) => {
    M.set(matrices.subarray(16 * k, 16 * k + 16), 16 * i);
    extra.forEach((e, a) => X[a].set(e.data.subarray(e.size * k, e.size * (k + 1)), e.size * i));
    const c = cellOf(k);
    if (!count[c]) start[c] = i;
    count[c]++;
    cy0[c] = Math.min(cy0[c], M[16 * i + 13]);
    cy1[c] = Math.max(cy1[c], M[16 * i + 13]);
  });
  const size = o.size ?? 10;

  // the mesh: room for every instance, filled with the ones in use
  const mesh = new THREE.InstancedMesh(geo, material, n);
  mesh.name = o.name;
  mesh.castShadow = !!o.castShadow;
  mesh.receiveShadow = !!o.receiveShadow;
  mesh.frustumCulled = false;
  // whole-map bounds (the world's underground culling keeps these near tunnel portals)
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  mesh.count = 0;
  mesh.visible = false;
  const im = mesh.instanceMatrix;
  im.setUsage(THREE.DynamicDrawUsage);
  const attrs = extra.map((e) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * e.size), e.size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(e.name, a);
    return a;
  });
  const IM = im.array as Float32Array;
  const copy = (src: number, dst: number, cnt: number) => {
    for (let k = 0; k < cnt * 16; k++) IM[16 * dst + k] = M[16 * src + k];
    extra.forEach((e, a) => {
      const A = attrs[a].array as Float32Array;
      const S = X[a];
      for (let k = 0; k < cnt * e.size; k++) A[e.size * dst + k] = S[e.size * src + k];
    });
  };

  let nAll = 0;
  let nShadow = 0;
  mesh.onBeforeShadow = () => {
    mesh.count = nShadow;
  };
  mesh.onAfterShadow = () => {
    mesh.count = nAll;
  };

  const near = new Int32Array(n);
  const farCells = new Int32Array(gnx * gny);
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const fwd = new THREE.Vector3();
  const last = { x: NaN, y: 0, z: 0, fx: 0, fy: 0, fz: 0, p0: 0, p5: 0 };
  const rangeC = Math.ceil(o.range / CELL) + 1;
  ctx.tick.push((_dt, camera) => {
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    fwd.set(-e[8], -e[9], -e[10]).normalize();
    const pe = camera.projectionMatrix.elements;
    const moved = !(Math.hypot(px - last.x, py - last.y, pz - last.z) < MOVE);
    const turned = fwd.x * last.fx + fwd.y * last.fy + fwd.z * last.fz < TURN_COS;
    const zoomed = Math.abs(pe[0] - last.p0) > 0.02 * Math.abs(pe[0]) || Math.abs(pe[5] - last.p5) > 0.02 * Math.abs(pe[5]);
    if (!moved && !turned && !zoomed) return;
    last.x = px;
    last.y = py;
    last.z = pz;
    last.fx = fwd.x;
    last.fy = fwd.y;
    last.fz = fwd.z;
    last.p0 = pe[0];
    last.p5 = pe[5];
    // the shadow box (sky.ts) is +-(110 + 0.9 x camera height) and sits half its size ahead
    const camH = Math.max(0, py - ctx.field.renAt(px, -pz));
    const half = clamp(110 + camH * 0.9, 110, 700);
    const rSh = 2 * half + 25 + MOVE;
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    const pl = frustum.planes;
    const ci = Math.floor((px - gx0) / CELL);
    const cj = Math.floor((-pz - gy0) / CELL);
    let nn = 0;
    let nf = 0;
    let nFar = 0;
    for (let j = Math.max(0, cj - rangeC); j <= Math.min(gny - 1, cj + rangeC); j++) {
      // three.js z of the cell row's north and south edges
      const zn = -(gy0 + (j + 1) * CELL);
      const zs = -(gy0 + j * CELL);
      const dz = Math.max(zn - pz, 0, pz - zs);
      for (let i = Math.max(0, ci - rangeC); i <= Math.min(gnx - 1, ci + rangeC); i++) {
        const c = j * gnx + i;
        const cnt = count[c];
        if (!cnt) continue;
        const xw = gx0 + i * CELL;
        const dx = Math.max(xw - px, 0, px - xw - CELL);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > o.range) continue;
        // view test on the cell's bounding sphere, with a margin growing with distance
        const sx = xw + CELL / 2;
        const sy = (cy0[c] + cy1[c]) / 2;
        const sz = (zn + zs) / 2;
        const m = CELL * 0.71 + (cy1[c] - cy0[c]) / 2 + size + d * VIEW_MARGIN;
        let vis = true;
        for (let k = 0; k < 6 && vis; k++) vis = pl[k].normal.x * sx + pl[k].normal.y * sy + pl[k].normal.z * sz + pl[k].constant >= -m;
        const s0 = start[c];
        if (o.castShadow && d < rSh) {
          // per instance: near the shadow box first, the rest only when in view
          for (let q = s0; q < s0 + cnt; q++) {
            const ex = M[16 * q + 12] - px;
            const ez = M[16 * q + 14] - pz;
            if (ex * ex + ez * ez < rSh * rSh) near[nn++] = q;
            else if (vis) near[n - 1 - nf++] = q;
          }
        } else if (vis) {
          farCells[nFar++] = c;
        }
      }
    }
    let w = 0;
    for (let k = 0; k < nn; k++) copy(near[k], w++, 1);
    nShadow = w;
    for (let k = 0; k < nf; k++) copy(near[n - 1 - k], w++, 1);
    for (let k = 0; k < nFar; k++) {
      const c = farCells[k];
      copy(start[c], w, count[c]);
      w += count[c];
    }
    nAll = w;
    mesh.count = w;
    mesh.visible = w > 0;
    if (!w) return;
    for (const a of [im, ...attrs]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, w * a.itemSize);
      a.needsUpdate = true;
    }
  });
  ctx.root.add(mesh);
  return mesh;
}

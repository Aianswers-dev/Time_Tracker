// Passenger saloon interior for one section: floor, walls with window and
// door openings, ceiling coves with LED strips, TransLink moquette seats
// (instanced), yellow grab poles with red stop buttons and tinted glass.
// Interiors are unlit (MeshBasicMaterial) with lighting baked into vertex
// colours, so they read the same in any world lighting, day or night.
import * as THREE from 'three';
import type { BodyLayout, SectionLayout } from './spec';
import { frontZ, rearZ } from './shell';
import { SEAT_UV, seatTexture } from './materials';
import { GeoBuilder, mat4, rgb, type RGB } from './util';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface SeatPlace {
  x: number;
  z: number; // z'
  y: number; // base height (floor or plinth)
  rot: number; // 0 = facing forward (-z)
}

export interface Saloon {
  group: THREE.Group;
  /** Seat placements (z' coordinates), useful for the cab. */
  seats: SeatPlace[];
  floorAt(z: number): number;
  setNight(night: boolean): void;
  dispose(): void;
}

const COL = {
  floor: rgb('#33363b'),
  riser: rgb('#25272b'),
  nosing: rgb('#e8b400'),
  lower: rgb('#aab0b7'),
  pillar: rgb('#3c4046'),
  cove: rgb('#d3d7db'),
  ceiling: rgb('#e9ebee'),
  housing: rgb('#9aa0a7'),
  platform: rgb('#2b2d31'),
  partition: rgb('#5a5f66'),
  frame: rgb('#202226'),
  yellow: rgb('#f2c300'),
  red: rgb('#d0161e'),
  grip: rgb('#9da2a8'),
};

/** One forward-facing seat (origin at floor, centred), fabric + grey shell. */
export function seatGeometry(): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  gb.shade = true;
  const w: RGB = [1, 1, 1];
  const g = (sx: number, sy: number, sz: number) => new THREE.BoxGeometry(sx, sy, sz);
  // cushion
  const cushion = g(0.43, 0.1, 0.42);
  gb.add(cushion, mat4(0, 0.4, 0), w, SEAT_UV.fabric);
  // back (fabric front, then a grey shell behind)
  const back = g(0.43, 0.6, 0.06);
  gb.add(back, mat4(0, 0.78, 0.2, -0.16), w, SEAT_UV.fabric);
  const shell = g(0.45, 0.64, 0.03);
  gb.add(shell, mat4(0, 0.78, 0.245, -0.16), w, SEAT_UV.plastic);
  // grab handle on top of the back
  const handle = g(0.2, 0.022, 0.022);
  gb.add(handle, mat4(0, 1.1, 0.29, -0.16), w, SEAT_UV.plastic);
  // pedestal
  const ped = g(0.07, 0.36, 0.3);
  gb.add(ped, mat4(0, 0.18, 0.02), w, SEAT_UV.dark);
  for (const x of [cushion, back, shell, handle, ped]) x.dispose();
  return gb.build();
}

let seatGeo: THREE.BufferGeometry | null = null;

function sharedSeatGeometry(): THREE.BufferGeometry {
  if (!seatGeo) seatGeo = seatGeometry();
  return seatGeo;
}

function rowsRigid(_sec: SectionLayout, B: BodyLayout, floorAt: (z: number) => number): SeatPlace[] {
  const out: SeatPlace[] = [];
  const xw = B.hw - 0.08 - 0.28;
  const xa = xw - 0.45;
  const pair = (side: number, z: number, y = floorAt(z)) => {
    out.push({ x: side * xw, z, y, rot: 0 });
    out.push({ x: side * xa, z, y, rot: 0 });
  };
  // right side: over the front wheel on a plinth, then rows
  pair(1, 2.4, 0.78);
  pair(1, 3.18, 0.78);
  for (const z of [3.95, 4.7, 5.45, 6.2]) pair(1, z);
  for (const z of [7.75, 8.5, 9.25, 10.0]) pair(1, z, z > 8.0 && z < 9.6 ? 0.98 : floorAt(z));
  // left side: inward facing priority seats over the front wheel, then rows
  for (const z of [2.15, 2.6, 3.05]) out.push({ x: -(B.hw - 0.08 - 0.24), z, y: 0.78, rot: -Math.PI / 2 });
  pair(-1, 4.95);
  for (const z of [7.75, 8.5, 9.25, 10.0]) pair(-1, z, z > 8.0 && z < 9.6 ? 0.98 : floorAt(z));
  // rear bench of five
  for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) out.push({ x, z: 11.72, y: floorAt(11.72), rot: 0 });
  return out;
}

function rowsMetro(sec: SectionLayout, B: BodyLayout, floorAt: (z: number) => number): SeatPlace[] {
  const out: SeatPlace[] = [];
  const xw = B.hw - 0.08 - 0.28;
  const xa = xw - 0.45;
  const overArch = (z: number) => sec.axles.some((a) => Math.abs(a.z - z) < 0.75);
  const pair = (side: number, z: number) => {
    const y = overArch(z) ? 0.82 : floorAt(z);
    out.push({ x: side * xw, z, y, rot: 0 });
    out.push({ x: side * xa, z, y, rot: 0 });
  };
  const clearOfDoors = (z: number) => sec.doors.every((d) => z < d.z0 - 0.3 || z > d.z1 + 0.3);
  const start = sec.index === 0 ? 2.3 : sec.bodyFront + 0.5;
  const end = sec.bodyRear - (sec.isRear ? 0.9 : 0.5);
  for (let z = start; z <= end; z += 0.76) {
    pair(1, z);
    // left side: mobility bays behind the front door of section 0
    if (clearOfDoors(z) && !(sec.index === 0 && z < 5.4)) pair(-1, z);
  }
  if (sec.isRear) for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) out.push({ x, z: sec.bodyRear - 0.55, y: floorAt(sec.bodyRear - 0.55), rot: 0 });
  return out;
}

export function buildSaloon(B: BodyLayout, sec: SectionLayout, driver: boolean): Saloon {
  const group = new THREE.Group();
  group.name = `saloon${sec.index}`;
  const zo = -sec.axleFromFront;
  const Z = (z: number) => z + zo;
  const xi = B.hw - 0.08;
  const plat = sec.rearPlatform;
  const floorAt = (z: number): number => {
    if (!plat) return B.floor;
    if (z < plat.z0) return B.floor;
    if (z < plat.z0 + 0.35) return (B.floor + plat.y) / 2;
    if (plat.z1 !== undefined && plat.y1 !== undefined && z >= plat.z1) return plat.y1;
    return plat.y;
  };
  const zStart = sec.bodyFront + (sec.isFront ? 0.12 : 0.02);
  const zEnd = sec.bodyRear - (sec.isRear ? 0.12 : 0.02);

  const st = new GeoBuilder();
  st.shade = true;

  // --- floor with steps
  const steps: number[] = [zStart];
  if (plat) {
    steps.push(plat.z0, plat.z0 + 0.35);
    if (plat.z1 !== undefined) steps.push(plat.z1);
  }
  steps.push(zEnd);
  for (let i = 0; i < steps.length - 1; i++) {
    const za = steps[i], zb = steps[i + 1];
    const y = floorAt((za + zb) / 2);
    st.quad(V(-xi, y, Z(zb)), V(xi, y, Z(zb)), V(xi, y, Z(za)), V(-xi, y, Z(za)), COL.floor);
    if (i > 0) {
      const yPrev = floorAt((steps[i - 1] + za) / 2);
      st.quad(V(-xi, yPrev, Z(za)), V(xi, yPrev, Z(za)), V(xi, y, Z(za)), V(-xi, y, Z(za)), COL.riser);
      st.quad(V(-xi, y + 0.003, Z(za + 0.05)), V(xi, y + 0.003, Z(za + 0.05)), V(xi, y + 0.003, Z(za)), V(-xi, y + 0.003, Z(za)), COL.nosing);
    }
  }
  if (driver) {
    // yellow standee line behind the driver
    st.quad(V(-xi, B.floor + 0.003, Z(1.98)), V(0.2, B.floor + 0.003, Z(1.98)), V(0.2, B.floor + 0.003, Z(1.92)), V(-xi, B.floor + 0.003, Z(1.92)), COL.nosing);
  }

  // --- wheel housings (seat plinths)
  for (const ax of sec.axles) {
    const top = B.type === 'metro' ? 0.82 : ax.z > 5 ? 0.98 : 0.78;
    for (const s of [1, -1]) {
      const xa = s > 0 ? xi - 0.58 : -xi, xb = s > 0 ? xi : -xi + 0.58;
      if (driver && s > 0 && ax.z < 3) {
        st.box(xa, B.floor, Z(Math.max(1.92, ax.z - 0.68)), xb, top, Z(ax.z + 0.68), COL.housing, 1 | 2 | 4 | 16 | 32);
      } else st.box(xa, floorAt(ax.z), Z(ax.z - 0.68), xb, top, Z(ax.z + 0.68), COL.housing, 1 | 2 | 4 | 16 | 32);
    }
  }

  // --- side walls with openings
  type Opening = { z0: number; z1: number; y0: number; y1: number };
  const wallTop = B.winTop + 0.04;
  for (const side of [1, -1]) {
    const x = side * xi;
    const ops: Opening[] = (side > 0 ? sec.windowsR : sec.windowsL).map((w) => ({ ...w }));
    if (side < 0) for (const d of sec.doors) ops.push({ z0: d.z0, z1: d.z1, y0: B.floor - 0.05, y1: B.doorTop - 0.02 });
    ops.sort((a, b) => a.z0 - b.z0);
    const panel = (za: number, zb: number, ya: number, yb: number, c: RGB) => {
      if (zb - za < 1e-3 || yb - ya < 1e-3) return;
      if (side > 0) st.quad(V(x, ya, Z(za)), V(x, ya, Z(zb)), V(x, yb, Z(zb)), V(x, yb, Z(za)), c);
      else st.quad(V(x, ya, Z(zb)), V(x, ya, Z(za)), V(x, yb, Z(za)), V(x, yb, Z(zb)), c);
    };
    let z = zStart;
    for (const o of ops) {
      if (o.z0 > z) {
        panel(z, o.z0, 0.34, B.sill, COL.lower);
        panel(z, o.z0, B.sill, wallTop, COL.pillar);
      }
      panel(o.z0, o.z1, 0.34, o.y0, COL.lower);
      panel(o.z0, o.z1, o.y1, wallTop, COL.pillar);
      z = Math.max(z, o.z1);
    }
    if (z < zEnd) {
      panel(z, zEnd, 0.34, B.sill, COL.lower);
      panel(z, zEnd, B.sill, wallTop, COL.pillar);
    }
    // cove panel up to the ceiling
    const xc = side * (xi - 0.3);
    if (side > 0) st.quad(V(x, wallTop, Z(zStart)), V(x, wallTop, Z(zEnd)), V(xc, B.ceiling - 0.03, Z(zEnd)), V(xc, B.ceiling - 0.03, Z(zStart)), COL.cove);
    else st.quad(V(x, wallTop, Z(zEnd)), V(x, wallTop, Z(zStart)), V(xc, B.ceiling - 0.03, Z(zStart)), V(xc, B.ceiling - 0.03, Z(zEnd)), COL.cove);
  }
  // ceiling
  st.quad(V(-(xi - 0.3), B.ceiling, Z(zStart)), V(xi - 0.3, B.ceiling, Z(zStart)), V(xi - 0.3, B.ceiling, Z(zEnd)), V(-(xi - 0.3), B.ceiling, Z(zEnd)), COL.ceiling);
  for (let zh = sec.bodyFront + 2.5; zh < sec.bodyRear - 1.5; zh += 4.2) {
    st.box(-0.42, B.ceiling - 0.03, Z(zh), 0.42, B.ceiling - 0.005, Z(zh + 0.75), rgb('#c9cdd2'), 8);
  }

  // --- front wall around the windscreen
  if (sec.isFront) {
    const fz = (y: number) => Z(frontZ(B, sec, y) + 0.07);
    const metro = B.type === 'metro';
    const g0 = metro ? 0.98 : 1.12, g1 = metro ? 2.36 : 2.72;
    const xg = B.hw - (metro ? 0.22 : 0.15);
    const ys = [0.34, g0, (g0 + g1) / 2, g1, B.ceiling];
    for (let i = 0; i < ys.length - 1; i++) {
      const ya = ys[i], yb = ys[i + 1];
      const inGlass = ya >= g0 - 1e-3 && yb <= g1 + 1e-3;
      const c = inGlass ? COL.frame : ya < g0 ? COL.partition : COL.frame;
      if (inGlass) {
        for (const s of [1, -1]) {
          const [x0, x1] = s > 0 ? [xg, xi] : [-xi, -xg];
          st.quad(V(x1, ya, fz(ya)), V(x0, ya, fz(ya)), V(x0, yb, fz(yb)), V(x1, yb, fz(yb)), c);
        }
      } else st.quad(V(xi, ya, fz(ya)), V(-xi, ya, fz(ya)), V(-xi, yb, fz(yb)), V(xi, yb, fz(yb)), c);
    }
  }
  // --- rear wall with rear window
  if (sec.isRear) {
    const rz = (y: number) => Z(rearZ(B, sec, y) - 0.07);
    const metro = B.type === 'metro';
    const w0 = metro ? 1.05 : 1.95, w1 = metro ? 2.76 : 2.78;
    const xg = B.hw - 0.27;
    const piece = (xa: number, xb: number, ya: number, yb: number) =>
      st.quad(V(xa, ya, rz(ya)), V(xb, ya, rz(ya)), V(xb, yb, rz(yb)), V(xa, yb, rz(yb)), COL.lower);
    piece(-xi, xi, 0.34, w0);
    piece(-xi, xi, w1, B.ceiling);
    piece(-xi, -xg, w0, w1);
    piece(xg, xi, w0, w1);
  }
  // --- gangway portals at articulated ends
  if (!sec.isFront || !sec.isRear) {
    const ends: number[] = [];
    if (!sec.isFront) ends.push(zStart);
    if (!sec.isRear) ends.push(zEnd);
    for (const ze of ends) {
      for (const s of [1, -1]) st.box(s > 0 ? xi - 0.14 : -xi, 0.34, Z(ze - 0.03), s > 0 ? xi : -xi + 0.14, B.ceiling, Z(ze + 0.03), COL.frame);
      st.box(-xi, B.ceiling - 0.16, Z(ze - 0.03), xi, B.ceiling, Z(ze + 0.03), COL.frame);
    }
  }

  // --- driver's platform and partition
  if (driver) {
    st.box(0.18, B.floor, Z(0.15), xi, 0.8, Z(1.9), COL.platform, 2 | 4 | 16);
    st.box(0.18, 0.8, Z(1.86), xi, 1.5, Z(1.92), COL.partition);
    st.box(0.15, 0.8, Z(0.78), 0.21, 1.32, Z(1.9), COL.partition);
    st.box(0.15, 1.5, Z(1.86), 0.72, 1.53, Z(1.92), COL.frame);
    st.box(0.15, 1.32, Z(1.86), 0.19, 2.22, Z(1.9), COL.frame);
  }

  const structure = new THREE.Mesh(st.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  structure.name = 'saloonStructure';
  group.add(structure);

  // --- seats
  const seats = B.type === 'metro' ? rowsMetro(sec, B, floorAt) : rowsRigid(sec, B, floorAt);
  const seatMat = new THREE.MeshBasicMaterial({ map: seatTexture(), vertexColors: true });
  const seatMesh = new THREE.InstancedMesh(sharedSeatGeometry(), seatMat, seats.length);
  const m = new THREE.Matrix4();
  seats.forEach((s, i) => {
    m.copy(mat4(s.x, s.y, Z(s.z), 0, s.rot, 0));
    seatMesh.setMatrixAt(i, m);
  });
  seatMesh.instanceMatrix.needsUpdate = true;
  seatMesh.computeBoundingSphere();
  seatMesh.name = 'seats';
  group.add(seatMesh);

  // --- poles, rails, stop buttons, grips
  const po = new GeoBuilder();
  po.shade = true;
  const railY = B.ceiling - 0.15;
  const r0 = driver ? 1.98 : sec.bodyFront + 0.15;
  const r1 = sec.bodyRear - (sec.isRear ? 0.7 : 0.15);
  for (const x of [-0.34, 0.34]) {
    po.rod(V(x, railY, Z(r0)), V(x, railY, Z(r1)), 0.017, COL.yellow, 8);
    for (let z = r0 + 0.3; z < r1; z += 2.2) po.rod(V(x, railY, Z(z)), V(x * 1.05, B.ceiling, Z(z)), 0.012, COL.grip, 5);
    for (let z = r0 + 0.4; z < r1 - 0.2; z += 0.62) {
      // triangular hand grips hanging off the rail
      po.box(x - 0.006, railY - 0.12, Z(z) - 0.01, x + 0.006, railY - 0.015, Z(z) + 0.01, COL.grip);
      po.rod(V(x, railY - 0.12, Z(z)), V(x - 0.045, railY - 0.2, Z(z)), 0.008, COL.grip, 4);
      po.rod(V(x, railY - 0.12, Z(z)), V(x + 0.045, railY - 0.2, Z(z)), 0.008, COL.grip, 4);
      po.rod(V(x - 0.045, railY - 0.2, Z(z)), V(x + 0.045, railY - 0.2, Z(z)), 0.01, COL.grip, 4);
    }
  }
  const pole = (x: number, z: number, y0: number, button = true) => {
    po.rod(V(x, y0, Z(z)), V(x, railY + 0.02, Z(z)), 0.018, COL.yellow, 8);
    if (button) {
      const sx = x > 0 ? -1 : 1;
      po.box(x + sx * 0.012, 1.3, Z(z) - 0.025, x + sx * 0.045, 1.4, Z(z) + 0.025, COL.red);
    }
  };
  // poles at every second row on the aisle side
  const rowZ = [...new Set(seats.filter((s) => s.rot === 0 && Math.abs(s.x) < 0.6).map((s) => Math.round(s.z * 100) / 100))].sort((a, b) => a - b);
  rowZ.forEach((z, i) => {
    if (i % 2 === 0) {
      const sideSeats = seats.filter((s) => Math.abs(s.z - z) < 0.01 && Math.abs(s.x) < 0.6);
      for (const s of sideSeats) pole(Math.sign(s.x) * 0.23, z + 0.22, s.y + 0.35);
    }
  });
  for (const d of sec.doors) {
    pole(-(xi - 0.25), d.z0 - 0.06, floorAt(d.z0));
    pole(-(xi - 0.25), d.z1 + 0.06, floorAt(d.z1));
    // horizontal rail beside the door
    po.rod(V(-(xi - 0.25), 1.0, Z(d.z1 + 0.06)), V(-0.3, 1.0, Z(d.z1 + 0.06)), 0.016, COL.yellow, 6);
  }
  if (driver) {
    pole(0.1, 1.35, 1.32, false);
    po.rod(V(0.1, 1.2, Z(1.35)), V(0.1, 1.2, Z(1.86)), 0.016, COL.yellow, 6);
    po.rod(V(-xi + 0.1, 1.15, Z(0.35)), V(0.0, 1.15, Z(0.35)), 0.016, COL.yellow, 6);
  }
  // wheelchair bay rail (left wall, section 0)
  if (sec.index === 0) po.rod(V(-xi + 0.05, 0.95, Z(3.5)), V(-xi + 0.05, 0.95, Z(4.6)), 0.016, COL.yellow, 6);
  const poles = new THREE.Mesh(po.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  poles.name = 'poles';
  group.add(poles);

  // --- ceiling LED strips
  const li = new GeoBuilder();
  const lz0 = driver ? 2.05 : zStart + 0.2;
  for (const x of [-(xi - 0.36), xi - 0.36]) {
    li.quad(V(x - 0.035, B.ceiling - 0.012, Z(lz0)), V(x + 0.035, B.ceiling - 0.012, Z(lz0)), V(x + 0.035, B.ceiling - 0.012, Z(zEnd - 0.2)), V(x - 0.035, B.ceiling - 0.012, Z(zEnd - 0.2)), [1, 1, 1]);
  }
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xf4f7ff, side: THREE.DoubleSide });
  const lights = new THREE.Mesh(li.build(), lightMat);
  lights.name = 'ceilingLights';
  group.add(lights);

  // --- tinted glass
  const gl = new GeoBuilder();
  gl.alpha = [];
  const tint: RGB = [0.04, 0.06, 0.08];
  for (const side of [1, -1]) {
    const x = side * (xi + 0.035);
    for (const w of side > 0 ? sec.windowsR : sec.windowsL) {
      if (side > 0) gl.quad(V(x, w.y0, Z(w.z0)), V(x, w.y0, Z(w.z1)), V(x, w.y1, Z(w.z1)), V(x, w.y1, Z(w.z0)), tint, undefined, 0.3);
      else gl.quad(V(x, w.y0, Z(w.z1)), V(x, w.y0, Z(w.z0)), V(x, w.y1, Z(w.z0)), V(x, w.y1, Z(w.z1)), tint, undefined, 0.3);
    }
  }
  if (sec.isRear) {
    const metro = B.type === 'metro';
    const w0 = metro ? 1.05 : 1.95, w1 = metro ? 2.76 : 2.78;
    const z0 = Z(rearZ(B, sec, w0) - 0.05), z1 = Z(rearZ(B, sec, w1) - 0.05);
    gl.quad(V(B.hw - 0.27, w0, z0), V(-B.hw + 0.27, w0, z0), V(-B.hw + 0.27, w1, z1), V(B.hw - 0.27, w1, z1), tint, undefined, 0.35);
  }
  if (driver) {
    // driver's safety screen
    gl.quad(V(0.17, 1.53, Z(1.89)), V(0.17, 1.53, Z(0.95)), V(0.17, 2.2, Z(0.95)), V(0.17, 2.2, Z(1.89)), [0.55, 0.62, 0.66], undefined, 0.1);
    gl.quad(V(0.17, 1.53, Z(1.89)), V(0.72, 1.53, Z(1.89)), V(0.72, 2.2, Z(1.89)), V(0.17, 2.2, Z(1.89)), [0.55, 0.62, 0.66], undefined, 0.1);
  }
  const glassMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const glass = new THREE.Mesh(gl.build(), glassMat);
  glass.name = 'glass';
  glass.renderOrder = 2;
  group.add(glass);

  const mats: THREE.MeshBasicMaterial[] = [structure.material as THREE.MeshBasicMaterial, seatMat, poles.material as THREE.MeshBasicMaterial];
  return {
    group,
    seats,
    floorAt,
    setNight(night) {
      const k = night ? 0.95 : 0.85;
      for (const mm of mats) mm.color.setScalar(k);
      lightMat.color.setScalar(night ? 1.35 : 0.95);
    },
    dispose() {
      structure.geometry.dispose();
      poles.geometry.dispose();
      lights.geometry.dispose();
      glass.geometry.dispose();
      for (const mm of [...mats, lightMat, glassMat]) mm.dispose();
      seatMesh.dispose();
    },
  };
}

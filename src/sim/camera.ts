/**
 * Camera modes:
 *  cab        first person from the driver's seat, with head motion from
 *             acceleration and cornering, road vibration, mirror/saloon looks
 *             and mouse/stick free look;
 *  chase      spring-damped follow behind and above, swings round in turns and
 *             looks into them; frames the whole vehicle (25 m Metro included);
 *  top        high overhead, heading-up (or north-up with `northUp`);
 *  cinematic  roadside cameras placed ahead of the bus that cut as it passes,
 *             plus drone, tracking and (when stopped) orbit shots.
 */
import * as THREE from 'three';
import type { BusMesh, BusPose, Cab, Collider, DriveInput } from '../types';
import { activeCollider, isSimCollider, type SimCollider } from './collider';
import { isSimInput, onSimEvent, telemetry } from './hub';

export type CameraMode = 'cab' | 'chase' | 'top' | 'cinematic';
const MODES: CameraMode[] = ['cab', 'chase', 'top', 'cinematic'];
/** Resting cab head pitch: a driver looks slightly down the road, so the
 * windscreen top sits near the top of the view and the dash below. */
const CAB_PITCH = -0.12;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrap = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const dampAngle = (cur: number, target: number, rate: number, dt: number) => cur + wrap(target - cur) * (1 - Math.exp(-rate * dt));

type ShotKind = 'roadside' | 'drone' | 'tracking' | 'orbit' | 'lowfront';
interface Shot {
  kind: ShotKind;
  x: number;
  y: number;
  /** Height above the bus's road level (moving shots) and absolute height (fixed shots, m AHD). */
  h: number;
  z: number;
  t: number;
  maxT: number;
  side: number;
  blocked: number;
  angle: number;
}

/** Critically damped 3D spring for positions (exact step, allocation-free). */
class Spring3 {
  p = new THREE.Vector3();
  v = new THREE.Vector3();
  init = false;
  private x = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  update(target: THREE.Vector3, omega: number, dt: number): THREE.Vector3 {
    if (!this.init) {
      this.p.copy(target);
      this.v.set(0, 0, 0);
      this.init = true;
      return this.p;
    }
    const e = Math.exp(-omega * dt);
    const x = this.x.copy(this.p).sub(target);
    const tmp = this.tmp.copy(this.v).addScaledVector(x, omega).multiplyScalar(dt);
    this.v.addScaledVector(tmp, -omega).multiplyScalar(e);
    this.p.copy(target).addScaledVector(x.add(tmp), e);
    return this.p;
  }
}

export class CameraRig {
  mode: CameraMode = 'cab';
  /** Top view: keep north up instead of rotating with the bus. */
  northUp = false;
  /** Cab: allow the auto look-into-turns. */
  lookIntoTurns = true;
  /** The bus and cab last passed to update() (for tooling). */
  last: { bus: BusMesh; cab: Cab } | null = null;
  /** Chase-camera internals from the last frame (for tooling). */
  readonly debug: Record<string, number> = {};

  private collider: SimCollider | null;
  private interior: boolean | null = null;
  private time = 0;
  private fov = 70;
  private zoomCab = 0;
  private zoomChase = 0;
  private zoomTop = 0;

  // cab
  private headX = 0;
  private headZ = 0;
  private headVX = 0;
  private headVZ = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private shakeAmp = 0;

  // chase / top
  private chaseHeading = 0;
  private chaseOffset = new Spring3();
  private chaseTarget = new Spring3();
  private chasePull = 1;
  private topHeading = 0;
  private headingInit = false;
  /** Smoothed bus height (m AHD) and 0..1 "in a tunnel" blend. */
  private busZ = 0;
  private busZInit = false;
  private tunnelF = 0;

  // cinematic
  private shot: Shot | null = null;
  private shotLook = new Spring3();
  private stillT = 0;
  private seed = 0x9e3779b9;

  // transitions
  private blendT = 1;
  private blendFromPos = new THREE.Vector3();
  private blendFromQuat = new THREE.Quaternion();

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tmpM = new THREE.Matrix4();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    collider?: Collider,
  ) {
    this.collider = collider && isSimCollider(collider) ? collider : null;
    const dbg = (globalThis as { __busSim?: object }).__busSim;
    if (dbg) Object.assign(dbg, { rig: this });
    onSimEvent((e) => {
      if (e.type === 'impact') this.shakeAmp = Math.min(0.12, this.shakeAmp + e.strength * 0.012);
      if (e.type === 'splash') this.shakeAmp = 0.1;
    });
  }

  cycle(): void {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    // Smooth hand-over between the exterior orbit modes; cuts everywhere else.
    const smooth = (prev === 'chase' || prev === 'top') && (m === 'chase' || m === 'top');
    if (smooth) {
      this.blendT = 0;
      this.blendFromPos.copy(this.camera.position);
      this.blendFromQuat.copy(this.camera.quaternion);
    } else this.blendT = 1;
    this.shot = null;
    this.chaseOffset.init = false;
    this.chaseTarget.init = false;
    this.camera.up.set(0, 1, 0);
  }

  update(dt: number, bus: BusMesh, cab: Cab, pose: BusPose, input: DriveInput): void {
    this.time += dt;
    this.last = { bus, cab };
    if (!this.collider && activeCollider) this.collider = activeCollider;
    const inside = this.mode === 'cab';
    if (this.interior !== inside) {
      bus.setInteriorView(inside);
      this.interior = inside;
    }
    telemetry.view = this.mode;
    const sim = isSimInput(input) ? input : null;
    if (sim && sim.zoom) {
      if (this.mode === 'cab') this.zoomCab = clamp(this.zoomCab + sim.zoom * 4, -25, 15);
      else if (this.mode === 'chase') this.zoomChase = clamp(this.zoomChase + sim.zoom * 2.5, -8, 30);
      else if (this.mode === 'top') this.zoomTop = clamp(this.zoomTop + sim.zoom * 10, -30, 250);
    }
    if (!this.headingInit) {
      this.chaseHeading = this.rearHeading(pose);
      this.topHeading = pose.heading;
      this.headingInit = true;
    }
    this.shakeAmp *= Math.exp(-dt * 5);
    let zs = 0;
    for (const sp of pose.sections) zs += sp.z ?? pose.z ?? 0;
    const zNow = pose.sections.length ? zs / pose.sections.length : (pose.z ?? 0);
    if (!this.busZInit || Math.abs(zNow - this.busZ) > 8) {
      this.busZ = zNow;
      this.busZInit = true;
    } else this.busZ = damp(this.busZ, zNow, 10, dt);
    this.tunnelF = damp(this.tunnelF, telemetry.inTunnel ? 1 : 0, 2.5, dt);

    let targetFov = 70;
    switch (this.mode) {
      case 'cab':
        targetFov = 70 + this.zoomCab;
        this.updateCab(dt, bus, cab, pose, input, sim);
        break;
      case 'chase':
        targetFov = 60;
        this.updateChase(dt, bus, pose, input, sim);
        break;
      case 'top':
        targetFov = 50;
        this.updateTop(dt, bus, pose);
        break;
      case 'cinematic':
        targetFov = this.updateCinematic(dt, bus, pose);
        break;
    }
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / 0.6);
      const e = this.blendT * this.blendT * (3 - 2 * this.blendT);
      this.camera.position.lerpVectors(this.blendFromPos, this.camera.position, e);
      this.tmpQ.copy(this.camera.quaternion);
      this.camera.quaternion.slerpQuaternions(this.blendFromQuat, this.tmpQ, e);
    }
    const cut = this.mode === 'cinematic' && this.shot !== null && this.shot.t < dt * 1.5;
    this.fov = cut ? targetFov : damp(this.fov, targetFov, 6, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers (map coordinates)

  private totalLength(bus: BusMesh): number {
    let l = 0;
    for (const s of bus.spec.sections) l += s.length;
    return l;
  }

  /** Map-space point of the vehicle's front face and rear face. */
  private ends(bus: BusMesh, pose: BusPose): { fx: number; fy: number; rx: number; ry: number } {
    const s0 = bus.spec.sections[0];
    const p0 = pose.sections[0] ?? pose;
    const n = bus.spec.sections.length;
    const sl = bus.spec.sections[n - 1];
    const pl = pose.sections[n - 1] ?? pose;
    return {
      fx: p0.x + Math.sin(p0.heading) * s0.axleFromFront,
      fy: p0.y + Math.cos(p0.heading) * s0.axleFromFront,
      rx: pl.x - Math.sin(pl.heading) * (sl.length - sl.axleFromFront),
      ry: pl.y - Math.cos(pl.heading) * (sl.length - sl.axleFromFront),
    };
  }

  private rearHeading(pose: BusPose): number {
    return (pose.sections[pose.sections.length - 1] ?? pose).heading;
  }

  // ---------------------------------------------------------------------------

  private updateCab(dt: number, bus: BusMesh, cab: Cab, pose: BusPose, input: DriveInput, sim: ReturnType<typeof asSim>): void {
    const g = bus.sections[0];
    g.updateWorldMatrix(true, false);
    const t = telemetry;
    const speed = Math.abs(pose.speed);

    // Head on a soft spring: lags behind acceleration, leans out in corners.
    const aLong = clamp(t.accelLong, -6, 4);
    const aLat = clamp(t.accelLat, -6, 6);
    const tz = aLong * 0.011; // + = head pushed back (local +Z is backwards)
    const tx = -aLat * 0.009; // leans outward
    const w = 7;
    const z = 0.65;
    this.headVZ += (w * w * (tz - this.headZ) - 2 * z * w * this.headVZ) * dt;
    this.headVX += (w * w * (tx - this.headX) - 2 * z * w * this.headVX) * dt;
    this.headZ += this.headVZ * dt;
    this.headX += this.headVX * dt;

    // Vibration: road texture with speed, plus a faint idle shudder.
    const tt = this.time;
    const road = Math.min(1, speed / 14);
    const vib =
      road * 0.0022 * (Math.sin(tt * 47.1) * 0.5 + Math.sin(tt * 71.3 + 1.3) * 0.3 + Math.sin(tt * 23.7 + 0.4) * 0.6) +
      0.00035 * Math.sin(tt * 2 * Math.PI * (t.rpm / 60) * 0.5) * (t.busType === 'metro' ? 0.2 : 1);
    const shake = this.shakeAmp * (Math.sin(tt * 61) + Math.sin(tt * 37.7)) * 0.5;

    // Look targets.
    const held = input.held;
    let yawT = 0;
    let pitchT = 0;
    let lean = 0;
    if (held.has('lookBack')) {
      yawT = 2.75;
      pitchT = -0.2;
      lean = 1;
    } else if (held.has('lookLeft')) {
      yawT = 1.0;
      pitchT = -0.07;
    } else if (held.has('lookRight')) {
      yawT = -1.18;
      pitchT = -0.06;
    }
    if (this.lookIntoTurns && yawT === 0) {
      const f = speed < 6 ? 1 : Math.max(0.25, 1 - (speed - 6) / 10);
      yawT += -pose.steer * 0.32 * f;
    }
    if (sim) {
      yawT += sim.lookYaw;
      pitchT += sim.lookPitch;
    }
    const rate = sim?.lookActive ? 30 : 9;
    this.lookYaw = damp(this.lookYaw, yawT, rate, dt);
    this.lookPitch = damp(this.lookPitch, pitchT, rate, dt);
    const leanBlend = clamp(this.lookYaw / 2.75, 0, 1) * lean;

    const eye = this.tmpV.copy(cab.eye);
    eye.x += this.headX - leanBlend * 0.32;
    eye.y += vib + shake * 0.3 + leanBlend * 0.04;
    eye.z += this.headZ + leanBlend * 0.12;
    this.camera.position.copy(eye.applyMatrix4(g.matrixWorld));

    // Orientation: section frame x head look x a share of the body roll.
    this.tmpM.extractRotation(g.matrixWorld);
    this.camera.quaternion.setFromRotationMatrix(this.tmpM);
    const headPitch = CAB_PITCH + this.lookPitch + aLong * 0.004 + vib * 0.6 + shake * 0.2;
    const headRoll = -pose.roll * 0.5 + aLat * 0.0035;
    this.tmpE.set(headPitch, this.lookYaw, headRoll, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpE);
    this.camera.quaternion.multiply(this.tmpQ);
  }

  private updateChase(dt: number, bus: BusMesh, pose: BusPose, input: DriveInput, sim: ReturnType<typeof asSim>): void {
    const L = this.totalLength(bus);
    const e = this.ends(bus, pose);
    const cx = (e.fx + e.rx) / 2;
    const cy = (e.fy + e.ry) / 2;
    const chainHeading = Math.atan2(e.fx - e.rx, e.fy - e.ry);
    this.chaseHeading = dampAngle(this.chaseHeading, chainHeading, 2.2, dt);
    const speed = Math.abs(pose.speed);

    let orbit = sim ? sim.lookYaw : 0;
    if (input.held.has('lookBack')) orbit += Math.PI;
    else if (input.held.has('lookLeft')) orbit += 1.2;
    else if (input.held.has('lookRight')) orbit -= 1.2;
    const pitchAdd = sim ? sim.lookPitch : 0;

    // Behind the rear face: ~8 m for a 12.5 m bus, ~11 m for the 25 m Metro (plus a little with speed).
    // In a tunnel: lower and closer, under the ~5 m ceiling.
    const tf = this.tunnelF;
    const dist = (5 + L * 0.25 + this.zoomChase + Math.min(3, speed * 0.12)) * (1 - 0.35 * tf);
    let hgt = Math.max(1.5, 2.6 + L * 0.14 + this.zoomChase * 0.3 - pitchAdd * 8);
    hgt = hgt + (Math.min(hgt, 3.9) - hgt) * tf;
    const hd = this.chaseHeading + orbit;
    const bz = this.busZ;
    // Desired offset from the vehicle centre (map coords), behind along the smoothed heading.
    let ox = -Math.sin(hd) * (dist + L / 2);
    let oy = -Math.cos(hd) * (dist + L / 2);
    let oz = hgt;
    const col = this.collider;
    if (col) {
      // Not under the road or the ground behind the bus (hills, ramps)...
      const gx = cx + ox;
      const gy = cy + oy;
      const under = col.surface(gx, gy, bz, 2.5);
      const floor = (under.road >= 0 ? under.z : tf > 0.5 ? bz : col.ground(gx, gy)) + 1.2 - bz;
      if (oz < floor) oz = floor;
      // ...and under the ceiling there and on the way (tube, deck soffit, a building or canopy over the
      // road): lower rather than pulled in through the ceiling.
      const top = Math.min(col.ceilingAt(gx, gy, bz + 0.5), col.ceilingAt(cx + ox * 0.5, cy + oy * 0.5, bz + 0.5)) - 0.5 - bz;
      if (oz > top) oz = Math.max(1.0, top);
      this.debug.ceil = top;
      // ...and pulled in along the line of sight past buildings, walls, tunnel walls and hillsides.
      const t = col.lineOfSight(cx, cy, bz + 2.0, cx + ox, cy + oy, bz + oz, L / 2 + 2);
      this.debug.los = t;
      this.debug.floor = floor;
      this.debug.under = under.road;
      this.debug.dist = Math.hypot(ox, oy);
      const lenO = Math.hypot(ox, oy, oz - 2);
      const target = t < 1 ? Math.max(0.15, t - 0.8 / Math.max(lenO, 1)) : 1;
      this.chasePull = damp(this.chasePull, target, target < this.chasePull ? 12 : 2, dt);
      ox *= this.chasePull;
      oy *= this.chasePull;
      oz = 2 + (oz - 2) * this.chasePull;
    }
    const off = this.tmpV.set(ox, oz, -oy);
    const o = this.tmpV3.copy(this.chaseOffset.update(off, 6, dt));
    if (col) {
      // The spring lags behind the target: never leave the camera up in a ceiling or behind a wall.
      const top = col.ceilingAt(cx + o.x, cy - o.z, bz + 0.5) - 0.35 - bz;
      if (o.y > top) o.y = Math.max(1.0, top);
      const t = col.lineOfSight(cx, cy, bz + 2.0, cx + o.x, cy - o.z, bz + o.y, L / 2 + 2);
      if (t < 1) {
        const k = Math.max(0.1, t - 0.5 / Math.max(1, Math.hypot(o.x, o.z, o.y - 2)));
        o.x *= k;
        o.z *= k;
        o.y = 2 + (o.y - 2) * k;
      }
      this.debug.hard = t;
    }
    const lead = Math.min(L * 0.25 + speed * 0.3, 14);
    const turn = clamp(telemetry.yawRate * Math.max(speed, 2) * 0.9, -8, 8);
    const fH = this.chaseHeading;
    const lx = cx + Math.sin(fH) * lead + Math.cos(fH) * turn;
    const ly = cy + Math.cos(fH) * lead - Math.sin(fH) * turn;
    // Look ahead along the grade too.
    const lz = 1.6 + Math.tan(telemetry.grade) * lead;
    const look = this.chaseTarget.update(this.tmpV2.set(lx - cx, lz, -(ly - cy)), 8, dt);
    this.camera.position.set(cx + o.x, bz + o.y, -cy + o.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(cx + look.x, bz + look.y, -cy + look.z);
    if (this.shakeAmp > 1e-3) this.camera.rotateZ(this.shakeAmp * Math.sin(this.time * 53) * 0.3);
  }

  private updateTop(dt: number, bus: BusMesh, pose: BusPose): void {
    const L = this.totalLength(bus);
    const e = this.ends(bus, pose);
    const cx = (e.fx + e.rx) / 2;
    const cy = (e.fy + e.ry) / 2;
    this.topHeading = dampAngle(this.topHeading, pose.heading, 1.5, dt);
    const H = Math.max(15, 30 + L * 1.1 + this.zoomTop);
    const hd = this.northUp ? 0 : this.topHeading;
    const fx = Math.sin(hd);
    const fy = Math.cos(hd);
    const ahead = L * 0.4 + Math.abs(pose.speed) * 0.8;
    const tx = cx + Math.sin(this.topHeading) * ahead;
    const ty = cy + Math.cos(this.topHeading) * ahead;
    const bz = this.busZ;
    // In a tunnel the street is in the way: drop to a steep view inside the tube.
    const tf = this.tunnelF;
    const h = H + (4.4 - H) * tf;
    const back = H * 0.18 + (L * 0.5 + 3 - H * 0.18) * tf;
    this.camera.position.set(tx - fx * back, bz + h, -(ty - fy * back));
    this.camera.up.set(fx, 0, -fy);
    this.camera.lookAt(tx, bz, -ty);
  }

  // ---------------------------------------------------------------------------
  // Cinematic

  private rand(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  private updateCinematic(dt: number, bus: BusMesh, pose: BusPose): number {
    const L = this.totalLength(bus);
    const e = this.ends(bus, pose);
    const cx = (e.fx + e.rx) / 2;
    const cy = (e.fy + e.ry) / 2;
    const speed = Math.abs(pose.speed);
    this.stillT = speed < 0.4 ? this.stillT + dt : 0;

    let s = this.shot;
    if (s) {
      s.t += dt;
      if (s.kind === 'orbit' && this.stillT === 0 && s.t > 2) s = null;
    }
    if (s && (s.kind === 'roadside' || s.kind === 'drone' || s.kind === 'lowfront')) {
      // Has the bus gone past (camera now behind its rear) or too far away?
      const dx = s.x - cx;
      const dy = s.y - cy;
      const fwd = dx * Math.sin(pose.heading) + dy * Math.cos(pose.heading);
      const d = Math.hypot(dx, dy);
      if (fwd < -(L * 0.5 + 10) || d > 140) s = null;
      if (s && this.collider && Math.floor(s.t * 4) !== Math.floor((s.t - dt) * 4)) {
        const clear = this.collider.lineOfSight(s.x, s.y, s.z, cx, cy, this.busZ + 1.6) >= 0.98;
        s.blocked = clear ? 0 : s.blocked + 0.25;
        if (s.blocked > 0.6) s = null;
      }
    }
    if (s && s.t > s.maxT) s = null;
    if (!s) s = this.newShot(pose, cx, cy, L);
    this.shot = s;
    const bz = this.busZ;
    const tunnel = this.tunnelF > 0.5;

    // Moving shots ride along at the bus's level (kept inside the tube in tunnels, above ground outside).
    if (s.kind === 'tracking' || s.kind === 'orbit') {
      if (s.kind === 'tracking') {
        const hd = pose.heading;
        const back = -2 - L * 0.1;
        const lat = s.side * (tunnel ? 2.4 : 5.5 + L * 0.12);
        s.x = cx + Math.sin(hd) * back + Math.cos(hd) * lat;
        s.y = cy + Math.cos(hd) * back - Math.sin(hd) * lat;
      } else {
        s.angle += dt * 0.16 * s.side;
        const r = tunnel ? 7 + L * 0.3 : 12 + L * 0.55;
        s.x = cx + Math.sin(s.angle) * r;
        s.y = cy + Math.cos(s.angle) * r;
      }
      let z = bz + (tunnel ? Math.min(s.h, 3.2) : s.h);
      const col = this.collider;
      if (col && !tunnel) z = Math.max(z, col.ground(s.x, s.y) + 1);
      if (col) z = Math.min(z, Math.max(bz + 1, col.ceilingAt(s.x, s.y, bz + 0.5) - 0.4));
      s.z = z;
      if (col && (col.viewBlocked(s.x, s.y, z) || col.lineOfSight(s.x, s.y, z, cx, cy, bz + 1.6) < 0.9)) s.maxT = Math.min(s.maxT, s.t + 0.3);
    }

    const first = s.t < dt * 1.5;
    if (first) this.shotLook.init = false;
    const look = this.shotLook.update(this.tmpV2.set(cx + Math.sin(pose.heading) * 2, bz + 1.5, -(cy + Math.cos(pose.heading) * 2)), 4, dt);
    this.camera.position.set(s.x, s.z, -s.y);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    const dist = Math.hypot(s.x - cx, s.y - cy, s.z - bz - 1.5);
    const span = s.kind === 'drone' ? L * 0.9 + 8 : L * 0.62 + 2;
    const fov = ((2 * Math.atan(span / Math.max(1, dist))) * 180) / Math.PI;
    return clamp(fov, s.kind === 'roadside' ? 14 : 22, 62);
  }

  private newShot(pose: BusPose, cx: number, cy: number, L: number): Shot {
    const speed = Math.abs(pose.speed);
    const side = this.rand() < 0.62 ? -1 : 1; // favour the kerb (left) side
    const bz = this.busZ;
    const tunnel = this.tunnelF > 0.5;
    const base: Shot = { kind: 'roadside', x: cx, y: cy, h: 1.6, z: bz + 1.6, t: 0, maxT: 14, side, blocked: 0, angle: 0 };
    if (this.stillT > 1.5) {
      // Start off the front quarter on the kerb side and drift slowly round.
      return { ...base, kind: 'orbit', h: 3.2 + this.rand() * 3, angle: pose.heading + side * (0.6 + this.rand() * 0.6), maxT: 30 };
    }
    const roll = this.rand();
    if (roll < 0.18) return { ...base, kind: 'tracking', h: 1.3 + this.rand() * 1.5, maxT: 6 + this.rand() * 4 };
    let kind: ShotKind = roll < 0.36 ? 'drone' : roll < 0.48 ? 'lowfront' : 'roadside';
    if (tunnel && kind === 'drone') kind = 'roadside';
    // Predict where the bus will be in a few seconds along its current arc.
    for (let attempt = 0; attempt < 8; attempt++) {
      const ahead = (kind === 'lowfront' ? 22 : 38) + speed * (kind === 'drone' ? 3.2 : 2.4) + this.rand() * 14 + L * 0.5;
      const tAhead = ahead / Math.max(speed, 4);
      const hd = pose.heading + clamp(telemetry.yawRate, -0.25, 0.25) * tAhead * 0.5;
      const sd = attempt % 2 === 0 ? side : -side;
      const latM = tunnel ? 2.2 + this.rand() * 1.2 : kind === 'lowfront' ? 2.5 + this.rand() * 1.5 : 6 + this.rand() * 5 + (kind === 'drone' ? 8 : 0);
      const lat = sd * latM;
      const px = cx + Math.sin(hd) * ahead + Math.cos(hd) * lat;
      const py = cy + Math.cos(hd) * ahead - Math.sin(hd) * lat;
      const h = kind === 'drone' ? 16 + this.rand() * 18 : kind === 'lowfront' ? 0.6 : tunnel ? 1.2 + this.rand() * 1.8 : 1.1 + this.rand() * 1.6;
      // Stand on the road at the bus's level if there is one there (tunnels, viaducts), else on the ground.
      let pz = bz + h;
      const col = this.collider;
      if (col) {
        const sfc = col.surface(px, py, bz, 2.5);
        if (tunnel && sfc.road < 0) continue;
        const gz = sfc.road >= 0 ? sfc.z : col.ground(px, py);
        pz = gz + h;
        if (col.viewBlocked(px, py, pz) || col.ceilingAt(px, py, gz + 0.3) < pz + 0.3) continue;
        if (col.lineOfSight(px, py, pz, cx, cy, bz + 1.6) < 0.98) continue;
      }
      return { ...base, kind, x: px, y: py, h, z: pz, side: sd, maxT: kind === 'drone' ? 12 : 16 };
    }
    return { ...base, kind: 'tracking', h: 1.8, maxT: 5 };
  }
}

function asSim(i: DriveInput) {
  return isSimInput(i) ? i : null;
}

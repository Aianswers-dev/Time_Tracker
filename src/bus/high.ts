// High-detail player bus: painted shell with arch/door cut-outs, glossy
// reflective paint and glass, instanced spinning/steering wheels, animated
// plug doors, LED destination signs, lamp glows + a real headlight SpotLight,
// body roll/pitch, deforming bellows and (Metro) saloon interiors for the
// rear sections in first-person view.
import * as THREE from 'three';
import type { BusLights, BusMesh, BusPose, BusSpec, DestinationSign, Route } from '../types';
import { headingToRotY, toWorld } from '../data/coords';
import { layoutFor, type BodyLayout, type SectionLayout } from './spec';
import { atlasLayout, buildShell, frontZ } from './shell';
import { paintSection } from './paint';
import { liveryFor, makeLivery, type Livery } from './livery';
import { lampGeometry, type LampKind } from './lamps';
import { Bellows, buildDark, buildSignGeometry, buildTrim, leafGeometry, leafMatrix, leafSlots, wheelGeometry, wheelSlots, type LeafSlot, type WheelSlot } from './parts';
import { doorTexture, envMap, wheelTexture } from './materials';
import { blankSignMaterial, signMaterial } from './sign';
import { buildSaloon, type Saloon } from './saloon';
import { playerSign } from './state';
import { canvasTexture } from './util';
import { haloGeometry, haloMaterial } from './halo';
import { mirrorGlassGeometry, mirrorTexture } from './mirror';

type LampGroup = 'drl' | 'night' | 'brake' | 'indL' | 'indR' | 'reverse';
const LAMP_GROUPS: Record<LampGroup, LampKind[]> = {
  drl: ['drl'],
  night: ['head', 'tail', 'markerF', 'markerR', 'markerS'],
  brake: ['brake'],
  indL: ['indL'],
  indR: ['indR'],
  reverse: ['reverse'],
};

interface SecParts {
  L: SectionLayout;
  root: THREE.Group;
  pivot: THREE.Group;
  shell: THREE.Mesh;
  shellMat: THREE.MeshStandardMaterial;
  dark: THREE.Mesh;
  wells: THREE.Mesh | null;
  trim: THREE.Mesh;
  wheels: THREE.InstancedMesh;
  slots: WheelSlot[];
  doors: THREE.InstancedMesh | null;
  leaves: LeafSlot[];
  sign: THREE.Mesh | null;
  lamps: Partial<Record<LampGroup, THREE.Mesh>>;
  halo: THREE.Mesh | null;
  bellows: Bellows | null;
  bellowsMesh: THREE.Mesh | null;
  interior: Saloon | null;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export function createHighBus(spec: BusSpec, route: Route | undefined): BusMesh {
  const B: BodyLayout = layoutFor(spec.type);
  const lv: Livery = makeLivery(liveryFor(spec.type, route), route?.id ?? '');
  const env = envMap();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const darkMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const trimMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, envMap: env, envMapIntensity: 0.8 }));
  const wheelMat = own(new THREE.MeshStandardMaterial({ map: wheelTexture(), roughness: 0.55, metalness: 0.25, envMap: env, envMapIntensity: 0.6 }));
  const doorMat = own(
    new THREE.MeshStandardMaterial({ map: doorTexture(spec.type === 'metro'), transparent: true, roughness: 0.15, metalness: 0.0, envMap: env, envMapIntensity: 0.45, side: THREE.DoubleSide }),
  );
  const glowMat = own(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  // wing mirror glass shows the cab's painted reflections (mirror.ts)
  const mirrorMat = own(new THREE.MeshBasicMaterial({ map: mirrorTexture(), color: 0xe6eaee }));
  const bellowsMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.35, envMap: env, envMapIntensity: 0.7, side: THREE.DoubleSide }));
  const wheelGeo = own(wheelGeometry(B.tyreR, 0.28, 28));
  const leafGeo = own(leafGeometry());
  let signMat: THREE.MeshBasicMaterial = blankSignMaterial(lv.sign);

  let offset = 0;
  const secs: SecParts[] = B.sections.map((L, i) => {
    const root = new THREE.Group();
    root.name = `bus-${spec.type}-section${i}`;
    const pivot = new THREE.Group();
    const inner = new THREE.Group();
    const zc = (L.bodyFront + L.bodyRear) / 2 - L.axleFromFront;
    pivot.position.set(0, 0.85, zc);
    inner.position.set(0, -0.85, -zc);
    pivot.add(inner);
    root.add(pivot);

    const atlas = atlasLayout(B, L, 1);
    const paint = paintSection(B, L, atlas, lv, { cutDoors: true, scale: 1, offset });
    offset += L.span;
    const map = own(canvasTexture(paint.color));
    const emissiveMap = own(canvasTexture(paint.emissive));
    const roughnessMap = own(canvasTexture(paint.rough, false));
    const shellMat = own(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap,
        roughnessMap,
        roughness: 1,
        metalness: 0,
        alphaTest: 0.5,
        envMap: env,
        envMapIntensity: 0.9,
        emissive: new THREE.Color(0xfff4e6),
        emissiveIntensity: 0,
      }),
    );
    const shell = new THREE.Mesh(own(buildShell(B, L, atlas, { detail: 'high' })), shellMat);
    shell.name = 'shell';
    inner.add(shell);

    const dark = new THREE.Mesh(own(buildDark(B, L, { doorWells: false, staticWheels: false })), darkMat);
    dark.name = 'underbody';
    inner.add(dark);
    let wells: THREE.Mesh | null = null;
    if (L.doors.length || !L.isFront || !L.isRear) {
      wells = new THREE.Mesh(own(buildDark(B, L, { underbody: false, doorWells: true, staticWheels: false, jointCaps: true })), darkMat);
      wells.name = 'doorWells';
      inner.add(wells);
    }
    const trim = new THREE.Mesh(own(buildTrim(B, L, lv)), trimMat);
    trim.name = 'trim';
    inner.add(trim);
    const mg = mirrorGlassGeometry(B, L);
    if (mg) {
      const glassMesh = new THREE.Mesh(own(mg), mirrorMat);
      glassMesh.name = 'mirrorGlass';
      inner.add(glassMesh);
    }

    const slots = wheelSlots(B, L);
    const wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, slots.length);
    wheels.name = 'wheels';
    wheels.frustumCulled = false;
    root.add(wheels);

    const leaves = leafSlots(B, L);
    let doors: THREE.InstancedMesh | null = null;
    if (leaves.length) {
      doors = new THREE.InstancedMesh(leafGeo, doorMat, leaves.length);
      doors.name = 'doors';
      doors.frustumCulled = false;
      doors.renderOrder = 1;
      leaves.forEach((s, k) => doors?.setMatrixAt(k, leafMatrix(s, 0, _m)));
      inner.add(doors);
    }

    const sg = buildSignGeometry(B, L, ['front', 'side', 'rear']);
    let sign: THREE.Mesh | null = null;
    if (sg) {
      sign = new THREE.Mesh(own(sg), signMat);
      sign.name = 'destination';
      inner.add(sign);
    }

    const lamps: Partial<Record<LampGroup, THREE.Mesh>> = {};
    for (const g of Object.keys(LAMP_GROUPS) as LampGroup[]) {
      const geo = lampGeometry(B, L, LAMP_GROUPS[g]);
      if (!geo) continue;
      own(geo);
      const m = new THREE.Mesh(geo, glowMat);
      m.name = `lamp-${g}`;
      m.visible = g === 'drl';
      inner.add(m);
      lamps[g] = m;
    }
    const hg = haloGeometry(B, L);
    let halo: THREE.Mesh | null = null;
    if (hg) {
      halo = new THREE.Mesh(own(hg), haloMaterial());
      halo.visible = false;
      halo.renderOrder = 5;
      inner.add(halo);
    }

    let bellows: Bellows | null = null;
    let bellowsMesh: THREE.Mesh | null = null;
    if (i > 0) {
      bellows = new Bellows(B);
      own(bellows.geometry);
      bellowsMesh = new THREE.Mesh(bellows.geometry, bellowsMat);
      bellowsMesh.name = 'bellows';
      bellowsMesh.frustumCulled = false;
      root.add(bellowsMesh);
    }
    let interior: Saloon | null = null;
    if (i > 0) {
      interior = buildSaloon(B, L, false);
      interior.group.visible = false;
      inner.add(interior.group);
      disposables.push(interior);
    }
    return { L, root, pivot, shell, shellMat, dark, wells, trim, wheels, slots, doors, leaves, sign, lamps, halo, bellows, bellowsMesh, interior };
  });

  // headlight spot (kept in the scene with intensity 0 when off so the
  // light count never changes and no shaders recompile)
  const s0 = secs[0];
  const zf = frontZ(B, s0.L, 0.8) - s0.L.axleFromFront;
  const spot = new THREE.SpotLight(0xfff4e0, 0, 75, 0.62, 0.55, 1.2);
  spot.position.set(0, 0.95, zf - 0.15);
  spot.target.position.set(0, 0, zf - 28);
  spot.castShadow = false;
  s0.root.add(spot);
  s0.root.add(spot.target);

  const sections = secs.map((s) => s.root);
  let inside = false;
  let lastNight: boolean | null = null;
  let doorT = -1;

  function updateWells(): void {
    // The cab interior is sealed inside the shell, so it is only drawn in
    // first-person; outside views get the cheap dark door wells instead.
    for (const c of sections[0].children) if (c.userData.busCab === true) c.visible = inside;
    secs.forEach((s) => {
      if (s.wells) s.wells.visible = !inside;
    });
  }

  function setWheels(pose: BusPose): void {
    const wb = spec.wheelbase;
    const tan = Math.tan(pose.steer);
    secs.forEach((s) => {
      s.slots.forEach((w, k) => {
        let yaw = 0;
        if (w.steer && Math.abs(tan) > 1e-5) {
          // Ackermann: inner wheel steers more
          yaw = -Math.atan((wb * tan) / (wb - w.x * tan));
        }
        const spin = w.side > 0 ? -pose.wheelSpin : pose.wheelSpin;
        _q.setFromEuler(_e.set(spin, yaw + (w.side > 0 ? 0 : Math.PI), 0, 'YXZ'));
        _p.set(w.x, B.tyreR, w.z);
        _s.set(w.dual ? 1.95 : 1, 1, 1);
        s.wheels.setMatrixAt(k, _m.compose(_p, _q, _s));
      });
      s.wheels.instanceMatrix.needsUpdate = true;
    });
  }

  const mesh: BusMesh = {
    spec,
    sections,
    setPose(pose: BusPose) {
      pose.sections.forEach((p, i) => {
        const s = secs[i];
        if (!s) return;
        // Section root sits on the road at its rear axle, yawed then pitched to the grade.
        toWorld(p.x, p.y, p.z ?? pose.z ?? 0, s.root.position);
        s.root.rotation.set(p.pitch ?? 0, headingToRotY(p.heading), 0, 'YXZ');
        s.pivot.rotation.set(pose.pitch * (i === 0 ? 1 : 0.6), 0, -pose.roll);
      });
      setWheels(pose);
      // bellows between consecutive sections
      for (let i = 1; i < secs.length; i++) {
        const s = secs[i];
        const prev = secs[i - 1];
        const pp = pose.sections[i - 1];
        const pc = pose.sections[i];
        if (!s.bellows || !pp || !pc) continue;
        const zRear = prev.L.bodyRear - prev.L.axleFromFront;
        const fx = Math.sin(pp.heading), fy = Math.cos(pp.heading);
        const mx = pp.x - fx * zRear, my = pp.y - fy * zRear;
        const dx = mx - pc.x, dy = my - pc.y;
        const cf = Math.sin(pc.heading), cy = Math.cos(pc.heading);
        const fwd = dx * cf + dy * cy;
        const right = dx * cy - dy * cf;
        _a.set(right, 0, -fwd);
        let ang = pp.heading - pc.heading;
        ang = Math.atan2(Math.sin(ang), Math.cos(ang));
        _b.set(0, 0, s.L.bodyFront - s.L.axleFromFront);
        s.bellows.update(_a, ang, _b);
      }
    },
    setLights(l: BusLights, t: number) {
      const flash = (t * 1.5) % 1 < 0.5;
      for (const s of secs) {
        const set = (g: LampGroup, v: boolean) => {
          const m = s.lamps[g];
          if (m) m.visible = v;
        };
        set('night', l.headlights);
        set('brake', l.brake);
        set('reverse', l.reverse);
        set('indL', (l.indicatorLeft || l.hazards) && flash);
        set('indR', (l.indicatorRight || l.hazards) && flash);
        if (s.halo) s.halo.visible = l.headlights;
      }
      if (lastNight !== l.headlights) {
        lastNight = l.headlights;
        for (const s of secs) {
          s.shellMat.emissiveIntensity = l.headlights ? 0.6 : 0;
          s.shellMat.envMapIntensity = l.headlights ? 0.25 : 0.9;
          s.interior?.setNight(l.headlights);
        }
        trimMat.envMapIntensity = l.headlights ? 0.2 : 0.8;
        wheelMat.envMapIntensity = l.headlights ? 0.15 : 0.6;
        doorMat.envMapIntensity = l.headlights ? 0.12 : 0.45;
        bellowsMat.envMapIntensity = l.headlights ? 0.2 : 0.7;
        spot.intensity = l.headlights ? 140 : 0;
      }
    },
    setDoors(open: number) {
      if (Math.abs(open - doorT) < 1e-4) return;
      doorT = open;
      for (const s of secs) {
        if (!s.doors) continue;
        s.leaves.forEach((slot, k) => s.doors?.setMatrixAt(k, leafMatrix(slot, open, _m)));
        s.doors.instanceMatrix.needsUpdate = true;
      }
    },
    setDestination(sign: DestinationSign) {
      signMat = signMaterial(sign, lv.sign);
      for (const s of secs) if (s.sign) s.sign.material = signMat;
      playerSign.route = sign.route;
      playerSign.headsign = sign.headsign;
    },
    setInteriorView(v: boolean) {
      if (v === inside) {
        updateWells();
        return;
      }
      inside = v;
      const s0p = secs[0];
      s0p.shell.visible = !v;
      s0p.dark.visible = !v;
      for (let i = 1; i < secs.length; i++) {
        const it = secs[i].interior;
        if (it) it.group.visible = v;
      }
      updateWells();
    },
    dispose() {
      for (const s of secs) s.root.removeFromParent();
      for (const d of disposables) d.dispose();
      for (const s of secs) {
        s.wheels.dispose();
        s.doors?.dispose();
      }
      spot.dispose();
    },
  };
  mesh.setDoors(0);
  mesh.setLights({ headlights: false, brake: false, reverse: false, indicatorLeft: false, indicatorRight: false, hazards: false }, 0);
  updateWells();
  return mesh;
}

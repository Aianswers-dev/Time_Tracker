// Low-detail AI buses. All geometry and materials are cached per type and
// livery and shared by every instance; a bus is just a handful of Mesh
// objects per section (shell, dark parts incl. static wheels and mirrors,
// destination sign, night halos, brake lamps, indicators; plus bellows on
// Metro rear sections). Per-bus state changes only swap materials,
// geometries or visibility.
import * as THREE from 'three';
import type { BusLights, BusMesh, BusPose, BusSpec, BusType, DestinationSign, Route } from '../types';
import { headingToRotY, toWorld } from '../data/coords';
import { layoutFor, type SectionLayout } from './spec';
import { atlasLayout, buildShell } from './shell';
import { paintSection } from './paint';
import { liveryFor, makeLivery, type Livery, type LiveryId } from './livery';
import { lampGeometry } from './lamps';
import { buildDark, buildSignGeometry, lowBellowsGeometry } from './parts';
import { envMap } from './materials';
import { blankSignMaterial, signMaterial } from './sign';
import { canvasTexture } from './util';
import { haloGeometry, haloMaterial } from './halo';

interface LowSec {
  L: SectionLayout;
  shell: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  day: THREE.MeshStandardMaterial;
  night: THREE.MeshStandardMaterial;
  sign: THREE.BufferGeometry | null;
  halo: THREE.BufferGeometry | null;
  brake: THREE.BufferGeometry | null;
  indL: THREE.BufferGeometry | null;
  indR: THREE.BufferGeometry | null;
  indB: THREE.BufferGeometry | null;
}

interface LowAssets {
  lv: Livery;
  secs: LowSec[];
  bellows: THREE.BufferGeometry | null;
}

const cache = new Map<string, LowAssets>();
let darkMat: THREE.MeshLambertMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
let bellowsMat: THREE.MeshLambertMaterial | null = null;

function sharedMats(): { dark: THREE.MeshLambertMaterial; glow: THREE.MeshBasicMaterial; bellows: THREE.MeshLambertMaterial } {
  darkMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  glowMat ??= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  bellowsMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return { dark: darkMat, glow: glowMat, bellows: bellowsMat };
}

function assetsFor(type: BusType, id: LiveryId): LowAssets {
  const key = `${type}|${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const B = layoutFor(type);
  const lv = makeLivery(id, 'fleet');
  const env = envMap();
  let offset = 0;
  const secs = B.sections.map((L): LowSec => {
    const atlas = atlasLayout(B, L, 0.5);
    const paint = paintSection(B, L, atlas, lv, { cutDoors: false, scale: 0.5, offset });
    offset += L.span;
    const map = canvasTexture(paint.color);
    const emissiveMap = canvasTexture(paint.emissive);
    const roughnessMap = canvasTexture(paint.rough, false);
    const base = { map, roughnessMap, roughness: 1, metalness: 0, alphaTest: 0.5, envMap: env, emissive: new THREE.Color(0xfff0d8), emissiveMap };
    const day = new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 0.8, emissiveIntensity: 0 });
    const night = new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 0.2, emissiveIntensity: 0.85 });
    return {
      L,
      shell: buildShell(B, L, atlas, { detail: 'low' }),
      dark: buildDark(B, L, { doorWells: true, staticWheels: true, lowTrim: lv }),
      day,
      night,
      sign: buildSignGeometry(B, L, ['front', 'side', 'rear']),
      halo: haloGeometry(B, L),
      brake: lampGeometry(B, L, ['brake'], 0.008, 1.15),
      indL: lampGeometry(B, L, ['indL'], 0.008, 1.3),
      indR: lampGeometry(B, L, ['indR'], 0.008, 1.3),
      indB: lampGeometry(B, L, ['indL', 'indR'], 0.008, 1.3),
    };
  });
  const a: LowAssets = { lv, secs, bellows: B.sections.length > 1 ? lowBellowsGeometry(B) : null };
  cache.set(key, a);
  return a;
}

export function createLowBus(spec: BusSpec, route: Route | undefined): BusMesh {
  const A = assetsFor(spec.type, liveryFor(spec.type, route));
  const M = sharedMats();
  const halo = haloMaterial();
  type Parts = {
    root: THREE.Group;
    shell: THREE.Mesh;
    sign: THREE.Mesh | null;
    halo: THREE.Mesh | null;
    brake: THREE.Mesh | null;
    ind: THREE.Mesh | null;
    bellows: THREE.Mesh | null;
    a: LowSec;
  };
  const parts: Parts[] = A.secs.map((a, i) => {
    const root = new THREE.Group();
    root.name = `aibus-${spec.type}-section${i}`;
    const shell = new THREE.Mesh(a.shell, a.day);
    root.add(shell);
    root.add(new THREE.Mesh(a.dark, M.dark));
    const mk = (g: THREE.BufferGeometry | null, m: THREE.Material, visible: boolean) => {
      if (!g) return null;
      const mesh = new THREE.Mesh(g, m);
      mesh.visible = visible;
      root.add(mesh);
      return mesh;
    };
    const sign = mk(a.sign, blankSignMaterial(A.lv.sign), true);
    const h = mk(a.halo, halo, false);
    if (h) h.renderOrder = 5;
    const brake = mk(a.brake, M.glow, false);
    const ind = mk(a.indB, M.glow, false);
    let bellows: THREE.Mesh | null = null;
    if (i > 0 && A.bellows) {
      bellows = new THREE.Mesh(A.bellows, M.bellows);
      bellows.position.set(0, 0, a.L.bodyFront - a.L.axleFromFront - 0.3);
      bellows.scale.set(1, 1, 0.6);
      root.add(bellows);
    }
    return { root, shell, sign, halo: h, brake, ind, bellows, a };
  });
  let night: boolean | null = null;

  const mesh: BusMesh = {
    spec,
    sections: parts.map((p) => p.root),
    setPose(pose: BusPose) {
      pose.sections.forEach((p, i) => {
        const s = parts[i];
        if (!s) return;
        toWorld(p.x, p.y, 0, s.root.position);
        s.root.rotation.y = headingToRotY(p.heading);
      });
      for (let i = 1; i < parts.length; i++) {
        const s = parts[i];
        const pp = pose.sections[i - 1];
        const pc = pose.sections[i];
        if (!s.bellows || !pp || !pc) continue;
        const prevL = parts[i - 1].a.L;
        const zRear = prevL.bodyRear - prevL.axleFromFront;
        const fx = Math.sin(pp.heading), fy = Math.cos(pp.heading);
        const dx = pp.x - fx * zRear - pc.x, dy = pp.y - fy * zRear - pc.y;
        const cf = Math.sin(pc.heading), cy = Math.cos(pc.heading);
        const ax = dx * cy - dy * cf;
        const az = -(dx * cf + dy * cy);
        const bz = s.a.L.bodyFront - s.a.L.axleFromFront;
        let ang = pp.heading - pc.heading;
        ang = Math.atan2(Math.sin(ang), Math.cos(ang));
        s.bellows.position.set(ax / 2, 0, (az + bz) / 2);
        s.bellows.rotation.y = -ang / 2;
        s.bellows.scale.z = Math.max(0.05, Math.hypot(ax, az - bz));
      }
    },
    setLights(l: BusLights, t: number) {
      if (night !== l.headlights) {
        night = l.headlights;
        for (const p of parts) {
          p.shell.material = night ? p.a.night : p.a.day;
          if (p.halo) p.halo.visible = night;
        }
      }
      const flash = (t * 1.5) % 1 < 0.5;
      const left = l.indicatorLeft || l.hazards;
      const right = l.indicatorRight || l.hazards;
      for (const p of parts) {
        if (p.brake) p.brake.visible = l.brake;
        if (p.ind) {
          const g = left && right ? p.a.indB : left ? p.a.indL : p.a.indR;
          if (g) p.ind.geometry = g;
          p.ind.visible = flash && (left || right);
        }
      }
    },
    setDoors() {},
    setDestination(sign: DestinationSign) {
      const m = signMaterial(sign, A.lv.sign);
      for (const p of parts) if (p.sign) p.sign.material = m;
    },
    setInteriorView() {},
    dispose() {
      for (const p of parts) p.root.removeFromParent();
    },
  };
  if (route) mesh.setDestination({ route: route.id, headsign: route.headsign });
  return mesh;
}

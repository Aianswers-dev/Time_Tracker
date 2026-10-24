/**
 * The 3D world: ground, river, roads, buildings, vegetation, street furniture,
 * landmarks, sky and time of day. See the individual modules for details.
 */
import * as THREE from 'three';
import { AreaKind, BuildingKind, type MapData, type WorldHandle } from '../types';
import { buildBuildings } from './buildings';
import { buildFurniture } from './furniture';
import { buildHouses } from './houses';
import { buildTrees } from './trees';
import type { Ctx, Extras } from './ctx';
import { INNER_PAD, buildPools } from './ground';
import { buildStoryBridge } from './landmarks';
import { buildRoads } from './roads';
import { TerrainField, buildTerrain, makeLandcover, makeTerrainMaterial } from './terrain';
import { U } from './shaders';
import { SkySystem } from './sky';
import { makeAsphaltTexture, makeGlowTexture, makeNoiseTexture, makeTrackTexture, makeWaterNormal } from './textures';
import { MASK_BUILDING, MASK_GREEN, MASK_PLAZA, MASK_POOL, MASK_RAIL, MASK_SPORT, MASK_WATER, Mask, centroid, signedArea, yieldFrame } from './util';
import { buildWater } from './water';
import extrasUrl from './gen/extras.json?url';
import outerUrl from './gen/outer.png';

async function loadExtras(): Promise<{ extras: Extras | null; outer: THREE.Texture | null }> {
  try {
    const [res, tex] = await Promise.all([fetch(extrasUrl), new THREE.TextureLoader().loadAsync(outerUrl)]);
    const extras = res.ok ? ((await res.json()) as Extras) : null;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    return { extras, outer: tex };
  } catch (e) {
    console.warn('[world] extras unavailable', e);
    return { extras: null, outer: null };
  }
}

function buildMask(data: MapData, R: [number, number, number, number]): Mask {
  const m = new Mask(R[0], R[1], R[2], R[3], 3);
  for (const w of data.water) m.fillRings([w.pts, ...w.holes], MASK_WATER);
  for (const a of data.areas) {
    const flag =
      a.kind === AreaKind.Water ? MASK_POOL : a.kind === AreaKind.Sport ? MASK_SPORT : a.kind === AreaKind.Plaza ? MASK_PLAZA : MASK_GREEN;
    m.fillRings([a.pts, ...a.holes], flag);
  }
  for (const b of data.buildings) m.fillRings([b.pts], MASK_BUILDING);
  for (const r of data.rail) if (!r.tunnel) m.fillLine(r.pts, 3, MASK_RAIL);
  return m;
}

function buildDensity(data: MapData, R: [number, number, number, number]): Ctx['density'] {
  const cell = 16;
  const nx = Math.ceil((R[2] - R[0]) / cell);
  const ny = Math.ceil((R[3] - R[1]) / cell);
  let d = new Float32Array(nx * ny);
  for (const b of data.buildings) {
    const area = Math.abs(signedArea(b.pts));
    const house = b.kind === BuildingKind.House || b.kind === BuildingKind.Shed || (b.kind === BuildingKind.Generic && area < 320 && b.height <= 8);
    if (house) continue;
    const [cx, cy] = centroid(b.pts);
    const i = Math.floor((cx - R[0]) / cell);
    const j = Math.floor((cy - R[1]) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    d[j * nx + i] += area / (cell * cell);
  }
  // blur (three box passes ~ gaussian)
  for (let pass = 0; pass < 3; pass++) {
    const o = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            s += d[jj * nx + ii];
            c++;
          }
        }
        o[j * nx + i] = s / c;
      }
    }
    d = o;
  }
  const bytes = new Uint8Array(nx * ny * 4);
  for (let k = 0; k < nx * ny; k++) {
    d[k] = Math.min(1, d[k]);
    bytes[4 * k] = d[k] * 255;
    bytes[4 * k + 3] = 255;
  }
  const tex = new THREE.DataTexture(bytes, nx, ny, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, data: d, x0: R[0], y0: R[1], cell, nx, ny };
}

export async function buildWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  data: MapData,
  onProgress: (fraction: number, label: string) => void,
): Promise<WorldHandle> {
  const t0 = performance.now();
  const step = async (f: number, label: string) => {
    onProgress(f, label);
    await yieldFrame();
  };
  await step(0, 'Building city…');
  const extrasP = loadExtras();
  const [bx0, by0, bx1, by1] = data.bounds;
  const R: [number, number, number, number] = [bx0 - INNER_PAD - 0.05, by0 - INNER_PAD - 0.05, bx1 + INNER_PAD + 0.05, by1 + INNER_PAD + 0.05];
  const tex = {
    noise: makeNoiseTexture(),
    asphalt: makeAsphaltTexture(),
    waterNormal: makeWaterNormal(),
    track: makeTrackTexture(),
    glow: makeGlowTexture(),
  };
  await step(0.04, 'Surveying the river…');
  const mask = buildMask(data, R);
  const density = buildDensity(data, R);
  const { extras: ex, outer } = await extrasP;
  let extras = ex;
  if (extras && extras.inner.some((v, i) => Math.abs(v - R[i]) > 1.5)) {
    console.warn('[world] extras.json was built for different bounds; ignoring it (run src/world/gen/build_extras.py)');
    extras = null;
  }
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);
  const field = new TerrainField(data);
  const ctx: Ctx = { scene, renderer, data, extras, outerTex: outer, R, mask, field, tex, density, root, cull: [], tick: [] };

  const sky = new SkySystem(scene, renderer);
  await step(0.08, 'Shaping the hills…');
  const land = makeLandcover(data, R);
  const terrainMat = makeTerrainMaterial(ctx, land, false);
  const outerMat = makeTerrainMaterial(ctx, land, true);
  const stripMat = makeTerrainMaterial(ctx, land, false, 0.0006);

  await step(0.12, 'Paving roads…');
  const roads = await buildRoads(ctx, field, stripMat, (f) => onProgress(0.12 + f * 0.24, 'Paving roads…'));
  field.settle();
  await step(0.36, 'Shaping the hills…');
  await buildTerrain(ctx, field, terrainMat, outerMat);
  buildWater(ctx);
  buildPools(ctx, field);
  buildStoryBridge(ctx);

  await step(0.4, 'Raising buildings…');
  const bidx = await buildBuildings(ctx, roads, (f) => onProgress(0.4 + f * 0.3, 'Raising buildings…'));
  await step(0.7, 'Building Queenslanders…');
  const houses = await buildHouses(ctx, roads, bidx, (f) => onProgress(0.7 + f * 0.1, 'Building Queenslanders…'));
  await step(0.8, 'Planting jacarandas…');
  const nTrees = await buildTrees(ctx, roads, houses.yards, (f) => onProgress(0.8 + f * 0.1, 'Planting jacarandas…'));
  console.info(`[world] ${houses.count} generated houses, ${nTrees} trees`);
  await step(0.9, 'Installing traffic lights…');
  const signals = await buildFurniture(ctx, roads, (f) => onProgress(0.9 + f * 0.08, 'Installing traffic lights…'));

  await step(1, 'City ready');
  console.info(`[world] built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const camPos = new THREE.Vector3();
  let infoTimer = 0;
  // Signal clock: our own, re-synchronised to the caller's clock whenever signalStateAt is used.
  let sigClock = 0;
  let sigOffset = 0;
  const debug = location.search.includes('world=debug');
  const dbgWin = window as unknown as { __worldCam?: number[]; __worldHours?: number; __worldInfo?: () => string; __worldRoot?: THREE.Group };
  if (debug) dbgWin.__worldRoot = root;
  if (debug) dbgWin.__worldInfo = () => `calls ${renderer.info.render.calls} tris ${renderer.info.render.triangles} geos ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`;
  return {
    update(dt: number, camera: THREE.Camera, hours: number) {
      if (debug && dbgWin.__worldCam) {
        // debug camera: [x, y, h, lookX, lookY, lookH] in map coordinates
        const c = dbgWin.__worldCam;
        camera.position.set(c[0], c[2], -c[1]);
        camera.lookAt(c[3], c[5], -c[4]);
        camera.updateMatrixWorld();
      }
      if (debug && dbgWin.__worldHours !== undefined) hours = dbgWin.__worldHours;
      U.uTime.value += dt;
      sigClock += dt;
      U.uSignalTime.value = sigClock + sigOffset;
      camera.getWorldPosition(camPos);
      // underground: the camera is below the ground surface here (open cuttings don't count)
      const mx = camPos.x;
      const my = -camPos.z;
      const groundH = field.renAt(mx, my);
      const depth = field.isHole(mx, my) ? 0 : groundH - camPos.y;
      const under = Math.min(1, Math.max(0, (depth - 1.5) / 3));
      U.uUnder.value = under;
      U.uInTunnel.value = under > 0.5 ? 1 : 0;
      sky.update(camera, hours, Math.min(groundH, camPos.y));
      if (under > 0) {
        sky.sun.intensity *= 1 - 0.85 * under;
        sky.hemi.intensity *= 1 - 0.55 * under;
      }
      for (const c of ctx.cull) {
        const dx = c.x - camPos.x;
        const dz = c.z - camPos.z;
        c.obj.visible = dx * dx + dz * dz < c.range * c.range;
      }
      for (const t of ctx.tick) t(dt, camera);
      infoTimer += dt;
      if (infoTimer > 5 && location.search.includes('world=debug')) {
        infoTimer = 0;
        console.info(`[world] calls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}`);
      }
    },
    signalStateAt(x: number, y: number, timeSeconds: number, dirX?: number, dirY?: number) {
      sigOffset = timeSeconds - sigClock;
      return signals.stateAt(x, y, timeSeconds, dirX, dirY);
    },
  };
}

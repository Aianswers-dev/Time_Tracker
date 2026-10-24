/** Build context shared by the world modules. */
import * as THREE from 'three';
import type { MapData } from '../types';
import type { TerrainField } from './terrain';
import type { Mask } from './util';

export interface RawPoly {
  p: number[];
  h?: number[][];
}

/** src/world/gen/extras.json (see build_extras.py). */
export interface Extras {
  bounds: [number, number, number, number];
  inner: [number, number, number, number];
  big: [number, number, number, number];
  raster: { x0: number; y1: number; cell: number; w: number; h: number };
  land: RawPoly[];
  water: RawPoly[];
  roads: { k: number; w: number; p: number[] }[];
  bridges: { p: number[]; n?: string; s?: string; l?: number }[];
  peaks: { x: number; y: number; e: number; n: string }[];
  towers: { x: number; y: number; h: number; n: string }[];
}

export interface Textures {
  noise: THREE.DataTexture;
  asphalt: THREE.DataTexture;
  waterNormal: THREE.DataTexture;
  track: THREE.DataTexture;
  glow: THREE.DataTexture;
}

/** Something whose visibility is decided by distance to the camera each frame. */
export interface Cullable {
  obj: THREE.Object3D;
  x: number;
  z: number;
  /** Visible while the camera is closer than this (metres, horizontal). */
  range: number;
}

export interface Ctx {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  data: MapData;
  extras: Extras | null;
  outerTex: THREE.Texture | null;
  /** Inner ground rectangle (map bounds + pad), map coords. */
  R: [number, number, number, number];
  mask: Mask;
  /** Natural and rendered terrain heights. */
  field: TerrainField;
  tex: Textures;
  /** Non-residential building cover, 0..1, for paving vs lawn and footpath style. */
  density: { tex: THREE.DataTexture; data: Float32Array; x0: number; y0: number; cell: number; nx: number; ny: number };
  root: THREE.Group;
  cull: Cullable[];
  /** Frame callbacks (time in seconds). */
  tick: ((dt: number, camera: THREE.Camera) => void)[];
}

export function densityAt(ctx: Ctx, x: number, y: number): number {
  const d = ctx.density;
  const i = Math.floor((x - d.x0) / d.cell);
  const j = Math.floor((y - d.y0) / d.cell);
  if (i < 0 || j < 0 || i >= d.nx || j >= d.ny) return 0;
  return d.data[j * d.nx + i];
}

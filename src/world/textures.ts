/** Procedural textures generated at startup (no runtime downloads). */
import * as THREE from 'three';
import { hash1 } from './util';

function lattice(i: number, j: number, period: number, salt: number): number {
  const ii = ((i % period) + period) % period;
  const jj = ((j % period) + period) % period;
  return hash1(ii * 7919 + jj * 104729 + salt * 1299709);
}

/** Tileable value noise in [0,1] at (u, v) in [0,1), with `period` cells. */
function vnoise(u: number, v: number, period: number, salt: number): number {
  const x = u * period;
  const y = v * period;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(i, j, period, salt);
  const b = lattice(i + 1, j, period, salt);
  const c = lattice(i, j + 1, period, salt);
  const d = lattice(i + 1, j + 1, period, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, base: number, oct: number, salt: number): number {
  let s = 0;
  let a = 0.5;
  let p = base;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(u, v, p, salt + o * 31);
    norm += a;
    a *= 0.5;
    p *= 2;
  }
  return s / norm;
}

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, anisotropy = 8): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** RGBA noise: R fine grain, G medium blotches, B large patches, A cellular-ish speckle. */
export function makeNoiseTexture(size = 512): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const k = (y * size + x) * 4;
      d[k] = fbm(u, v, 64, 3, 1) * 255;
      d[k + 1] = fbm(u, v, 16, 4, 2) * 255;
      d[k + 2] = fbm(u, v, 4, 4, 3) * 255;
      const sp = hash1(x * 131 + y * 977 + 5);
      d[k + 3] = (sp > 0.93 ? 255 : sp > 0.75 ? 150 : 90) * (0.6 + 0.4 * vnoise(u, v, 128, 9));
    }
  }
  return dataTex(d, size, size, false);
}

/** Asphalt albedo: aggregate speckle, tar patches, faint cracks. Covers ~8 m per tile. */
export function makeAsphaltTexture(size = 512): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const k = (y * size + x) * 4;
      const grain = hash1(x * 7 + y * 7919 + 11);
      const g2 = hash1(x * 13 + y * 3011 + 17);
      const blot = fbm(u, v, 8, 4, 21);
      const crackN = Math.abs(fbm(u, v, 6, 3, 41) - 0.5);
      const crack = crackN < 0.012 ? 0.75 : 1;
      let l = 0.30 + (grain - 0.5) * 0.1 + (blot - 0.5) * 0.12;
      if (g2 > 0.985) l += 0.18; // light stones
      if (g2 < 0.02) l -= 0.08;
      l *= crack;
      const c = Math.max(0, Math.min(1, l)) * 255;
      d[k] = c;
      d[k + 1] = c;
      d[k + 2] = c * 1.02;
      d[k + 3] = 255;
    }
  }
  return dataTex(d, size, size, false, 16);
}

/** Tangent-space normal map for water ripples. */
export function makeWaterNormal(size = 256): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      h[y * size + x] = fbm(u, v, 8, 5, 61) * 0.7 + vnoise(u, v, 32, 63) * 0.3;
    }
  }
  const d = new Uint8Array(size * size * 4);
  const s = 6.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const hy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      let nx = -hx * s;
      let ny = -hy * s;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const k = (y * size + x) * 4;
      d[k] = (nx * 0.5 + 0.5) * 255;
      d[k + 1] = (ny * 0.5 + 0.5) * 255;
      d[k + 2] = (nz * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  }
  return dataTex(d, size, size, false);
}

/**
 * Railway track, u across 0..1 (= 4 m), v along (1 tile = 3.9 m, six sleepers).
 * Ballast, concrete sleepers, two steel rails.
 */
export function makeTrackTexture(): THREE.DataTexture {
  const w = 128;
  const h = 256;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const across = (x / w) * 4 - 2; // metres from centre
      const along = (y / h) * 3.9;
      const g = hash1(x * 31 + y * 7717 + 3);
      // ballast
      let r = 120 + g * 50;
      let gg = 110 + g * 45;
      let b = 98 + g * 40;
      const edge = Math.abs(across) > 1.75 ? 0.75 : 1;
      r *= edge;
      gg *= edge;
      b *= edge;
      const sl = along % 0.65;
      if (sl < 0.26 && Math.abs(across) < 1.25) {
        const c = 150 + g * 25;
        r = c;
        gg = c * 0.98;
        b = c * 0.94;
      }
      const railA = Math.abs(Math.abs(across) - 0.7175);
      if (railA < 0.05) {
        r = 85;
        gg = 82;
        b = 80;
        if (railA < 0.022) {
          r = 175;
          gg = 175;
          b = 178;
        }
      }
      d[k] = r;
      d[k + 1] = gg;
      d[k + 2] = b;
      d[k + 3] = 255;
    }
  }
  return dataTex(d, w, h, false, 8);
}

/** White text on transparent, for painted road words. Returns texture and UV rows. */
export function makeRoadTextTexture(words: string[]): { tex: THREE.CanvasTexture; rows: number } {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128 * words.length;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  words.forEach((wd, i) => {
    g.font = 'bold 104px Arial, Helvetica, sans-serif';
    const m = g.measureText(wd);
    const sx = Math.min(1, 480 / m.width);
    g.save();
    g.translate(256, i * 128 + 66);
    g.scale(sx, 1);
    g.fillText(wd, 0, 0);
    g.restore();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, rows: words.length };
}

/**
 * White sign lettering on transparent, one line per 64 px row of a 1024 px
 * atlas. `widths[i]` is line i's drawn width as a fraction of the row width.
 */
export function makeSignTextTexture(lines: string[]): { tex: THREE.CanvasTexture; rows: number; widths: number[] } {
  const rows = Math.max(1, lines.length);
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64 * rows;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 44px Arial, Helvetica, sans-serif';
  const widths = lines.map((ln, i) => {
    const w = Math.max(1, g.measureText(ln).width);
    const sx = Math.min(1, 1000 / w);
    g.save();
    g.translate(512, i * 64 + 34);
    g.scale(sx, 1);
    g.fillText(ln, 0, 0);
    g.restore();
    return Math.min(1000, w * sx + 24) / 1024;
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, rows, widths };
}

/** Radial soft spot for light pools and glows. */
export function makeGlowTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const v = Math.pow(1 - r, 2.2);
      const k = (y * size + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = v * 255;
    }
  }
  const t = dataTex(d, size, size, false, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

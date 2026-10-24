// Merged, vertex-coloured geometry for station models (src/game/stations.ts):
// one opaque mesh per station (with signs from a texture atlas and procedural
// paving/tactile/louvre patterns) and one glass mesh. Builders work in map
// coordinates (x east, y north, h up) like world/geo.ts.
import * as THREE from 'three';

/** Surface patterns drawn in the fragment shader (no textures). */
export const enum Pat {
  None = 0,
  /** Square paving tiles; size = tile edge (m); local u/v coordinates. */
  Tiles = 1,
  /** Tactile ground surface indicator studs. */
  Tactile = 2,
  /** Horizontal louvres/slats on a vertical face (size = pitch); uses world height. */
  Louvre = 3,
  /** Coffered timber soffit (size = coffer pitch), local u/v; lit by bounce light. */
  Coffer = 4,
  /** Canopy soffit panels (size = panel), local u/v; lit by bounce light. */
  Soffit = 5,
}

class Grow {
  arr: Float32Array;
  len = 0;
  constructor(n: number) {
    this.arr = new Float32Array(n);
  }
  push(...v: number[]): void {
    if (this.len + v.length > this.arr.length) {
      const a = new Float32Array(Math.max(this.arr.length * 2, this.len + v.length));
      a.set(this.arr.subarray(0, this.len));
      this.arr = a;
    }
    for (const x of v) this.arr[this.len++] = x;
  }
  take(): Float32Array {
    return this.arr.slice(0, this.len);
  }
}

class GrowU8 {
  arr: Uint8Array;
  len = 0;
  constructor(n: number) {
    this.arr = new Uint8Array(n);
  }
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.arr.length) {
      const n = new Uint8Array(this.arr.length * 2);
      n.set(this.arr.subarray(0, this.len));
      this.arr = n;
    }
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
}

class GrowU32 {
  arr: Uint32Array;
  len = 0;
  constructor(n: number) {
    this.arr = new Uint32Array(n);
  }
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.arr.length) {
      const n = new Uint32Array(this.arr.length * 2);
      n.set(this.arr.subarray(0, this.len));
      this.arr = n;
    }
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
}

export type V3 = [number, number, number];

const PLAIN_U = -1;
const LAMP_U = -2;

/**
 * Geometry under construction. Every vertex carries a colour, an atlas UV
 * (plain surfaces point at the atlas's white texel) and a pattern.
 */
export class SGeo {
  private pos = new Grow(1 << 12);
  private nrm = new Grow(1 << 12);
  private col = new GrowU8(1 << 12);
  private uv = new Grow(1 << 11);
  private pat = new Grow(1 << 13);
  private idx = new GrowU32(1 << 12);
  /** Current colour (0xRRGGBB), UV and pattern for new vertices. */
  c = 0xffffff;
  u = PLAIN_U;
  v = 0;
  pk = 0;
  ps = 1;
  /** Local pattern frame: origin and unit axis (map) for Tiles/Coffer u/v. */
  private ox = 0;
  private oy = 0;
  private tx = 1;
  private ty = 0;
  /** Signs waiting for the atlas layout (see deferSign/finish). */
  private signs: { key: string; a: [number, number, number, number, number, number, number, number, boolean] }[] = [];

  get count(): number {
    return this.pos.len / 3;
  }
  get empty(): boolean {
    return this.idx.len === 0 && this.signs.length === 0;
  }
  /** Plain colour for the next primitives. */
  paint(c: number, pat = Pat.None, size = 1): this {
    this.c = c;
    // sentinel UVs, remapped to the atlas texels in finish()
    this.u = PLAIN_U;
    this.v = 0;
    this.pk = pat;
    this.ps = size;
    return this;
  }
  /** Emissive lamp surface. */
  lamp(): this {
    this.c = 0xffffff;
    this.u = LAMP_U;
    this.v = 0;
    this.pk = Pat.None;
    return this;
  }
  frame(ox: number, oy: number, tx: number, ty: number): void {
    this.ox = ox;
    this.oy = oy;
    this.tx = tx;
    this.ty = ty;
  }
  vert(x: number, h: number, y: number, u = this.u, v = this.v): number {
    const i = this.count;
    this.pos.push(x, h, -y);
    this.nrm.push(0, 1, 0);
    this.col.push3((this.c >> 16) & 255, (this.c >> 8) & 255, this.c & 255);
    this.uv.push(u, v);
    const dx = x - this.ox;
    const dy = y - this.oy;
    this.pat.push(this.pk, this.ps, dx * this.tx + dy * this.ty, -dx * this.ty + dy * this.tx);
    return i;
  }
  /** Triangle facing (fx, fy, fz) in three.js space; flat normal. */
  tri(a: number, b: number, c: number, fx: number, fy: number, fz: number): void {
    const p = this.pos.arr;
    const ax = p[3 * b] - p[3 * a];
    const ay = p[3 * b + 1] - p[3 * a + 1];
    const az = p[3 * b + 2] - p[3 * a + 2];
    const bx = p[3 * c] - p[3 * a];
    const by = p[3 * c + 1] - p[3 * a + 1];
    const bz = p[3 * c + 2] - p[3 * a + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    if (nx * fx + ny * fy + nz * fz >= 0) this.idx.push3(a, b, c);
    else {
      this.idx.push3(a, c, b);
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) {
      const n = this.nrm.arr;
      for (const v of [a, b, c]) {
        n[3 * v] = nx / l;
        n[3 * v + 1] = ny / l;
        n[3 * v + 2] = nz / l;
      }
    }
  }
  quad(a: number, b: number, c: number, d: number, fx: number, fy: number, fz: number): void {
    this.tri(a, b, c, fx, fy, fz);
    this.tri(a, c, d, fx, fy, fz);
  }
  /**
   * Quad from four map points (x, y, h), in order around its edge, facing the
   * map direction (fx, fy) and up fh. Own vertices (flat shading).
   */
  face(p: V3[], fx: number, fy: number, fh: number): void {
    const v = p.map((q) => this.vert(q[0], q[2], q[1]));
    if (v.length === 3) this.tri(v[0], v[1], v[2], fx, fh, -fy);
    else this.quad(v[0], v[1], v[2], v[3], fx, fh, -fy);
  }
  /** Both sides of a thin panel. */
  panel(p: V3[], fx: number, fy: number, fh: number): void {
    this.face(p, fx, fy, fh);
    this.face(p, -fx, -fy, -fh);
  }
  /**
   * Box centred at (x, y) from h0 to h1, half length hl along unit (ux, uy),
   * half width hw across.
   */
  box(x: number, y: number, h0: number, h1: number, ux: number, uy: number, hl: number, hw: number, bottom = false): void {
    const vx = -uy;
    const vy = ux;
    const cs: [number, number][] = [
      [-hl, -hw],
      [hl, -hw],
      [hl, hw],
      [-hl, hw],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const [p, q] = cs[i];
      const [p2, q2] = cs[j];
      const ax = x + ux * p + vx * q;
      const ay = y + uy * p + vy * q;
      const bx = x + ux * p2 + vx * q2;
      const by = y + uy * p2 + vy * q2;
      const mx = ux * (p + p2) * 0.5 + vx * (q + q2) * 0.5;
      const my = uy * (p + p2) * 0.5 + vy * (q + q2) * 0.5;
      this.face(
        [
          [ax, ay, h0],
          [bx, by, h0],
          [bx, by, h1],
          [ax, ay, h1],
        ],
        mx,
        my,
        0,
      );
    }
    const top: V3[] = cs.map(([p, q]) => [x + ux * p + vx * q, y + uy * p + vy * q, h1]);
    this.face(top, 0, 0, 1);
    if (bottom) {
      const bot: V3[] = cs.map(([p, q]) => [x + ux * p + vx * q, y + uy * p + vy * q, h0]);
      this.face(bot, 0, 0, -1);
    }
  }
  /** Square-section beam between two map points (x, y, h). */
  beam(a: V3, b: V3, r: number, caps = true): void {
    const A = new THREE.Vector3(a[0], a[2], -a[1]);
    const B = new THREE.Vector3(b[0], b[2], -b[1]);
    const d = B.clone().sub(A);
    const len = d.length();
    if (len < 1e-4) return;
    d.divideScalar(len);
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const s1 = new THREE.Vector3().crossVectors(d, up).normalize().multiplyScalar(r);
    const s2 = new THREE.Vector3().crossVectors(d, s1).normalize().multiplyScalar(r);
    const cs = [s1.clone().add(s2), s1.clone().sub(s2), s1.clone().negate().sub(s2), s1.clone().negate().add(s2)];
    const at = (P: THREE.Vector3, c: THREE.Vector3) => this.vert(P.x + c.x, P.y + c.y, -(P.z + c.z));
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const m = cs[i].clone().add(cs[j]);
      this.quad(at(A, cs[i]), at(A, cs[j]), at(B, cs[j]), at(B, cs[i]), m.x, m.y, m.z);
    }
    if (caps) {
      this.quad(at(A, cs[0]), at(A, cs[1]), at(A, cs[2]), at(A, cs[3]), -d.x, -d.y, -d.z);
      this.quad(at(B, cs[0]), at(B, cs[1]), at(B, cs[2]), at(B, cs[3]), d.x, d.y, d.z);
    }
  }
  /** Vertical cylinder (n sides) from h0 to h1. */
  cylinder(x: number, y: number, h0: number, h1: number, r: number, n = 8, top = true): void {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      lo.push(this.vert(x + Math.cos(t) * r, h0, y + Math.sin(t) * r));
      hi.push(this.vert(x + Math.cos(t) * r, h1, y + Math.sin(t) * r));
    }
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n) * Math.PI * 2;
      this.quad(lo[i], lo[i + 1], hi[i + 1], hi[i], Math.cos(t), 0, -Math.sin(t));
    }
    // smooth sides
    const nr = this.nrm.arr;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      for (const v of [lo[i], hi[i]]) {
        nr[3 * v] = Math.cos(t);
        nr[3 * v + 1] = 0;
        nr[3 * v + 2] = -Math.sin(t);
      }
    }
    if (top) {
      const c = this.vert(x, h1, y);
      const ring: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        ring.push(this.vert(x + Math.cos(t) * r, h1, y + Math.sin(t) * r));
      }
      for (let i = 0; i < n; i++) this.tri(c, ring[i], ring[i + 1], 0, 1, 0);
    }
  }
  /**
   * A textured sign quad from the atlas: centre (x, y, h), facing unit (fx, fy),
   * width w, height hh, both faces (the back mirrored) when `both`.
   */
  sign(x: number, y: number, h: number, fx: number, fy: number, w: number, hh: number, rect: [number, number, number, number], both = true): void {
    // the viewer's right, looking at the face (along -f)
    const rx = -fy;
    const ry = fx;
    const save = [this.c, this.pk] as const;
    this.c = 0xffffff;
    this.pk = Pat.None;
    const [u0, v0, du, dv] = rect;
    const mk = (sx: number, flip: boolean) => {
      const ex = rx * sx;
      const ey = ry * sx;
      const a = this.vert(x - ex * w * 0.5, h - hh * 0.5, y - ey * w * 0.5, flip ? u0 + du : u0, v0);
      const b = this.vert(x + ex * w * 0.5, h - hh * 0.5, y + ey * w * 0.5, flip ? u0 : u0 + du, v0);
      const c = this.vert(x + ex * w * 0.5, h + hh * 0.5, y + ey * w * 0.5, flip ? u0 : u0 + du, v0 + dv);
      const d = this.vert(x - ex * w * 0.5, h + hh * 0.5, y - ey * w * 0.5, flip ? u0 + du : u0, v0 + dv);
      return [a, b, c, d];
    };
    const f = mk(1, false);
    this.quad(f[0], f[1], f[2], f[3], fx, 0, -fy);
    if (both) {
      const off = 0.012;
      const g = mk(1, true).map((i) => i);
      // nudge the back face behind the front
      const p = this.pos.arr;
      for (const i of g) {
        p[3 * i] -= fx * off;
        p[3 * i + 2] += fy * off;
      }
      this.quad(g[1], g[0], g[3], g[2], -fx, 0, fy);
    }
    [this.c, this.pk] = save;
  }
  /**
   * A sign whose atlas cell is laid out later: centre (x, y, h), facing unit
   * (fx, fy), size w x hh. With `offset` > 0 the faces sit offset either side
   * of the centre (a sign box of that half-thickness), the back facing away
   * and readable; with 0 the back is the mirrored front. One face only
   * unless `both`.
   */
  deferSign(atlas: Atlas, key: string, x: number, y: number, h: number, fx: number, fy: number, w: number, hh: number, offset: number, both = true): void {
    void atlas;
    this.signs.push({ key, a: [x, y, h, fx, fy, w, hh, offset, both] });
  }
  /** Lay out deferred signs and resolve plain/lamp UVs against the (built) atlas. */
  finish(atlas: Atlas): THREE.BufferGeometry {
    for (const s of this.signs) {
      const [x, y, h, fx, fy, w, hh, off, both] = s.a;
      const r = atlas.rect(s.key);
      if (off > 0) {
        this.sign(x + fx * off, y + fy * off, h, fx, fy, w, hh, r, false);
        if (both) this.sign(x - fx * off, y - fy * off, h, -fx, -fy, w, hh, r, false);
      } else this.sign(x, y, h, fx, fy, w, hh, r, both);
    }
    this.signs.length = 0;
    const uv = this.uv.arr;
    for (let i = 0; i < this.uv.len; i += 2) {
      if (uv[i] === PLAIN_U) {
        uv[i] = atlas.white[0];
        uv[i + 1] = atlas.white[1];
      } else if (uv[i] === LAMP_U) {
        uv[i] = atlas.lamp[0];
        uv[i + 1] = atlas.lamp[1];
      }
    }
    return this.build();
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.take(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.take(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.arr.slice(0, this.col.len), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.take(), 2));
    g.setAttribute('aPat', new THREE.BufferAttribute(this.pat.take(), 4));
    g.setIndex(new THREE.BufferAttribute(this.idx.arr.slice(0, this.idx.len), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Sign atlas: TransLink orange signs, totems, PIDs. Diffuse and emissive
// canvases share one layout; plain geometry samples the white texel, lamps
// the lamp texel (white in both).

export type SignKind = 'stop' | 'platform' | 'depart' | 'totem' | 'pid' | 'banner' | 'lettering' | 'clearance';

export interface SignReq {
  kind: SignKind;
  text: string;
  sub?: string;
}

export const ORANGE = '#e8552b';

export class Atlas {
  readonly W = 2048;
  private cells = new Map<string, [number, number, number, number]>();
  private reqs: { key: string; req: SignReq; w: number; h: number }[] = [];
  tex: THREE.CanvasTexture | null = null;
  emis: THREE.CanvasTexture | null = null;
  white: [number, number] = [0, 0];
  lamp: [number, number] = [0, 0];

  private static size(k: SignKind): [number, number] {
    switch (k) {
      case 'stop':
        return [160, 112];
      case 'platform':
        return [384, 128];
      case 'depart':
        return [128, 160];
      case 'totem':
        return [96, 384];
      case 'pid':
        return [256, 64];
      case 'banner':
        return [96, 448];
      case 'lettering':
        return [1024, 96];
      case 'clearance':
        return [256, 96];
    }
  }
  static key(r: SignReq): string {
    return `${r.kind}|${r.text}|${r.sub ?? ''}`;
  }
  /** Ask for a sign; its UV rect is available after build(). */
  want(r: SignReq): string {
    const key = Atlas.key(r);
    if (!this.reqs.some((q) => q.key === key)) {
      const [w, h] = Atlas.size(r.kind);
      this.reqs.push({ key, req: r, w, h });
    }
    return key;
  }
  rect(key: string): [number, number, number, number] {
    return this.cells.get(key) ?? [this.white[0], this.white[1], 0, 0];
  }
  build(): void {
    // shelf packing, tallest first
    const items = [...this.reqs].sort((a, b) => b.h - a.h);
    let x = 32;
    let y = 0;
    let shelf = 32;
    const place: { it: (typeof items)[number]; x: number; y: number }[] = [];
    for (const it of items) {
      if (x + it.w > this.W) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      place.push({ it, x, y });
      x += it.w;
      shelf = Math.max(shelf, it.h);
    }
    const H = THREE.MathUtils.ceilPowerOfTwo(Math.max(64, y + shelf));
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = H;
    const e = document.createElement('canvas');
    e.width = this.W;
    e.height = H;
    const ctx = c.getContext('2d')!;
    const ectx = e.getContext('2d')!;
    ectx.fillStyle = '#000';
    ectx.fillRect(0, 0, this.W, H);
    // white and lamp texels (16 px blocks at the top-left)
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 32, 32);
    ectx.fillStyle = '#fff';
    ectx.fillRect(16, 0, 16, 16);
    ectx.fillStyle = '#000';
    ectx.fillRect(0, 0, 16, 32);
    ectx.fillRect(16, 16, 16, 16);
    this.white = [8 / this.W, 1 - 8 / H];
    this.lamp = [24 / this.W, 1 - 8 / H];
    for (const p of place) {
      drawSign(ctx, p.x, p.y, p.it.w, p.it.h, p.it.req);
      // emissive: the sign at reduced strength (backlit panels), black elsewhere
      ectx.save();
      ectx.globalAlpha = p.it.req.kind === 'pid' ? 0.9 : p.it.req.kind === 'lettering' ? 0.55 : 0.32;
      ectx.drawImage(c, p.x, p.y, p.it.w, p.it.h, p.x, p.y, p.it.w, p.it.h);
      ectx.restore();
      const inset = 0.5;
      this.cells.set(p.it.key, [(p.x + inset) / this.W, 1 - (p.y + p.it.h - inset) / H, (p.it.w - 2 * inset) / this.W, (p.it.h - 2 * inset) / H]);
    }
    const mk = (cv: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.generateMipmaps = true;
      return t;
    };
    this.tex = mk(c);
    this.emis = mk(e);
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number): void {
  let s = size;
  ctx.font = `${weight} ${s}px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif`;
  while (s > 8 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif`;
  }
}

/** TransLink's swirl mark, simplified: a white circle with a curved stroke. */
function swirl(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, col = '#fff'): void {
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = r * 0.28;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.7, Math.PI * 0.9, Math.PI * 1.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.7, Math.PI * 1.9 - Math.PI, Math.PI * 0.9 - Math.PI * 0.05 + Math.PI);
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.restore();
}

function busIcon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  const h = w * 0.8;
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h * 0.85, w * 0.12);
  ctx.fill();
  ctx.fillStyle = ORANGE;
  ctx.fillRect(x + w * 0.12, y + h * 0.12, w * 0.76, h * 0.32);
  ctx.beginPath();
  ctx.arc(x + w * 0.25, y + h * 0.66, w * 0.07, 0, Math.PI * 2);
  ctx.arc(x + w * 0.75, y + h * 0.66, w * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + w * 0.1, y + h * 0.82, w * 0.18, h * 0.18);
  ctx.fillRect(x + w * 0.72, y + h * 0.82, w * 0.18, h * 0.18);
  ctx.restore();
}

function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: SignReq): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.textBaseline = 'alphabetic';
  switch (r.kind) {
    case 'stop': {
      // "Stop 2b": orange box, white text (KGS / Queen St door signs);
      // sub 'blue': UQ Lakes' blue lettered stop signs
      ctx.fillStyle = r.sub === 'blue' ? '#1f5aa6' : ORANGE;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.font = '600 24px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('Stop', 12, 32);
      fitText(ctx, r.text, 800, 68, w - 24);
      ctx.fillText(r.text, 12, h - 14);
      break;
    }
    case 'platform': {
      // "Platform 2  Outbound from City": orange hanging box
      ctx.fillStyle = ORANGE;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.font = '600 40px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('Platform', 18, 62);
      if (r.sub) {
        fitText(ctx, r.sub, 500, 22, w * 0.6);
        ctx.fillText(r.sub, 18, 100);
      }
      ctx.textAlign = 'right';
      fitText(ctx, r.text, 700, 104, w * 0.32);
      ctx.fillText(r.text, w - 16, h - 18);
      break;
    }
    case 'depart': {
      // "Depart / Bus stop / Hail driver" flag
      ctx.fillStyle = ORANGE;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.font = '700 26px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('Depart', 10, 32);
      busIcon(ctx, 12, 46, 52);
      ctx.fillRect(78, 50, 10, 10);
      ctx.fillRect(76, 62, 14, 30);
      ctx.font = '500 15px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('Bus stop', 10, 120);
      ctx.fillText('Hail driver', 10, 140);
      ctx.beginPath();
      ctx.moveTo(w - 30, 112);
      ctx.lineTo(w - 30, 144);
      ctx.lineTo(w - 40, 134);
      ctx.moveTo(w - 30, 144);
      ctx.lineTo(w - 20, 134);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.stroke();
      break;
    }
    case 'totem': {
      // black totem with an orange top carrying the TransLink mark, white station name
      ctx.fillStyle = '#1e1f21';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ORANGE;
      ctx.fillRect(0, 0, w, 110);
      swirl(ctx, w / 2, 52, 30);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '700 12px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('TRANSLink', w / 2, 100);
      const words = r.text.split(' ');
      let yy = 150;
      for (const wd of words) {
        fitText(ctx, wd, 600, 20, w - 10);
        ctx.fillText(wd, w / 2, yy);
        yy += 24;
      }
      ctx.font = '600 13px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('station', w / 2, yy + 2);
      busIcon(ctx, w / 2 - 18, h - 70, 36);
      break;
    }
    case 'pid': {
      ctx.fillStyle = '#0d0d0f';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffb02e';
      ctx.textAlign = 'left';
      ctx.font = '600 13px ui-monospace, Menlo, Consolas, monospace';
      const lines = r.text.split('|');
      lines.slice(0, 3).forEach((ln, i) => ctx.fillText(ln, 8, 18 + i * 18));
      ctx.textAlign = 'right';
      ['2 min', '5 min', '9 min'].forEach((t, i) => ctx.fillText(t, w - 8, 18 + i * 18));
      break;
    }
    case 'banner': {
      // vertical orange banner on lift towers
      ctx.fillStyle = ORANGE;
      ctx.fillRect(0, 0, w, h);
      swirl(ctx, w / 2, 48, 30);
      ctx.save();
      ctx.translate(w / 2 + 14, h - 20);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      fitText(ctx, r.text, 700, 46, h - 120);
      ctx.fillText(r.text, 0, 0);
      ctx.restore();
      break;
    }
    case 'lettering': {
      // station name in orange letters with the orange swirl tile (pavilions, entrances)
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ORANGE;
      ctx.fillRect(10, 12, h - 24, h - 24);
      swirl(ctx, 10 + (h - 24) / 2, h / 2, (h - 24) / 2.4);
      ctx.textAlign = 'left';
      fitText(ctx, r.text, 700, 64, w - h - 20);
      ctx.fillText(r.text, h + 4, h - 26);
      break;
    }
    case 'clearance': {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 6;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.font = '700 28px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillText('CLEARANCE', w / 2, 40);
      ctx.fillText(r.text, w / 2, 78);
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Materials

const PAT_VERT_PARS = /* glsl */ `
attribute vec4 aPat;
varying vec4 vSPat;
varying vec3 vSWP;
`;
const PAT_FRAG_PARS = /* glsl */ `
varying vec4 vSPat;
varying vec3 vSWP;
float sLine(float c, float s, float lw) {
  float f = abs(fract(c / s - 0.5) - 0.5) * s;
  float w = fwidth(c);
  float fade = clamp(1.0 - w / (s * 0.3), 0.0, 1.0);
  return (1.0 - smoothstep(lw, lw + w * 1.5, f)) * fade;
}
vec3 sPattern(vec3 col) {
  float k = floor(vSPat.x + 0.5);
  float s = max(vSPat.y, 0.05);
  vec2 l = vSPat.zw;
  if (k == 1.0) {
    float g = max(sLine(l.x, s, 0.006), sLine(l.y, s, 0.006));
    // slight per-tile tone variation
    vec2 id = floor(l / s);
    float n = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
    return col * (0.95 + 0.07 * n) * (1.0 - 0.28 * g);
  } else if (k == 2.0) {
    vec2 c = fract(l / 0.075) - 0.5;
    float w = fwidth(l.x / 0.075);
    float dot_ = 1.0 - smoothstep(0.22, 0.22 + w * 1.5, length(c));
    float fade = clamp(1.0 - w * 2.0, 0.0, 1.0);
    return col * (1.0 + 0.35 * dot_ * fade);
  } else if (k == 3.0) {
    float y = vSWP.y;
    float f = fract(y / s);
    float w = fwidth(y / s);
    float fade = clamp(1.0 - w * 2.0, 0.0, 1.0);
    float shade = mix(1.0, 0.62 + 0.5 * smoothstep(0.0, 0.7, f), fade);
    return col * shade;
  } else if (k == 4.0) {
    float g = max(sLine(l.x, s, 0.09), sLine(l.y, s, 0.09));
    return mix(col, vec3(0.93, 0.92, 0.9), g);
  } else if (k == 5.0) {
    float g = max(sLine(l.x, s, 0.008), sLine(l.y, s * 2.0, 0.008));
    return col * (1.0 - 0.18 * g);
  }
  return col;
}
// Undersides (soffits, ceilings) only see the hemisphere's ground colour; in
// reality bounce light from the platform keeps them bright.
float sGlow() {
  float k = floor(vSPat.x + 0.5);
  return (k == 4.0 || k == 5.0) ? 0.42 : 0.0;
}
`;

/** Opaque station material: vertex colours x sign atlas, emissive atlas for signs and lamps, patterns. */
export function stationMaterial(atlas: Atlas): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    vertexColors: true,
    map: atlas.tex,
    emissive: 0xffffff,
    emissiveMap: atlas.emis,
    emissiveIntensity: 1,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${PAT_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSPat = aPat;\nvSWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${PAT_FRAG_PARS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = sPattern(diffuseColor.rgb);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * sGlow();');
  };
  m.customProgramCacheKey = () => 'station-opaque-v2';
  return m;
}

/** Glass (screens, balustrades, enclosures): vertex-tinted, see-through. */
export function glassMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: 0x0c1414,
  });
}

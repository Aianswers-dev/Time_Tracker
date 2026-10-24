// Vehicle footprints shared by the AI buses, the AI cars and the player.

export interface Body {
  /** Sample points along the body centreline (map x/y), front first. */
  x: Float32Array;
  y: Float32Array;
  n: number;
  heading: number;
  speed: number;
  /** Front point. */
  fx: number;
  fy: number;
}

export function makeBody(n: number): Body {
  return { x: new Float32Array(n), y: new Float32Array(n), n, heading: 0, speed: 0, fx: 0, fy: 0 };
}

/** Uniform hash grid of points, rebuilt every frame (no allocation after warm-up). */
export class PointGrid {
  private head: Int32Array;
  private next: Int32Array;
  px: Float32Array;
  py: Float32Array;
  /** Payload per point (e.g. speed). */
  pv: Float32Array;
  /** Owner id per point. */
  pid: Int32Array;
  count = 0;
  private readonly mask: number;

  constructor(
    readonly cell: number,
    capacity: number,
    bits = 12,
  ) {
    this.head = new Int32Array(1 << bits).fill(-1);
    this.mask = (1 << bits) - 1;
    this.next = new Int32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pv = new Float32Array(capacity);
    this.pid = new Int32Array(capacity);
  }

  private key(cx: number, cy: number): number {
    return ((cx * 73856093) ^ (cy * 19349663)) & this.mask;
  }

  clear(): void {
    this.head.fill(-1);
    this.count = 0;
  }

  add(x: number, y: number, v: number, id: number): void {
    if (this.count >= this.px.length) {
      const cap = this.px.length * 2;
      const grow = <T extends Float32Array | Int32Array>(a: T, C: new (n: number) => T): T => {
        const b = new C(cap);
        b.set(a);
        return b;
      };
      this.next = grow(this.next, Int32Array);
      this.px = grow(this.px, Float32Array);
      this.py = grow(this.py, Float32Array);
      this.pv = grow(this.pv, Float32Array);
      this.pid = grow(this.pid, Int32Array);
    }
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.pv[i] = v;
    this.pid[i] = id;
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    this.next[i] = this.head[k];
    this.head[k] = i;
  }

  /** Visit points within r of (x, y) until `fn` returns true. */
  query(x: number, y: number, r: number, fn: (i: number) => boolean): void {
    const c0x = Math.floor((x - r) / this.cell);
    const c1x = Math.floor((x + r) / this.cell);
    const c0y = Math.floor((y - r) / this.cell);
    const c1y = Math.floor((y + r) / this.cell);
    const r2 = r * r;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let i = this.head[this.key(cx, cy)]; i >= 0; i = this.next[i]) {
          const dx = this.px[i] - x;
          const dy = this.py[i] - y;
          if (dx * dx + dy * dy <= r2 && fn(i)) return;
        }
      }
    }
  }

  /** Index of the nearest point within r of (x, y) whose id != skip, or -1. */
  nearest(x: number, y: number, r: number, skip = -2147483648): number {
    const c0x = Math.floor((x - r) / this.cell);
    const c1x = Math.floor((x + r) / this.cell);
    const c0y = Math.floor((y - r) / this.cell);
    const c1y = Math.floor((y + r) / this.cell);
    let best = -1;
    let bd = r * r;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let i = this.head[this.key(cx, cy)]; i >= 0; i = this.next[i]) {
          if (this.pid[i] === skip) continue;
          const dx = this.px[i] - x;
          const dy = this.py[i] - y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

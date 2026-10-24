// Canvas painting of the body atlases: colour (with alpha cut-outs for wheel
// arches and door apertures), a quarter-res emissive map (saloon windows lit
// at night) and a quarter-res roughness map (glossy glass vs paint).
import type { AtlasLayout, Rect } from './shell';
import type { BodyLayout, SectionLayout, WindowSpan } from './spec';
import { C, type Livery } from './livery';
import { LAMP_OFF, lampsFor, type LampDef } from './lamps';
import { FONT, makeCanvas, roundRect } from './util';

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];

/** Maps bus metres to canvas pixels for one atlas region. */
class RP {
  constructor(
    readonly ctx: Ctx,
    readonly r: Rect,
    /** Metres across the region (body length for sides, width for ends). */
    readonly len: number,
    readonly y0: number,
    readonly yTop: number,
    /** Sides: right side is mirrored so text reads correctly. */
    readonly mirror: boolean,
  ) {}
  get sx(): number {
    return this.r.w / this.len;
  }
  get sy(): number {
    return this.r.h / (this.yTop - this.y0);
  }
  X(s: number): number {
    const a = this.mirror ? this.len - s : s;
    return this.r.x + a * this.sx;
  }
  Y(h: number): number {
    return this.r.y + (this.yTop - h) * this.sy;
  }
  fill(s0: number, s1: number, h0: number, h1: number, style: string | CanvasGradient): void {
    const x0 = this.X(s0), x1 = this.X(s1);
    this.ctx.fillStyle = style;
    this.ctx.fillRect(Math.min(x0, x1), this.Y(h1), Math.abs(x1 - x0), this.Y(h0) - this.Y(h1));
  }
  rrect(s0: number, s1: number, h0: number, h1: number, rad: number, style: string | CanvasGradient): void {
    const x0 = this.X(s0), x1 = this.X(s1);
    roundRect(this.ctx, Math.min(x0, x1), this.Y(h1), Math.abs(x1 - x0), this.Y(h0) - this.Y(h1), rad * this.sy);
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }
  vgrad(h0: number, h1: number, stops: [number, string][]): CanvasGradient {
    const g = this.ctx.createLinearGradient(0, this.Y(h1), 0, this.Y(h0));
    for (const [t, c] of stops) g.addColorStop(t, c);
    return g;
  }
  /** Smooth closed/open path through points using Catmull-Rom splines. */
  spline(pts: Pt[], begin = true): void {
    const c = this.ctx;
    const P = pts.map(([s, h]) => [this.X(s), this.Y(h)] as Pt);
    if (begin) {
      c.beginPath();
      c.moveTo(P[0][0], P[0][1]);
    } else c.lineTo(P[0][0], P[0][1]);
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      c.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1],
      );
    }
  }
  line(pts: Pt[]): void {
    for (const [s, h] of pts) this.ctx.lineTo(this.X(s), this.Y(h));
  }
  /** Fill the area between a curve and a flat bottom. */
  under(curve: Pt[], bottom: number, style: string | CanvasGradient): void {
    this.spline(curve);
    this.line([[curve[curve.length - 1][0], bottom], [curve[0][0], bottom]]);
    this.ctx.closePath();
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }
  /** Fill the band between two curves (same s order). */
  band(upper: Pt[], lower: Pt[], style: string | CanvasGradient): void {
    this.spline(upper);
    this.spline([...lower].reverse(), false);
    this.ctx.closePath();
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }
  /**
   * Draw in a local frame centred on (s, h), units = metres, +y down.
   * `follow` mirrors the drawing on mirrored sides (things that face forward).
   */
  local(s: number, h: number, fn: (c: Ctx) => void, follow = false): void {
    const c = this.ctx;
    c.save();
    c.translate(this.X(s), this.Y(h));
    c.scale(this.sx * (follow && this.mirror ? -1 : 1), this.sy);
    fn(c);
    c.restore();
  }
  /** Text with its height in metres, corrected for the region's aspect. */
  text(str: string, s: number, h: number, size: number, color: string, opts: { align?: CanvasTextAlign; weight?: string; italic?: boolean; font?: string; maxW?: number; stroke?: string; base?: CanvasTextBaseline } = {}): number {
    const c = this.ctx;
    c.save();
    c.translate(this.X(s), this.Y(h));
    const k = this.sx / this.sy;
    c.scale(k, 1);
    const px = size * this.sy;
    c.font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 'bold'} ${px}px ${opts.font ?? FONT}`;
    c.textAlign = opts.align ?? 'center';
    c.textBaseline = opts.base ?? 'middle';
    let w = c.measureText(str).width;
    if (opts.maxW) {
      const max = (opts.maxW * this.sx) / k;
      if (w > max) {
        c.scale(max / w, 1);
        w = max;
      }
    }
    if (opts.stroke) {
      c.strokeStyle = opts.stroke;
      c.lineWidth = px * 0.12;
      c.strokeText(str, 0, 0);
    }
    c.fillStyle = color;
    c.fillText(str, 0, 0);
    c.restore();
    return (w * k) / this.sx;
  }
  clip(): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(this.r.x, this.r.y, this.r.w, this.r.h);
    this.ctx.clip();
  }
  unclip(): void {
    this.ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Reusable decals (drawn in local metre frames, +y down)

function translinkMark(c: Ctx, d: number, fg: string, bg: string): void {
  // circle with a white wave swoosh
  c.beginPath();
  c.arc(0, 0, d / 2, 0, Math.PI * 2);
  c.fillStyle = bg;
  c.fill();
  c.save();
  c.clip();
  c.strokeStyle = fg;
  c.lineWidth = d * 0.13;
  c.beginPath();
  c.moveTo(-d * 0.55, d * 0.12);
  c.bezierCurveTo(-d * 0.2, -d * 0.35, d * 0.15, d * 0.45, d * 0.55, -d * 0.1);
  c.stroke();
  c.lineWidth = d * 0.09;
  c.beginPath();
  c.moveTo(-d * 0.55, d * 0.38);
  c.bezierCurveTo(-d * 0.2, -d * 0.05, d * 0.15, d * 0.7, d * 0.55, d * 0.18);
  c.stroke();
  c.restore();
}

/** "TRANSLink" (or lowercase "translink") lockup centred at (s, h). */
function translinkLogo(p: RP, s: number, h: number, size: number, color: string, markBg: string, lower = false): void {
  const label = lower ? 'translink' : 'TRANSLink';
  // measure first (at alignment left) to centre the lockup
  const c = p.ctx;
  c.save();
  c.font = `bold ${size * p.sy}px ${FONT}`;
  const tw = (c.measureText(label).width * (p.sx / p.sy)) / p.sx;
  c.restore();
  const total = size * 1.25 + tw;
  const s0 = s - (p.mirror ? -1 : 1) * total / 2;
  const dir = p.mirror ? -1 : 1;
  const whiteText = color === '#ffffff';
  p.local(s0 + dir * size * 0.5, h, (cc) => translinkMark(cc, size * 1.05, whiteText ? markBg : '#ffffff', whiteText ? '#ffffff' : markBg));
  p.text(label, s0 + dir * size * 1.2, h, size * (lower ? 1.0 : 0.82), color, { align: p.mirror ? 'right' : 'left', weight: '800', italic: !lower });
}

function wheelchair(p: RP, s: number, h: number, size: number): void {
  p.local(s, h, (c) => {
    c.fillStyle = '#1f5fbf';
    roundRect(c, -size / 2, -size / 2, size, size, size * 0.1);
    c.fill();
    c.strokeStyle = '#fff';
    c.fillStyle = '#fff';
    c.lineWidth = size * 0.08;
    c.beginPath();
    c.arc(-size * 0.02, -size * 0.3, size * 0.07, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.moveTo(-size * 0.05, -size * 0.2);
    c.lineTo(-size * 0.05, size * 0.05);
    c.lineTo(size * 0.2, size * 0.05);
    c.lineTo(size * 0.25, size * 0.3);
    c.stroke();
    c.beginPath();
    c.arc(-size * 0.03, size * 0.15, size * 0.2, Math.PI * 0.6, Math.PI * 1.9);
    c.stroke();
  });
}

/** Gliding possum (CityGlider motif), nose toward -y. */
function possumPath(c: Ctx, k: number): void {
  c.beginPath();
  c.moveTo(0, -0.62 * k); // nose
  c.quadraticCurveTo(0.12 * k, -0.6 * k, 0.14 * k, -0.48 * k);
  c.lineTo(0.22 * k, -0.6 * k); // ear
  c.lineTo(0.2 * k, -0.42 * k);
  c.lineTo(0.55 * k, -0.42 * k); // front paw
  c.quadraticCurveTo(0.34 * k, -0.05 * k, 0.5 * k, 0.34 * k); // membrane edge
  c.lineTo(0.2 * k, 0.3 * k);
  c.quadraticCurveTo(0.16 * k, 0.5 * k, 0.24 * k, 0.75 * k); // tail
  c.quadraticCurveTo(0.3 * k, 1.05 * k, 0.05 * k, 1.2 * k);
  c.quadraticCurveTo(0.12 * k, 0.95 * k, -0.02 * k, 0.72 * k);
  c.quadraticCurveTo(-0.12 * k, 0.5 * k, -0.2 * k, 0.3 * k);
  c.lineTo(-0.5 * k, 0.34 * k);
  c.quadraticCurveTo(-0.34 * k, -0.05 * k, -0.55 * k, -0.42 * k);
  c.lineTo(-0.2 * k, -0.42 * k);
  c.lineTo(-0.22 * k, -0.6 * k);
  c.lineTo(-0.14 * k, -0.48 * k);
  c.quadraticCurveTo(-0.12 * k, -0.6 * k, 0, -0.62 * k);
  c.closePath();
}

function possum(p: RP, s: number, h: number, size: number, rot: number, fill: string | null, stroke: string | null, lw = 0.035): void {
  p.local(
    s,
    h,
    (c) => {
      c.rotate(rot);
      possumPath(c, size);
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = lw;
        c.lineJoin = 'round';
        c.stroke();
      }
    },
    true,
  );
}

function plate(p: RP, a: number, h: number, text: string): void {
  p.rrect(a - 0.19, a + 0.19, h - 0.06, h + 0.06, 0.015, '#f4f4f0');
  p.text(text.slice(0, 3) + '·' + text.slice(3), a, h + 0.008, 0.07, '#7a1030', { weight: '700', maxW: 0.34 });
  p.text('QUEENSLAND - SUNSHINE STATE', a, h - 0.045, 0.016, '#7a1030', { weight: '600', maxW: 0.32 });
}

function hailSticker(p: RP, a: number, h: number, w: number): void {
  p.fill(a - w / 2, a + w / 2, h - 0.035, h + 0.035, '#f7d117');
  p.text('PLEASE HAIL DRIVER', a, h, 0.05, '#111', { weight: '900', maxW: w * 0.86 });
  p.local(a - w / 2 + 0.035, h, (c) => {
    c.fillStyle = '#111';
    c.beginPath();
    c.arc(0, 0, 0.022, 0, Math.PI * 2);
    c.fill();
  });
  p.local(a + w / 2 - 0.035, h, (c) => {
    c.fillStyle = '#111';
    c.beginPath();
    c.arc(0, 0, 0.022, 0, Math.PI * 2);
    c.fill();
  });
}

// ---------------------------------------------------------------------------
// Glass

type Tint = 'std' | 'dark';

function glass(p: RP, s0: number, s1: number, h0: number, h1: number, tint: Tint, rad = 0.05): void {
  const top = tint === 'dark' ? '#2a3442' : '#38485a';
  const mid = tint === 'dark' ? '#0e131b' : '#141b24';
  const bot = tint === 'dark' ? '#080b10' : '#0b0f15';
  p.rrect(s0, s1, h0, h1, rad, p.vgrad(h0, h1, [[0, top], [0.32, mid], [1, bot]]));
  // soft diagonal reflection streaks
  const c = p.ctx;
  c.save();
  const x0 = p.X(s0), x1 = p.X(s1);
  roundRect(c, Math.min(x0, x1), p.Y(h1), Math.abs(x1 - x0), p.Y(h0) - p.Y(h1), rad * p.sy);
  c.clip();
  c.globalAlpha = 0.07;
  c.fillStyle = '#dfe8f5';
  const span = Math.abs(s1 - s0);
  for (let k = 0; k < Math.max(1, Math.round(span / 1.6)); k++) {
    const sc = s0 + (span * (k + 0.3)) / Math.max(1, Math.round(span / 1.6));
    c.beginPath();
    c.moveTo(p.X(sc), p.Y(h1));
    c.lineTo(p.X(sc + 0.35), p.Y(h1));
    c.lineTo(p.X(sc - 0.2), p.Y(h0));
    c.lineTo(p.X(sc - 0.5), p.Y(h0));
    c.closePath();
    c.fill();
  }
  c.restore();
}

function windowBand(p: RP, wins: WindowSpan[], tint: Tint, frame = '#07090c'): void {
  for (const w of wins) p.rrect(w.z0 - 0.06, w.z1 + 0.06, w.y0 - 0.035, w.y1 + 0.035, 0.07, frame);
  for (const w of wins) glass(p, w.z0, w.z1, w.y0, w.y1, tint, 0.05);
}

function emergencySticker(p: RP, s: number, h: number): void {
  p.fill(s - 0.09, s + 0.09, h - 0.025, h + 0.025, '#d0161b');
  p.text('EMERGENCY EXIT', s, h, 0.022, '#fff', { maxW: 0.17 });
}

// ---------------------------------------------------------------------------
// Doors (painted closed, for low detail) and cut-outs

function paintedDoor(p: RP, z0: number, z1: number, B: BodyLayout, metro: boolean): void {
  const top = B.doorTop;
  p.fill(z0, z1, B.y0, top, '#07090c');
  const mid = (z0 + z1) / 2;
  glass(p, z0 + 0.05, mid - 0.025, B.y0 + 0.12, top - 0.06, 'std', 0.03);
  glass(p, mid + 0.025, z1 - 0.05, B.y0 + 0.12, top - 0.06, 'std', 0.03);
  if (metro) {
    for (const s of [mid - 0.05, mid + 0.05]) p.fill(s - 0.025, s + 0.025, B.y0 + 0.12, top - 0.06, '#f2c200');
  }
}

function archRings(p: RP, sec: SectionLayout, B: BodyLayout): void {
  for (const ax of sec.axles) {
    const s = ax.z - sec.bodyFront;
    const R = B.tyreR + 0.11;
    p.local(s, B.tyreR, (cc) => {
      cc.beginPath();
      cc.arc(0, 0, R + 0.05, Math.PI, 0);
      cc.lineTo(R + 0.05, B.tyreR);
      cc.lineTo(-R - 0.05, B.tyreR);
      cc.closePath();
      cc.fillStyle = '#0c0d0f';
      cc.fill();
    });
  }
}

function cutArches(p: RP, sec: SectionLayout, B: BodyLayout): void {
  for (const ax of sec.axles) {
    const s = ax.z - sec.bodyFront;
    const R = B.tyreR + 0.11;
    p.local(s, B.tyreR, (cc) => {
      cc.beginPath();
      cc.arc(0, 0, R, Math.PI, 0);
      cc.lineTo(R, B.tyreR + 0.1);
      cc.lineTo(-R, B.tyreR + 0.1);
      cc.closePath();
      cc.fill();
    });
  }
}

function cutDoors(p: RP, sec: SectionLayout, B: BodyLayout): void {
  for (const d of sec.doors) {
    const x0 = p.X(d.z0 - sec.bodyFront), x1 = p.X(d.z1 - sec.bodyFront);
    roundRect(p.ctx, Math.min(x0, x1), p.Y(B.doorTop), Math.abs(x1 - x0), p.Y(B.y0 - 0.05) - p.Y(B.doorTop), 0.04 * p.sy);
    p.ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Lamps (off state lenses)

function paintLamps(p: RP, lamps: LampDef[], face: string): void {
  for (const d of lamps) {
    if (d.face !== face) continue;
    const col = LAMP_OFF[d.kind];
    const a = d.a;
    if (d.circle) {
      p.local(a, d.h, (c) => {
        const r = d.w / 2;
        c.beginPath();
        c.arc(0, 0, r * 1.18, 0, Math.PI * 2);
        c.fillStyle = '#2a2d33';
        c.fill();
        const g = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.5, col);
        g.addColorStop(1, '#5d636b');
        c.beginPath();
        c.arc(0, 0, r, 0, Math.PI * 2);
        c.fillStyle = g;
        c.fill();
      });
    } else {
      p.rrect(a - d.w / 2 - 0.01, a + d.w / 2 + 0.01, d.h - d.t / 2 - 0.01, d.h + d.t / 2 + 0.01, 0.015, '#1d1f23');
      p.rrect(a - d.w / 2, a + d.w / 2, d.h - d.t / 2, d.h + d.t / 2, 0.012, p.vgrad(d.h - d.t / 2, d.h + d.t / 2, [[0, '#ffffff'], [0.25, col], [1, col]]));
    }
  }
}

/** Smoky headlamp housing behind the lamp lenses (Optimus style). */
function optimusHeadUnits(p: RP, W: number): void {
  for (const flip of [false, true]) {
    const A = (a: number) => (flip ? W - a : a);
    const c = p.ctx;
    c.beginPath();
    const pts: Pt[] = [[A(0.05), 0.745], [A(0.6), 0.735], [A(0.66), 0.8], [A(0.58), 0.915], [A(0.08), 0.935]];
    pts.forEach(([s, h], i) => (i ? c.lineTo(p.X(s), p.Y(h)) : c.moveTo(p.X(s), p.Y(h))));
    c.closePath();
    const g = c.createLinearGradient(0, p.Y(0.935), 0, p.Y(0.735));
    g.addColorStop(0, '#30353c');
    g.addColorStop(0.5, '#15181c');
    g.addColorStop(1, '#22262b');
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = '#8a9099';
    c.lineWidth = 0.01 * p.sy;
    c.stroke();
    // chrome reflector bowls behind the LED projectors
    for (const a of [0.3, 0.44]) {
      p.local(A(a), 0.835, (cc) => {
        const rg = cc.createRadialGradient(0, 0, 0.01, 0, 0, 0.065);
        rg.addColorStop(0, '#f4f6f8');
        rg.addColorStop(0.6, '#9aa1aa');
        rg.addColorStop(1, '#2a2e34');
        cc.fillStyle = rg;
        cc.beginPath();
        cc.arc(0, 0, 0.062, 0, Math.PI * 2);
        cc.fill();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Optimus front (shared by all 12.5 m liveries)

interface OptFront {
  panel: string;
  pillar: string;
  bumper: string;
  header: string;
  bandText: string;
}

function optimusFront(p: RP, B: BodyLayout, f: OptFront, lv: Livery, lamps: LampDef[]): void {
  const W = B.hw * 2;
  p.fill(0, W, B.y0, B.yTop, f.header);
  p.fill(0, W, B.y0, 0.72, f.bumper);
  p.fill(0, W, 0.72, 0.99, f.panel);
  p.fill(0, W, B.y0, 0.345, '#15171b'); // bumper lip
  // A-pillars
  p.fill(0, 0.13, 0.99, B.yTop - 0.05, f.pillar);
  p.fill(W - 0.13, W, 0.99, B.yTop - 0.05, f.pillar);
  // windscreen lower band with VOLGREN lettering
  p.rrect(0.11, W - 0.11, 0.985, 1.12, 0.02, '#0a0c0f');
  const letters = 'VOLGREN';
  letters.split('').forEach((ch, i) => p.text(ch, W / 2 + (i - 3) * 0.085, 1.05, 0.05, f.bandText, { weight: '600' }));
  // windscreen
  glass(p, 0.13, W - 0.13, 1.11, 2.73, 'std', 0.08);
  // dashboard / wheel silhouette behind the glass (driver on the viewer's left)
  p.ctx.save();
  p.ctx.globalAlpha = 0.55;
  p.rrect(0.16, W - 0.16, 1.11, 1.5, 0.05, '#05070a');
  p.local(B.hw - 0.62, 1.62, (c) => {
    c.strokeStyle = '#05070a';
    c.lineWidth = 0.045;
    c.beginPath();
    c.ellipse(0, 0, 0.26, 0.09, 0, 0, Math.PI * 2);
    c.stroke();
  });
  p.local(B.hw - 0.62, 1.98, (c) => {
    // driver
    c.fillStyle = '#05070a';
    c.beginPath();
    c.ellipse(0, 0, 0.11, 0.13, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(0, 0.32, 0.24, 0.2, 0, Math.PI, 0);
    c.fill();
  });
  p.ctx.restore();
  hailSticker(p, W / 2 + 0.22, 2.63, 0.82);
  // destination box (the LED sign mesh sits on top)
  p.rrect(0.13, W - 0.13, 2.72, 3.0, 0.03, '#050607');
  for (const a of [0.2, W - 0.2]) {
    p.local(a, 2.86, (c) => {
      c.fillStyle = '#c9ccd0';
      c.beginPath();
      c.arc(0, 0, 0.04, 0, Math.PI * 2);
      c.fill();
    });
  }
  optimusHeadUnits(p, W);
  paintLamps(p, lamps, 'front');
  // number plate and fleet number on the bumper
  plate(p, W / 2, 0.47, lv.plate);
  p.text(lv.fleet, W - 0.55, 0.5, 0.13, '#ffffff', { weight: '800', maxW: 0.62 });
}

function optimusRear(p: RP, B: BodyLayout, body: string, bumper: string, corner: string, lv: Livery, lamps: LampDef[]): void {
  const W = B.hw * 2;
  p.fill(0, W, B.y0, B.yTop, body);
  p.fill(0, W, B.y0, 0.62, bumper);
  p.fill(0, W, B.y0, 0.345, '#15171b');
  p.fill(0, 0.1, 0.62, B.yTop - 0.06, corner);
  p.fill(W - 0.1, W, 0.62, B.yTop - 0.06, corner);
  // rear window
  p.rrect(0.2, W - 0.2, 1.88, 2.84, 0.08, '#07090c');
  glass(p, 0.24, W - 0.24, 1.92, 2.8, 'std', 0.06);
  p.rrect(W / 2 - 0.34, W / 2 + 0.34, 2.5, 2.79, 0.02, '#040506');
  // engine door with louvres
  p.rrect(0.34, W - 0.34, 0.66, 1.66, 0.04, 'rgba(0,0,0,0.07)');
  p.ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  p.ctx.lineWidth = 0.008 * p.sy;
  p.ctx.strokeRect(p.X(0.34), p.Y(1.66), p.X(W - 0.34) - p.X(0.34), p.Y(0.66) - p.Y(1.66));
  for (let h = 1.22; h < 1.58; h += 0.045) p.fill(0.5, W - 0.5, h, h + 0.022, '#2c3036');
  // tail clusters
  for (const a of [0.16, W - 0.16]) p.rrect(a - 0.1, a + 0.1, 0.66, 1.49, 0.03, '#15171b');
  paintLamps(p, lamps, 'rear');
  plate(p, W / 2, 0.47, lv.plate);
  p.text(lv.fleet, W - 0.48, 1.78, 0.08, '#111', { weight: '800' });
  p.text('VOLVO', W / 2, 0.76, 0.045, '#4a4f57', { weight: '700' });
}

// ---------------------------------------------------------------------------
// Side painters per livery

interface SideCtx {
  p: RP;
  B: BodyLayout;
  sec: SectionLayout;
  lv: Livery;
  side: 'L' | 'R';
  Lb: number;
  lamps: LampDef[];
  /** z' -> s (distance behind the body front). */
  S: (z: number) => number;
  wins: WindowSpan[];
  /** Total length of sections ahead (for continuous patterns). */
  offset: number;
}

function sideCommon(sc: SideCtx, tint: Tint, paintDoors: boolean, frame?: string): void {
  const { p, B, sec, side } = sc;
  windowBand(p, sc.wins.map((w) => ({ ...w, z0: sc.S(w.z0), z1: sc.S(w.z1) })), tint, frame);
  if (side === 'L' && paintDoors) for (const d of sec.doors) paintedDoor(p, sc.S(d.z0), sc.S(d.z1), B, B.type === 'metro');
  archRings(p, sec, B);
  paintLamps(p, sc.lamps, side === 'L' ? 'left' : 'right');
}

function sideTranslink(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv, side } = sc;
  p.fill(0, Lb, B.y0, B.yTop, C.white);
  p.fill(0, Lb, B.y0, 0.82, C.btBlue);
  // yellow front corner
  p.fill(0, 0.3, 0.82, B.yTop - 0.09, C.btYellow);
  // rear quarter swoosh: yellow band ahead of a blue sweep
  p.band(
    [[Lb - 4.4, 0.82], [Lb - 1.6, 1.06], [Lb - 0.72, 1.9], [Lb - 0.58, B.yTop - 0.09]],
    [[Lb - 3.3, 0.82], [Lb - 1.05, 1.02], [Lb - 0.42, 1.9], [Lb - 0.36, B.yTop - 0.09]],
    C.btYellow,
  );
  p.spline([[Lb - 3.3, 0.82], [Lb - 1.05, 1.02], [Lb - 0.42, 1.9], [Lb - 0.36, B.yTop - 0.09]]);
  p.line([[Lb, B.yTop - 0.09], [Lb, 0.82]]);
  p.ctx.closePath();
  p.ctx.fillStyle = C.btBlue;
  p.ctx.fill();
  sideCommon(sc, 'std', paintDoors);
  // branding on the upper band
  p.text(lv.fleet, 0.95, 2.78, 0.12, '#15171a', { weight: '800' });
  p.text(lv.fleet, Lb - 1.2, 2.78, 0.1, '#15171a', { weight: '800' });
  translinkLogo(p, Lb - 3.3, 2.78, 0.09, C.navy, C.btBlue);
  p.text('translink.com.au  |  13 12 30', Lb - 5.6, 2.78, 0.055, '#3a4250', { weight: '600' });
  if (side === 'L') {
    p.text('AIR CONDITIONED', 3.1, 2.78, 0.06, C.navy, { italic: true, weight: '800' });
    wheelchair(p, 1.72, 0.98, 0.14);
    p.rrect(Lb - 2.05, Lb - 1.8, 0.48, 0.73, 0.02, 'rgba(0,0,0,0.18)'); // fuel flap
  } else {
    for (let h = 0.4; h < 0.76; h += 0.05) p.fill(Lb - 2.7, Lb - 0.9, h, h + 0.025, '#163f8a'); // engine louvres
  }
  for (const w of sc.wins.slice(1, 4)) if (side === 'R' || w.z0 > 6) emergencySticker(p, sc.S(w.z0) + 0.15, w.y1 - 0.06);
}

function gliderWaves(sc: SideCtx, deep: string, light: string, body: string): void {
  const { p, B, Lb } = sc;
  p.fill(0, Lb, B.y0, B.yTop, body);
  // light band then deep blue sweep
  const deepTop: Pt[] = [[-0.1, 1.14], [0.9, 1.08], [2.6, 0.6], [5.0, 0.44], [7.6, 0.62], [9.6, 1.0], [Lb - 1.6, 1.16], [Lb + 0.1, 1.2]];
  const lightTop: Pt[] = deepTop.map(([s, h], i) => [s, Math.min(1.22, h + (i === 0 || i === deepTop.length - 1 ? 0.05 : 0.2 + 0.08 * Math.sin(i)))]);
  const thin: Pt[] = deepTop.map(([s, h]) => [s, Math.min(1.24, h + 0.36)]);
  const thin2: Pt[] = deepTop.map(([s, h]) => [s, Math.min(1.25, h + 0.42)]);
  p.band(thin2, thin, light);
  p.under(lightTop, B.y0, light);
  p.under(deepTop, B.y0, deep);
  // rear quarter rises to the roof in deep blue
  p.band(
    [[Lb - 2.6, 1.15], [Lb - 1.0, 1.6], [Lb - 0.45, B.yTop - 0.1]],
    [[Lb - 1.5, 1.15], [Lb - 0.3, 1.5], [Lb + 0.05, B.yTop - 0.1]],
    light,
  );
  p.spline([[Lb - 1.5, 1.15], [Lb - 0.3, 1.5], [Lb + 0.05, B.yTop - 0.1]]);
  p.line([[Lb, B.y0], [Lb - 1.5, B.y0]]);
  p.ctx.closePath();
  p.ctx.fillStyle = deep;
  p.ctx.fill();
}

function gliderLettering(sc: SideCtx, cityCol: string, gliderCol: string): void {
  const { p, side } = sc;
  const s = side === 'L' ? 4.3 : 4.1;
  const c = p.ctx;
  c.save();
  // "City" + "Glider" as one word, centred on s
  const size = 0.44;
  c.font = `italic 800 ${size * p.sy}px ${FONT}`;
  const k = p.sx / p.sy;
  const wCity = (c.measureText('City').width * k) / p.sx;
  const wGl = (c.measureText('Glider').width * k) / p.sx;
  c.restore();
  const total = wCity + wGl;
  const dir = p.mirror ? -1 : 1;
  const start = s - (dir * total) / 2;
  p.text('City', start + (dir * wCity) / 2, 1.82, size, cityCol, { italic: true, weight: '800' });
  p.text('Glider', start + dir * (wCity + wGl / 2), 1.82, size, gliderCol, { italic: true, weight: '800' });
}

function sideGliderBlue(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv } = sc;
  gliderWaves(sc, C.gliderDeep, C.gliderSky, C.gliderSilver);
  p.fill(0, 0.32, 0.62, B.yTop - 0.09, C.gliderSky);
  p.fill(0.2, Lb - 0.4, B.winTop + 0.05, B.yTop - 0.11, C.gliderDeep);
  sideCommon(sc, 'std', paintDoors);
  gliderLettering(sc, '#ffffff', '#7fd0ff');
  possum(p, 7.9, 1.75, 0.95, -0.9, 'rgba(255,255,255,0.1)', 'rgba(240,244,250,0.85)', 0.03);
  p.text('brisbane. australia’s new world city', 3.6, 2.79, 0.075, '#ffffff', { weight: '700' });
  p.text(lv.fleet, 0.95, 2.79, 0.11, '#ffffff', { weight: '800' });
  translinkLogo(p, Lb - 1.6, 2.79, 0.08, '#ffffff', C.gliderSky);
  if (sc.side === 'L') wheelchair(p, 1.72, 0.98, 0.14);
}

function sideGliderMaroon(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv } = sc;
  p.fill(0, Lb, B.y0, B.yTop, p.vgrad(B.y0, B.yTop, [[0, '#5d0f22'], [0.45, '#8c2242'], [1, '#6a1427']]));
  // white wave sweeping up toward the rear, edged with a violet line
  const upper: Pt[] = [[1.0, 0.3], [3.0, 0.42], [6.0, 0.62], [8.6, 0.95], [Lb - 1.2, 1.16], [Lb + 0.1, 1.2]];
  const lower: Pt[] = [[1.0, 0.3], [4.5, 0.3], [8.0, 0.36], [Lb - 1.0, 0.55], [Lb + 0.1, 0.62]];
  p.band(upper.map(([s, h]) => [s, h + 0.04] as Pt), upper, '#4a3f9e');
  p.band(upper, lower, '#f5f5f7');
  p.band(
    [[Lb - 2.4, 1.15], [Lb - 0.9, 1.7], [Lb - 0.4, B.yTop - 0.1]],
    [[Lb - 1.3, 1.15], [Lb - 0.25, 1.6], [Lb + 0.05, B.yTop - 0.1]],
    '#f5f5f7',
  );
  p.fill(0.2, Lb - 0.4, B.winTop + 0.05, B.yTop - 0.11, C.maroonDark);
  sideCommon(sc, 'std', paintDoors);
  gliderLettering(sc, '#ffffff', '#f2dfe6');
  possum(p, 7.9, 1.75, 0.95, -0.9, 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.9)', 0.03);
  p.text('brisbane. australia’s new world city', 3.6, 2.79, 0.075, '#ffffff', { weight: '700' });
  p.text(lv.fleet, 0.95, 2.79, 0.11, '#ffffff', { weight: '800' });
  translinkLogo(p, Lb - 1.6, 2.79, 0.08, '#ffffff', C.btBlue);
  if (sc.side === 'L') wheelchair(p, 1.72, 0.98, 0.14);
}

function sideCityLoop(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv } = sc;
  p.fill(0, Lb, B.y0, B.yTop, p.vgrad(B.y0, B.yTop, [[0, '#4a33b3'], [0.5, C.loopPurple], [1, '#4f37bb']]));
  const w1: Pt[] = [[-0.1, 0.55], [2.5, 0.75], [5.5, 0.5], [8.5, 0.85], [Lb + 0.1, 0.6]];
  p.band(w1.map(([s, h]) => [s, h + 0.22] as Pt), w1, C.loopLavender);
  p.band(w1.map(([s, h]) => [s, h + 0.3] as Pt), w1.map(([s, h]) => [s, h + 0.25] as Pt), '#c9c0f6');
  p.fill(0, Lb, B.y0, 0.4, '#2a50cf');
  sideCommon(sc, 'std', paintDoors);
  p.text('CityLoop', 6.0, 0.86, 0.26, '#ffffff', { italic: true, weight: '800' });
  p.text('FREE', 9.4, 0.86, 0.2, '#f6c400', { weight: '900' });
  p.text(lv.fleet, 0.95, 2.79, 0.11, '#ffffff', { weight: '800' });
  translinkLogo(p, Lb - 1.8, 2.79, 0.08, '#ffffff', C.btBlue);
  if (sc.side === 'L') wheelchair(p, 1.72, 0.98, 0.14);
}

function sideContract(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv } = sc;
  p.fill(0, Lb, B.y0, B.yTop, C.contractBlue);
  p.fill(0, Lb, B.winTop + 0.04, B.yTop, '#f1f3f5');
  p.fill(0, 0.55, B.y0, B.yTop - 0.1, C.contractGreen);
  p.fill(Lb - 0.5, Lb, B.y0, B.yTop - 0.1, C.contractGreen);
  const w: Pt[] = [[0.4, 0.7], [3, 0.95], [6, 0.6], [9, 0.95], [Lb - 0.4, 0.75]];
  p.band(w.map(([s, h]) => [s, h + 0.12] as Pt), w, C.contractGreen);
  p.band(w.map(([s, h]) => [s, h - 0.06] as Pt), w.map(([s, h]) => [s, h - 0.13] as Pt), '#59c3f0');
  sideCommon(sc, 'std', paintDoors);
  p.text(lv.fleet, 1.0, 2.78, 0.1, '#1b1e22', { weight: '800' });
  translinkLogo(p, Lb - 2.2, 0.98, 0.11, '#ffffff', C.contractGreen);
  if (sc.side === 'L') wheelchair(p, 1.72, 0.98, 0.14);
}

function sideMetro(sc: SideCtx, paintDoors: boolean): void {
  const { p, B, Lb, lv, sec } = sc;
  p.fill(0, Lb, B.y0, B.yTop, C.metroBody);
  p.fill(0, Lb, B.y0, 0.6, '#f1f2f4');
  p.fill(0, Lb, 0.6, 0.72, C.metroBlue);
  p.fill(0, Lb, B.yTop - 0.16, B.yTop, '#f1f2f4');
  p.fill(0, Lb, B.yTop - 0.21, B.yTop - 0.165, C.metroGold);
  sideCommon(sc, 'dark', paintDoors, '#05070a');
  // gold dotted wave, continuous across the sections
  const c = p.ctx;
  c.fillStyle = C.metroGold;
  const lam = 2.7;
  for (let s = 0.15; s < Lb - 0.1; s += 0.07) {
    const h = 1.78 + 0.42 * Math.sin(((s + sc.offset) / lam) * Math.PI * 2);
    p.local(s, h, (cc) => {
      cc.beginPath();
      cc.arc(0, 0, 0.021, 0, Math.PI * 2);
      cc.fill();
    });
  }
  void c;
  p.text(lv.fleet, 0.55, 2.83, 0.085, '#ffffff', { weight: '700' });
  if (sec.index === 0) {
    translinkLogo(p, 1.9, 2.83, 0.07, '#ffffff', '#1f50d6', true);
    p.text('Dedicated to a better Brisbane', 4.0, 2.83, 0.05, '#c9d2e4', { weight: '600', italic: true });
    p.local(5.4, 2.83, (cc) => {
      cc.fillStyle = '#1f50d6';
      cc.fillRect(-0.06, -0.06, 0.12, 0.12);
      cc.fillStyle = '#f0b20a';
      cc.fillRect(-0.035, -0.035, 0.07, 0.07);
    });
    // "Brisbane Metro" board and turn-up-and-go
    p.rrect(3.62, 5.32, 1.96, 2.22, 0.02, '#1f50d6');
    p.text('Brisbane Metro', 4.47, 2.09, 0.15, '#ffffff', { weight: '700', maxW: 1.6 });
    p.text('Turn-up-and-', 4.3, 1.82, 0.1, '#ffffff', { weight: '700', italic: true });
    p.rrect(4.96, 5.12, 1.74, 1.9, 0.02, C.metroGold);
    p.text('go', 5.04, 1.82, 0.09, '#10131a', { weight: '900' });
  } else {
    translinkLogo(p, 2.3, 2.83, 0.07, '#ffffff', '#1f50d6', true);
    p.text('translink.com.au  13 12 30', 4.6, 2.83, 0.05, '#c9d2e4', { weight: '600' });
  }
  for (const w of sc.wins.slice(0, 3)) emergencySticker(p, sc.S(w.z0) + 0.15, w.y1 - 0.07);
  if (sc.side === 'L' && sec.index === 0) wheelchair(p, 1.9, 0.98, 0.13);
}

// ---------------------------------------------------------------------------
// Ends per livery

function frontFor(p: RP, B: BodyLayout, lv: Livery, lamps: LampDef[]): void {
  const W = B.hw * 2;
  switch (lv.id) {
    case 'translink':
      optimusFront(p, B, { panel: C.btYellow, pillar: C.btYellow, bumper: C.btBlue, header: C.white, bandText: '#b8bcc2' }, lv, lamps);
      translinkLogo(p, W / 2 + 0.08, 0.86, 0.1, C.navy, C.btBlue);
      p.text('VOLVO', W / 2 - 0.62, 0.86, 0.05, '#3a3f47', { weight: '700' });
      wheelchair(p, W - 0.42, 0.9, 0.11);
      break;
    case 'glider-blue':
      optimusFront(p, B, { panel: C.gliderSky, pillar: C.gliderSky, bumper: C.gliderDeep, header: C.gliderDeep, bandText: '#9aa3ad' }, lv, lamps);
      possum(p, W / 2, 0.86, 0.19, -Math.PI / 2, '#dfe6ee', '#4a5a70', 0.012);
      translinkLogo(p, 0.62, 0.5, 0.075, '#ffffff', C.gliderSky);
      wheelchair(p, W - 0.42, 0.9, 0.11);
      break;
    case 'glider-maroon': {
      optimusFront(p, B, { panel: C.maroon, pillar: C.maroon, bumper: C.btBlue, header: C.maroonDark, bandText: '#c2a3ad' }, lv, lamps);
      const c = p.ctx;
      const g = c.createRadialGradient(p.X(W / 2), p.Y(0.85), 0, p.X(W / 2), p.Y(0.85), 0.8 * p.sx);
      g.addColorStop(0, 'rgba(214,92,140,0.9)');
      g.addColorStop(1, 'rgba(214,92,140,0)');
      p.fill(0.5, W - 0.5, 0.72, 0.99, g);
      p.ctx.strokeStyle = '#f4f4f4';
      p.ctx.lineWidth = 0.018 * p.sy;
      p.spline([[0.58, 0.78], [1.0, 0.75], [W / 2, 0.76]]);
      p.ctx.stroke();
      p.spline([[W - 0.58, 0.78], [W - 1.0, 0.75], [W / 2, 0.76]]);
      p.ctx.stroke();
      possum(p, W / 2, 0.88, 0.17, -Math.PI / 2, '#f4f0f2', '#4a0c1c', 0.012);
      translinkLogo(p, 0.62, 0.5, 0.075, '#ffffff', C.btBlue);
      wheelchair(p, W - 0.42, 0.9, 0.11);
      break;
    }
    case 'cityloop':
      optimusFront(p, B, { panel: C.loopPurple, pillar: '#4d34b8', bumper: '#2a50cf', header: '#111318', bandText: '#a8a0d8' }, lv, lamps);
      for (const flip of [false, true]) {
        const A = (a: number) => (flip ? W - a : a);
        p.band([[A(0.06), 0.93], [A(0.62), 0.92]], [[A(0.06), 0.72], [A(0.62), 0.73]], '#f6c400');
      }
      paintLamps(p, lamps, 'front');
      p.text('CityLoop', W / 2, 3.02 - 0.12, 0.06, '#ffffff', { italic: true, weight: '800' });
      p.local(W / 2, 0.84, (c) => {
        c.fillStyle = '#d9b44a';
        c.beginPath();
        c.ellipse(0, 0, 0.07, 0.05, 0, 0, Math.PI * 2);
        c.fill();
      });
      p.text(lv.fleet, W - 0.6, 0.84, 0.1, '#ffffff', { weight: '800' });
      break;
    case 'contract':
      optimusFront(p, B, { panel: C.contractGreen, pillar: C.contractGreen, bumper: C.contractBlue, header: '#f1f3f5', bandText: '#a9afb6' }, lv, lamps);
      translinkLogo(p, W / 2, 0.86, 0.1, '#ffffff', C.contractBlue);
      break;
    case 'metro':
      metroFront(p, B, lv, lamps);
      break;
  }
}

function metroFront(p: RP, B: BodyLayout, lv: Livery, lamps: LampDef[]): void {
  const W = B.hw * 2;
  p.fill(0, W, B.y0, B.yTop, '#f1f2f4');
  // blue frame around the big windscreen
  p.rrect(0, W, 0.7, B.yTop, 0.16, C.metroBlue);
  p.fill(0, W, B.yTop - 0.06, B.yTop, '#f1f2f4');
  p.rrect(0.19, W - 0.19, 0.94, B.yTop - 0.11, 0.12, '#05070a');
  glass(p, 0.21, W - 0.21, 0.96, B.yTop - 0.13, 'dark', 0.11);
  p.ctx.save();
  p.ctx.globalAlpha = 0.5;
  p.rrect(0.24, W - 0.24, 0.96, 1.35, 0.05, '#030405');
  p.ctx.restore();
  p.rrect(0.32, W - 0.32, 2.38, 2.74, 0.03, '#030405'); // sign box
  // white lower nose and blue centre panel
  p.ctx.beginPath();
  p.spline([[0, 0.98], [0.5, 0.9], [W / 2, 0.88], [W - 0.5, 0.9], [W, 0.98]]);
  p.line([[W, B.y0], [0, B.y0]]);
  p.ctx.closePath();
  p.ctx.fillStyle = '#f1f2f4';
  p.ctx.fill();
  p.rrect(0.62, W - 0.62, 0.36, 0.9, 0.08, C.metroBlue);
  translinkLogo(p, W / 2 - 0.15, 0.77, 0.075, '#ffffff', C.metroBlue, true);
  p.text(lv.fleet, W / 2 + 0.42, 0.77, 0.11, '#ffffff', { weight: '800' });
  p.text('Dedicated to a better Brisbane', W / 2, 0.6, 0.032, '#dfe6f5', { weight: '600', italic: true });
  p.fill(0, W, B.y0, 0.34, '#2b2e33');
  // headlamp pods
  for (const a of [0.34, W - 0.34]) p.rrect(a - 0.26, a + 0.26, 0.5, 0.82, 0.12, '#dfe2e6');
  paintLamps(p, lamps, 'front');
  p.text('HESS', W / 2 + 0.55, 1.02, 0.035, '#b8bec6', { weight: '800' });
  wheelchair(p, W - 0.55, 1.08, 0.09);
  plate(p, W / 2, 0.47, lv.plate);
}

function rearFor(p: RP, B: BodyLayout, lv: Livery, lamps: LampDef[]): void {
  const W = B.hw * 2;
  switch (lv.id) {
    case 'translink':
      optimusRear(p, B, C.white, C.btBlue, C.btBlue, lv, lamps);
      translinkLogo(p, W / 2, 1.05, 0.1, C.navy, C.btBlue);
      break;
    case 'glider-blue':
      optimusRear(p, B, C.gliderDeep, C.gliderDeep, C.gliderSky, lv, lamps);
      p.text('CityGlider', W / 2, 1.05, 0.13, '#ffffff', { italic: true, weight: '800' });
      break;
    case 'glider-maroon':
      optimusRear(p, B, C.maroon, C.btBlue, '#f5f5f7', lv, lamps);
      p.text('CityGlider', W / 2, 1.05, 0.13, '#ffffff', { italic: true, weight: '800' });
      break;
    case 'cityloop':
      optimusRear(p, B, C.loopPurple, '#2a50cf', C.loopLavender, lv, lamps);
      p.text('CityLoop', W / 2, 1.05, 0.13, '#ffffff', { italic: true, weight: '800' });
      break;
    case 'contract':
      optimusRear(p, B, C.contractBlue, C.contractBlue, C.contractGreen, lv, lamps);
      translinkLogo(p, W / 2, 1.05, 0.1, '#ffffff', C.contractGreen);
      break;
    case 'metro': {
      p.fill(0, W, B.y0, B.yTop, C.metroBody);
      p.fill(0, W, B.y0, 0.6, '#f1f2f4');
      p.fill(0, W, 0.6, 0.72, C.metroBlue);
      p.fill(0, W, B.yTop - 0.16, B.yTop, '#f1f2f4');
      p.fill(0, W, B.yTop - 0.21, B.yTop - 0.165, C.metroGold);
      p.rrect(0.26, W - 0.26, 1.0, 2.82, 0.1, '#05070a');
      glass(p, 0.29, W - 0.29, 1.03, 2.79, 'dark', 0.08);
      p.rrect(W / 2 - 0.34, W / 2 + 0.34, 2.5, 2.78, 0.02, '#030405');
      for (const a of [0.16, W - 0.16]) p.rrect(a - 0.11, a + 0.11, 0.74, 1.53, 0.04, '#15171b');
      paintLamps(p, lamps, 'rear');
      plate(p, W / 2, 0.45, lv.plate);
      translinkLogo(p, W / 2, 0.86, 0.07, '#ffffff', C.metroBlue, true);
      break;
    }
  }
}

// ---------------------------------------------------------------------------

export interface PaintOptions {
  /** Cut door apertures (high detail with animated leaves). */
  cutDoors: boolean;
  /** Resolution multiplier (1 = 2048 px wide atlas). */
  scale: number;
  /** Sum of the spans of the sections in front (continuous patterns). */
  offset: number;
}

export interface PaintResult {
  color: HTMLCanvasElement;
  emissive: HTMLCanvasElement;
  rough: HTMLCanvasElement;
}

export function paintSection(B: BodyLayout, sec: SectionLayout, atlas: AtlasLayout, lv: Livery, opts: PaintOptions): PaintResult {
  const { canvas, ctx } = makeCanvas(atlas.cw, atlas.ch);
  const Lb = sec.bodyRear - sec.bodyFront;
  const W = B.hw * 2;
  const lamps = lampsFor(B, sec);
  const S = (z: number) => z - sec.bodyFront;
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, atlas.cw, atlas.ch);

  for (const side of ['L', 'R'] as const) {
    const rect = side === 'L' ? atlas.left : atlas.right;
    const p = new RP(ctx, rect, Lb, B.y0, B.yTop, side === 'R');
    const sc: SideCtx = { p, B, sec, lv, side, Lb, lamps, S, wins: side === 'L' ? sec.windowsL : sec.windowsR, offset: opts.offset };
    p.clip();
    const paintDoors = !opts.cutDoors;
    switch (lv.id) {
      case 'translink': sideTranslink(sc, paintDoors); break;
      case 'glider-blue': sideGliderBlue(sc, paintDoors); break;
      case 'glider-maroon': sideGliderMaroon(sc, paintDoors); break;
      case 'cityloop': sideCityLoop(sc, paintDoors); break;
      case 'contract': sideContract(sc, paintDoors); break;
      case 'metro': sideMetro(sc, paintDoors); break;
    }
    // roof colour on the top rows (shoulder)
    p.fill(0, Lb, B.yTop - 0.03, B.yTop, lv.id === 'metro' ? '#f1f2f4' : lv.id === 'cityloop' ? '#4f37bb' : '#f3f4f1');
    // cut-outs
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    cutArches(p, sec, B);
    if (side === 'L' && opts.cutDoors) cutDoors(p, sec, B);
    ctx.restore();
    p.unclip();
  }
  if (atlas.front) {
    const p = new RP(ctx, atlas.front, W, B.y0, B.yTop, false);
    p.clip();
    frontFor(p, B, lv, lamps);
    p.unclip();
  }
  if (atlas.rear) {
    const p = new RP(ctx, atlas.rear, W, B.y0, B.yTop, false);
    p.clip();
    rearFor(p, B, lv, lamps);
    p.unclip();
  }
  // roof texel row
  ctx.fillStyle = lv.id === 'cityloop' ? '#4f37bb' : '#f3f4f1';
  ctx.fillRect(atlas.left.x, atlas.left.y, atlas.left.w, 3);

  return { color: canvas, ...paintMaps(B, sec, atlas, lv) };
}

/** Emissive (lit saloon windows) and roughness maps at quarter resolution. */
function paintMaps(B: BodyLayout, sec: SectionLayout, atlas: AtlasLayout, lv: Livery): { emissive: HTMLCanvasElement; rough: HTMLCanvasElement } {
  const k = 0.25;
  const q = (r: Rect): Rect => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
  const cw = Math.round(atlas.cw * k), ch = Math.round(atlas.ch * k);
  const em = makeCanvas(cw, ch);
  const ro = makeCanvas(cw, ch);
  em.ctx.fillStyle = '#000';
  em.ctx.fillRect(0, 0, cw, ch);
  ro.ctx.fillStyle = 'rgb(0,110,0)';
  ro.ctx.fillRect(0, 0, cw, ch);
  const Lb = sec.bodyRear - sec.bodyFront;
  const W = B.hw * 2;
  const S = (z: number) => z - sec.bodyFront;
  for (const side of ['L', 'R'] as const) {
    const rect = q(side === 'L' ? atlas.left : atlas.right);
    const pe = new RP(em.ctx, rect, Lb, B.y0, B.yTop, side === 'R');
    const pr = new RP(ro.ctx, rect, Lb, B.y0, B.yTop, side === 'R');
    const wins = side === 'L' ? sec.windowsL : sec.windowsR;
    for (const w of wins) {
      pe.fill(S(w.z0), S(w.z1), w.y0, w.y1, pe.vgrad(w.y0, w.y1, [[0, '#f4f6f8'], [0.35, '#c9ccd0'], [1, '#55595e']]));
      // yellow poles catching the light
      for (let s = S(w.z0) + 0.5; s < S(w.z1) - 0.2; s += 1.5) pe.fill(s - 0.02, s + 0.02, w.y0, w.y1, 'rgba(200,160,20,0.9)');
      // seat backs and heads silhouettes
      for (let s = S(w.z0) + 0.25; s < S(w.z1) - 0.1; s += 0.78) pe.fill(s - 0.2, s + 0.2, w.y0, w.y0 + 0.28, 'rgba(40,40,60,0.7)');
      pr.fill(S(w.z0), S(w.z1), w.y0, w.y1, 'rgb(0,18,0)');
    }
    if (side === 'L')
      for (const d of sec.doors) {
        pe.fill(S(d.z0), S(d.z1), B.y0 + 0.15, B.doorTop - 0.05, pe.vgrad(B.y0, B.doorTop, [[0, '#e8eaee'], [1, '#55595e']]));
        pr.fill(S(d.z0), S(d.z1), B.y0, B.doorTop, 'rgb(0,18,0)');
      }
    pr.fill(0, Lb, B.y0, 0.345, 'rgb(0,170,0)');
  }
  if (atlas.front) {
    const pe = new RP(em.ctx, q(atlas.front), W, B.y0, B.yTop, false);
    const pr = new RP(ro.ctx, q(atlas.front), W, B.y0, B.yTop, false);
    const metro = lv.id === 'metro';
    const g0 = metro ? 0.96 : 1.11, g1 = metro ? B.yTop - 0.13 : 2.73;
    pe.fill(0.2, W - 0.2, g0 + 0.55, g1 - 0.35, 'rgba(70,72,78,0.5)');
    pr.fill(0.13, W - 0.13, g0, g1, 'rgb(0,12,0)');
  }
  if (atlas.rear) {
    const pe = new RP(em.ctx, q(atlas.rear), W, B.y0, B.yTop, false);
    const pr = new RP(ro.ctx, q(atlas.rear), W, B.y0, B.yTop, false);
    const metro = lv.id === 'metro';
    pe.fill(0.3, W - 0.3, metro ? 1.3 : 2.05, 2.5, 'rgba(90,92,98,0.5)');
    pr.fill(0.24, W - 0.24, metro ? 1.03 : 1.92, 2.8, 'rgb(0,18,0)');
  }
  return { emissive: em.canvas, rough: ro.canvas };
}

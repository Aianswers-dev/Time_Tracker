// Small shared helpers for the gameplay/UI subsystem.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable small hash of a string. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [228, 99, 164];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Relative luminance 0..1 (sRGB, approximate). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mix a colour towards white until it is at least `minLum` bright. */
export function brighten(hex: string, minLum = 0.3): string {
  let [r, g, b] = hexToRgb(hex);
  for (let i = 0; i < 10 && luminance(rgbToHex(r, g, b)) < minLum; i++) {
    r += (255 - r) * 0.18;
    g += (255 - g) * 0.18;
    b += (255 - b) * 0.18;
  }
  return rgbToHex(r, g, b);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** "120 m", "1.4 km". */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 995) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

/** Signed minutes:seconds, e.g. "+1:05" or "−0:40". */
export function fmtDelta(sec: number): string {
  const a = Math.abs(Math.round(sec));
  const m = Math.floor(a / 60);
  const s = a % 60;
  const sign = sec >= 0.5 ? '+' : sec <= -0.5 ? '−' : '';
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

/** "12:34" style elapsed time, or "1:02:03" past an hour. */
export function fmtDuration(sec: number): string {
  const a = Math.max(0, Math.round(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Local clock "10:24" from fractional hours. */
export function fmtClock(hours: number): string {
  const h = ((hours % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Create an element with class names and optional children / text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Text setter that only touches the DOM on change. */
export class TextSlot {
  private last = '\u0000';
  constructor(readonly node: HTMLElement) {}
  set(v: string): void {
    if (v !== this.last) {
      this.last = v;
      this.node.textContent = v;
    }
  }
}

/** Class toggler that only touches the DOM on change. */
export class FlagSlot {
  private last: boolean | null = null;
  constructor(
    readonly node: HTMLElement,
    readonly cls: string,
  ) {}
  set(v: boolean): void {
    if (v !== this.last) {
      this.last = v;
      this.node.classList.toggle(this.cls, v);
    }
  }
}

export function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

/** Label colours used on top of a category colour. */
export const LIGHT_LABEL = '#ffffff';
export const DARK_LABEL = '#0b0d12';

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(parseInt(h ?? '0', 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2 contrast ratio between two #RRGGBB colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const cache = new Map<string, string>();

/** White or near-black, whichever contrasts more with `background`. */
export function labelColorFor(background: string): string {
  const hit = cache.get(background);
  if (hit) return hit;
  const pick =
    contrastRatio(background, LIGHT_LABEL) >= contrastRatio(background, DARK_LABEL)
      ? LIGHT_LABEL
      : DARK_LABEL;
  cache.set(background, pick);
  return pick;
}

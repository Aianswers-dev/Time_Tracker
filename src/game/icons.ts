// Inline SVG icons (no external assets).

export const ICON_SEARCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/** App mark: a rounded square with a stylised bus front and a swoosh. */
export const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true">
<defs><linearGradient id="bbsg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00b8c9"/><stop offset="1" stop-color="#0a7fa8"/></linearGradient></defs>
<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bbsg)"/>
<path d="M10 44 C 24 30, 40 52, 56 30" fill="none" stroke="#e463a4" stroke-width="5" stroke-linecap="round"/>
<rect x="19" y="13" width="26" height="30" rx="5" fill="#fff"/>
<rect x="22" y="17" width="20" height="11" rx="2" fill="#0b1f3a"/>
<rect x="22" y="31" width="20" height="3" rx="1.5" fill="#0b1f3a" opacity=".25"/>
<circle cx="24.5" cy="38" r="2" fill="#f7c948"/><circle cx="39.5" cy="38" r="2" fill="#f7c948"/>
</svg>`;

export const BUS_ICONS: Record<'rigid' | 'glider' | 'metro', string> = {
  rigid: `<svg viewBox="0 0 120 40" aria-hidden="true"><rect x="4" y="6" width="104" height="26" rx="5" fill="currentColor"/><rect x="10" y="10" width="78" height="10" rx="2" fill="#0b1f3a" opacity=".55"/><rect x="92" y="10" width="12" height="14" rx="2" fill="#0b1f3a" opacity=".55"/><circle cx="26" cy="33" r="5" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/><circle cx="88" cy="33" r="5" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/></svg>`,
  glider: `<svg viewBox="0 0 120 40" aria-hidden="true"><path d="M4 12 Q4 6 10 6 H100 Q110 6 112 16 L112 32 H4 Z" fill="currentColor"/><rect x="10" y="10" width="86" height="10" rx="2" fill="#0b1f3a" opacity=".55"/><path d="M4 26 H112" stroke="#0b1f3a" stroke-width="2" opacity=".35"/><circle cx="26" cy="33" r="5" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/><circle cx="90" cy="33" r="5" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/></svg>`,
  metro: `<svg viewBox="0 0 120 40" aria-hidden="true"><rect x="2" y="8" width="40" height="24" rx="4" fill="currentColor"/><rect x="44" y="8" width="32" height="24" rx="2" fill="currentColor"/><rect x="78" y="8" width="40" height="24" rx="6" fill="currentColor"/><rect x="6" y="12" width="32" height="8" rx="2" fill="#0b1f3a" opacity=".55"/><rect x="47" y="12" width="26" height="8" rx="2" fill="#0b1f3a" opacity=".55"/><rect x="81" y="12" width="32" height="8" rx="2" fill="#0b1f3a" opacity=".55"/><circle cx="14" cy="33" r="4" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/><circle cx="60" cy="33" r="4" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/><circle cx="104" cy="33" r="4" fill="#0b1f3a" stroke="currentColor" stroke-width="2"/></svg>`,
};

export const TIME_ICONS = {
  dawn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 18a5 5 0 0 1 10 0" fill="currentColor"/><path d="M12 5v3M5.6 9.6l2 2M18.4 9.6l-2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  day: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>`,
  dusk: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18M6 21h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 18a5 5 0 0 1 10 0" fill="currentColor"/><path d="M12 9V5m0 4-2-2m2 2 2-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`,
  night: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" fill="currentColor"/><circle cx="17" cy="5" r="1" fill="currentColor"/><circle cx="20.5" cy="9" r=".8" fill="currentColor"/></svg>`,
};

/** Turn arrows, drawn pointing up = straight; rotated per kind in CSS. */
export function turnArrow(kind: string): string {
  const paths: Record<string, string> = {
    left: 'M15 21V12a3 3 0 0 0-3-3H6m3-4-4 4 4 4',
    right: 'M9 21V12a3 3 0 0 1 3-3h6m-3-4 4 4-4 4',
    'slight-left': 'M14 21v-6.5c0-1.2-.5-2.3-1.3-3.2L7.5 6m-.5 5V5.5h5.5',
    'slight-right': 'M10 21v-6.5c0-1.2.5-2.3 1.3-3.2L16.5 6m.5 5V5.5h-5.5',
    'sharp-left': 'M15 3v10a3 3 0 0 1-3 3H8m2.5-4.5L6 16l4.5 4.5',
    'sharp-right': 'M9 3v10a3 3 0 0 0 3 3h4m-2.5-4.5L18 16l-4.5 4.5',
    uturn: 'M16 21V9a4 4 0 0 0-8 0v6m-3.5-3.5L8 15l3.5-3.5',
    straight: 'M12 21V4m-5 5 5-5 5 5',
    finish: 'M6 21V4m0 1h11l-2.5 4L17 13H6',
  };
  const d = paths[kind] ?? paths.straight;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export const ICON_INDICATOR_L = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4 2 12l8 8v-5h12V9H10Z" fill="currentColor"/></svg>`;
export const ICON_INDICATOR_R = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4l8 8-8 8v-5H2V9h12Z" fill="currentColor"/></svg>`;
export const ICON_HEADLIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5C6 5 3 8 3 12s3 7 8 7c2 0 3-3 3-7s-1-7-3-7Z" fill="currentColor"/><path d="M16 7h6M16 12h6M16 17h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const ICON_DOORS = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v18M8 10l-2 2 2 2M16 10l2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_PARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 17V7h3.2a3 3 0 0 1 0 6H9.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
export const ICON_HAZARD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 9.5 7.5 17h9Z" fill="currentColor"/></svg>`;
export const ICON_CLOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const ICON_MAP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
export const ICON_RIBBON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 18 6-5 6 5M6 12l6-5 6 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_PAX = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3.3" fill="currentColor"/><path d="M2.5 20.5v-1.2c0-3.4 2.9-6.1 6.5-6.1s6.5 2.7 6.5 6.1v1.2Z" fill="currentColor"/><circle cx="17.2" cy="8.2" r="2.6" fill="currentColor" opacity=".55"/><path d="M16 13.4c3.2.2 5.5 2.6 5.5 5.6v1.5h-4.3v-1.2c0-2.3-.9-4.4-2.4-5.8.4-.1.8-.1 1.2-.1Z" fill="currentColor" opacity=".55"/></svg>`;
/** Passenger leaving through a door (the door is on the right). */
export const ICON_ALIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v16h-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 12H3m3.5-3.5L3 12l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_BOARD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v16h-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12h9m-3.5-3.5L12 12l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

import { CATEGORY_ICONS, CATEGORY_PALETTE, SEED_CATEGORIES } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { CATEGORY_ICON_MAP, CATEGORY_ICON_NAMES, FALLBACK_ICON, iconFor } from './icons';
import { contrastRatio, labelColorFor } from './lib/contrast';

describe('category icons', () => {
  it('map every name in the shared CATEGORY_ICONS list to a lucide component', () => {
    for (const name of CATEGORY_ICONS) {
      expect(CATEGORY_ICON_MAP[name], name).toBeDefined();
      expect(iconFor(name), name).not.toBe(FALLBACK_ICON);
    }
    expect([...CATEGORY_ICON_NAMES]).toEqual([...CATEGORY_ICONS]);
  });

  it('cover every seeded category icon', () => {
    for (const c of SEED_CATEGORIES) expect(iconFor(c.icon), c.name).not.toBe(FALLBACK_ICON);
  });

  it('fall back for unknown names', () => {
    expect(iconFor('no-such-icon')).toBe(FALLBACK_ICON);
  });

  it('fall back for names of inherited object properties', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(iconFor(name), name).toBe(FALLBACK_ICON);
    }
  });
});

describe('label colour', () => {
  it('reaches 4.5:1 on every palette colour', () => {
    for (const hex of CATEGORY_PALETTE) {
      const label = labelColorFor(hex);
      expect(contrastRatio(hex, label), `${label} on ${hex}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks the more contrasting of white and near-black', () => {
    expect(labelColorFor('#000000')).toBe('#ffffff');
    expect(labelColorFor('#ffffff')).toBe('#0b0d12');
  });
});

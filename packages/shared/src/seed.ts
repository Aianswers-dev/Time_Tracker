import { SETTINGS_ID, type Category, type Rule, type Settings } from './entities';

/**
 * First-run data from docs/01-decisions.md (P5, P6).
 *
 * Seed rows have fixed ids and an old timestamp. A reinstalled app seeds the
 * same ids, and any copy the server already holds is newer, so the server's
 * version (with the owner's renames and tweaks) wins without duplicates.
 */
export const SEED_TIMESTAMP = '2000-01-01T00:00:00.000Z';

/** Fixed UUIDv7-shaped ids for the seeded categories, in display order. */
export const SEED_CATEGORY_IDS = {
  sleep: '00000000-0000-7000-8000-000000000001',
  relaxing: '00000000-0000-7000-8000-000000000002',
  housework: '00000000-0000-7000-8000-000000000003',
  casualWork: '00000000-0000-7000-8000-000000000004',
  contractWork: '00000000-0000-7000-8000-000000000005',
  uniStudy: '00000000-0000-7000-8000-000000000006',
  lifeAdmin: '00000000-0000-7000-8000-000000000007',
  travel: '00000000-0000-7000-8000-000000000008',
  socialising: '00000000-0000-7000-8000-000000000009',
  hobbies: '00000000-0000-7000-8000-00000000000a',
} as const;

export const SEED_RULE_IDS = {
  relaxingSession: '00000000-0000-7000-8000-000000000101',
  relaxingDaily: '00000000-0000-7000-8000-000000000102',
} as const;

/**
 * Category colours, validated with the dataviz palette method. One hex per
 * colour works in light and dark mode: each is at least 3:1 against both page
 * backgrounds and both surfaces, and reaches at least 4.5:1 with either white
 * or near-black label text (whichever the app picks by contrast). The first ten
 * belong to the seeded categories in order; the rest are for new categories.
 * Do not lighten Sleep, Housework or Travel: they sit at the 3:1 limit on the
 * light background.
 */
export const CATEGORY_PALETTE: readonly string[] = [
  '#8b7dff', // Sleep: periwinkle indigo
  '#d2230d', // Relaxing: vermilion
  '#cc7c10', // Housework: deep amber
  '#019476', // Casual work: teal
  '#185fe2', // Contract work: royal blue
  '#983cb2', // Uni study: purple
  '#5b6677', // Life admin: slate
  '#129ac7', // Travel / commute: cyan
  '#ea4faa', // Socialising: pink
  '#0e7605', // Hobbies: forest green
  '#c21470', // raspberry
  '#89954a', // sage olive
  '#ae75ab', // mauve
  '#0aa405', // bright green
  '#955907', // brown
  '#f85056', // coral
];

/**
 * Icon names (lucide, kebab-case) offered in the category editor, seed icons
 * first. Every name exists in lucide-react 1.x. The web app maps each name to a
 * component and has a test that the map covers this list.
 */
export const CATEGORY_ICONS: readonly string[] = [
  'moon',
  'sofa',
  'cooking-pot',
  'concierge-bell',
  'laptop',
  'graduation-cap',
  'clipboard-list',
  'car',
  'users',
  'palette',
  'dumbbell',
  'bike',
  'footprints',
  'waves',
  'trophy',
  'heart-pulse',
  'stethoscope',
  'pill',
  'brain',
  'music',
  'headphones',
  'guitar',
  'book-open',
  'gamepad-2',
  'tv',
  'shopping-cart',
  'shopping-bag',
  'wallet',
  'phone',
  'mail',
  'message-circle',
  'baby',
  'dog',
  'cat',
  'paw-print',
  'church',
  'hand-heart',
  'utensils',
  'coffee',
  'chef-hat',
  'shirt',
  'brush-cleaning',
  'bed',
  'wrench',
  'sprout',
  'bus',
  'train-front',
  'plane',
  'camera',
  'paintbrush',
  'code',
  'briefcase',
  'notebook-pen',
  'party-popper',
];

interface SeedCategory {
  key: keyof typeof SEED_CATEGORY_IDS;
  name: string;
  icon: string;
  exemptFromStaleCheck: boolean;
}

const SEED_CATEGORY_DEFS: readonly SeedCategory[] = [
  { key: 'sleep', name: 'Sleep', icon: 'moon', exemptFromStaleCheck: true },
  { key: 'relaxing', name: 'Relaxing', icon: 'sofa', exemptFromStaleCheck: false },
  { key: 'housework', name: 'Housework', icon: 'cooking-pot', exemptFromStaleCheck: false },
  { key: 'casualWork', name: 'Casual work', icon: 'concierge-bell', exemptFromStaleCheck: false },
  { key: 'contractWork', name: 'Contract work', icon: 'laptop', exemptFromStaleCheck: false },
  { key: 'uniStudy', name: 'Uni study', icon: 'graduation-cap', exemptFromStaleCheck: false },
  { key: 'lifeAdmin', name: 'Life admin', icon: 'clipboard-list', exemptFromStaleCheck: false },
  { key: 'travel', name: 'Travel / commute', icon: 'car', exemptFromStaleCheck: false },
  { key: 'socialising', name: 'Socialising', icon: 'users', exemptFromStaleCheck: false },
  { key: 'hobbies', name: 'Hobbies', icon: 'palette', exemptFromStaleCheck: false },
];

export const SEED_CATEGORIES: readonly Category[] = SEED_CATEGORY_DEFS.map((def, i) => ({
  id: SEED_CATEGORY_IDS[def.key],
  name: def.name,
  color: CATEGORY_PALETTE[i] ?? '#5b6677',
  icon: def.icon,
  sortOrder: i + 1,
  exemptFromStaleCheck: def.exemptFromStaleCheck,
  archivedAt: null,
  createdAt: SEED_TIMESTAMP,
  updatedAt: SEED_TIMESTAMP,
  deletedAt: null,
}));

/** Default nudges from docs/01-decisions.md (P6). The owner tunes them in the app. */
export const SEED_RULES: readonly Rule[] = [
  {
    id: SEED_RULE_IDS.relaxingSession,
    categoryId: SEED_CATEGORY_IDS.relaxing,
    kind: 'session',
    thresholdMin: 60,
    repeatEveryMin: 30,
    quietStart: null,
    quietEnd: null,
    message: null,
    enabled: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
    deletedAt: null,
  },
  {
    id: SEED_RULE_IDS.relaxingDaily,
    categoryId: SEED_CATEGORY_IDS.relaxing,
    kind: 'daily',
    thresholdMin: 180,
    repeatEveryMin: 60,
    quietStart: null,
    quietEnd: null,
    message: null,
    enabled: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
    deletedAt: null,
  },
];

/** Default settings for a device in `timezone`. */
export function defaultSettings(timezone: string): Settings {
  return {
    id: SETTINGS_ID,
    timezone,
    dayStartHour: 4,
    staleEnabled: true,
    staleAfterMin: 300,
    staleRepeatMin: 60,
    staleQuietStart: null,
    staleQuietEnd: null,
    updatedAt: SEED_TIMESTAMP,
  };
}

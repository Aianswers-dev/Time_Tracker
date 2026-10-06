/* eslint-disable react-refresh/only-export-components -- an icon registry module, not a component module */
import {
  Baby,
  Bed,
  Bike,
  BookOpen,
  Briefcase,
  Brush,
  Bus,
  Camera,
  Car,
  Church,
  CircleHelp,
  ClipboardList,
  Code,
  Coffee,
  CookingPot,
  Dog,
  Dumbbell,
  Footprints,
  Gamepad2,
  GraduationCap,
  Heart,
  Laptop,
  Leaf,
  Mail,
  Moon,
  Music,
  Palette,
  PenLine,
  Phone,
  Plane,
  ShoppingCart,
  Smartphone,
  Sofa,
  Sparkles,
  Stethoscope,
  Sun,
  TrainFront,
  Tv,
  Users,
  Utensils,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { createElement } from 'react';

/**
 * Icons a category can use, by lucide kebab-case name. Explicit imports keep
 * the bundle to just these icons. Covers every name in the shared
 * CATEGORY_ICONS list (seeded categories) plus extras for new categories.
 */
export const CATEGORY_ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  // Seeded categories (shared CATEGORY_ICONS)
  moon: Moon,
  sofa: Sofa,
  'cooking-pot': CookingPot,
  coffee: Coffee,
  laptop: Laptop,
  'graduation-cap': GraduationCap,
  'clipboard-list': ClipboardList,
  car: Car,
  users: Users,
  palette: Palette,
  // Extras
  dumbbell: Dumbbell,
  'book-open': BookOpen,
  music: Music,
  'gamepad-2': Gamepad2,
  'shopping-cart': ShoppingCart,
  phone: Phone,
  mail: Mail,
  baby: Baby,
  dog: Dog,
  stethoscope: Stethoscope,
  utensils: Utensils,
  bed: Bed,
  bike: Bike,
  tv: Tv,
  briefcase: Briefcase,
  heart: Heart,
  sparkles: Sparkles,
  church: Church,
  plane: Plane,
  bus: Bus,
  'train-front': TrainFront,
  footprints: Footprints,
  brush: Brush,
  wrench: Wrench,
  code: Code,
  'pen-line': PenLine,
  camera: Camera,
  leaf: Leaf,
  sun: Sun,
  smartphone: Smartphone,
};

export const CATEGORY_ICON_NAMES: readonly string[] = Object.keys(CATEGORY_ICON_MAP);

/** Shown for an icon name this build does not know (for example, set by a newer version). */
export const FALLBACK_ICON: LucideIcon = CircleHelp;

export function iconFor(name: string): LucideIcon {
  return CATEGORY_ICON_MAP[name] ?? FALLBACK_ICON;
}

/**
 * Render a category icon by name. Uses createElement because the component is
 * picked from the static map above at render time.
 */
export function CategoryIcon({ name, ...props }: LucideProps & { name: string }) {
  return createElement(iconFor(name), props);
}

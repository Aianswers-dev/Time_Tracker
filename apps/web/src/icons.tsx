/* eslint-disable react-refresh/only-export-components -- an icon registry module, not a component module */
import {
  Baby,
  Bed,
  Bike,
  BookOpen,
  Brain,
  Briefcase,
  BrushCleaning,
  Bus,
  Camera,
  Car,
  Cat,
  ChefHat,
  Church,
  CircleHelp,
  ClipboardList,
  Code,
  Coffee,
  ConciergeBell,
  CookingPot,
  Dog,
  Dumbbell,
  Footprints,
  Gamepad2,
  GraduationCap,
  Guitar,
  HandHeart,
  Headphones,
  HeartPulse,
  Laptop,
  Mail,
  MessageCircle,
  Moon,
  Music,
  NotebookPen,
  Paintbrush,
  Palette,
  PartyPopper,
  PawPrint,
  Phone,
  Pill,
  Plane,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Sofa,
  Sprout,
  Stethoscope,
  TrainFront,
  Trophy,
  Tv,
  Users,
  Utensils,
  Wallet,
  Waves,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { createElement } from 'react';

/**
 * Icons a category can use, by lucide kebab-case name, in the order of the
 * shared CATEGORY_ICONS list (seeded categories first). Explicit imports keep
 * the bundle to just these icons. icons.test.ts checks the two stay in step.
 */
export const CATEGORY_ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  moon: Moon,
  sofa: Sofa,
  'cooking-pot': CookingPot,
  'concierge-bell': ConciergeBell,
  laptop: Laptop,
  'graduation-cap': GraduationCap,
  'clipboard-list': ClipboardList,
  car: Car,
  users: Users,
  palette: Palette,
  dumbbell: Dumbbell,
  bike: Bike,
  footprints: Footprints,
  waves: Waves,
  trophy: Trophy,
  'heart-pulse': HeartPulse,
  stethoscope: Stethoscope,
  pill: Pill,
  brain: Brain,
  music: Music,
  headphones: Headphones,
  guitar: Guitar,
  'book-open': BookOpen,
  'gamepad-2': Gamepad2,
  tv: Tv,
  'shopping-cart': ShoppingCart,
  'shopping-bag': ShoppingBag,
  wallet: Wallet,
  phone: Phone,
  mail: Mail,
  'message-circle': MessageCircle,
  baby: Baby,
  dog: Dog,
  cat: Cat,
  'paw-print': PawPrint,
  church: Church,
  'hand-heart': HandHeart,
  utensils: Utensils,
  coffee: Coffee,
  'chef-hat': ChefHat,
  shirt: Shirt,
  'brush-cleaning': BrushCleaning,
  bed: Bed,
  wrench: Wrench,
  sprout: Sprout,
  bus: Bus,
  'train-front': TrainFront,
  plane: Plane,
  camera: Camera,
  paintbrush: Paintbrush,
  code: Code,
  briefcase: Briefcase,
  'notebook-pen': NotebookPen,
  'party-popper': PartyPopper,
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

/**
 * True when the app runs as an installed Home Screen web app rather than in a
 * browser tab (docs/06). iOS exposes `navigator.standalone`; everything else
 * uses the display-mode media query.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

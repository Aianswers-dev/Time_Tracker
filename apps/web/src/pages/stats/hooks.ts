import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { indexAt } from './chartUtils';

/** Width of an element in CSS pixels, kept current with a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>(
  fallback = 326,
): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const MOVE_SLOP_PX = 8;

interface ScrubOptions {
  /** Number of slots across the plot. */
  count: number;
  /** A tap (no drag) or Enter on a slot. */
  onTap?: (index: number) => void;
  /** Slot to show when the plot gets keyboard focus with nothing picked. */
  defaultIndex?: number;
}

export interface Scrub {
  active: number | null;
  setActive: (index: number | null) => void;
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
  };
}

/**
 * Inspect-by-pointer for a row of slots (days, hours). A mouse hovers; a finger
 * slides sideways across the plot to inspect (vertical drags still scroll the
 * page, see `.chart-scrub`); a tap without a drag calls `onTap`. Arrow keys
 * move between slots and Enter taps, so the chart is one keyboard stop.
 */
export function useScrub({ count, onTap, defaultIndex }: ScrubOptions): Scrub {
  const [active, setActive] = useState<number | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const indexOf = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return indexAt(e.clientX - rect.left, rect.width, count);
    },
    [count],
  );

  return {
    // A slot index can outlive a range change with fewer slots.
    active: active !== null && active < count ? active : null,
    setActive,
    handlers: {
      onPointerDown(e) {
        press.current = { x: e.clientX, y: e.clientY, moved: false };
        if (e.pointerType !== 'mouse') {
          // Keep receiving moves when the finger slides past the plot's edge.
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Capture is a nicety; inspection still works without it.
          }
        }
        setActive(indexOf(e));
      },
      onPointerMove(e) {
        const p = press.current;
        if (e.pointerType === 'mouse' && !p) {
          setActive(indexOf(e));
          return;
        }
        if (!p) return;
        if (Math.abs(e.clientX - p.x) > MOVE_SLOP_PX) p.moved = true;
        if (p.moved) setActive(indexOf(e));
      },
      onPointerUp(e) {
        const p = press.current;
        press.current = null;
        if (!p) return;
        const still =
          !p.moved &&
          Math.abs(e.clientX - p.x) <= MOVE_SLOP_PX &&
          Math.abs(e.clientY - p.y) <= MOVE_SLOP_PX;
        if (still && onTap) onTap(indexOf(e));
      },
      onPointerLeave(e) {
        if (e.pointerType === 'mouse') {
          press.current = null;
          setActive(null);
        }
      },
      onPointerCancel() {
        // The browser took the gesture for a scroll.
        press.current = null;
        setActive(null);
      },
      onKeyDown(e) {
        if (count === 0) return;
        const current = active ?? defaultIndex ?? count - 1;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const next = current + (e.key === 'ArrowLeft' ? -1 : 1);
          setActive(Math.max(0, Math.min(count - 1, next)));
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          setActive(e.key === 'Home' ? 0 : count - 1);
        } else if ((e.key === 'Enter' || e.key === ' ') && onTap) {
          e.preventDefault();
          onTap(current);
        } else if (e.key === 'Escape') {
          setActive(null);
        }
      },
      onFocus() {
        setActive((a) => a ?? defaultIndex ?? count - 1);
      },
      onBlur() {
        setActive(null);
      },
    },
  };
}

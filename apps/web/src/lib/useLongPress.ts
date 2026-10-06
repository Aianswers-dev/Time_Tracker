import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

const MOVE_TOLERANCE_PX = 10;

/**
 * Tap and long-press on the same element using pointer events. A press held
 * for `delayMs` without moving fires `onLongPress` and swallows the click that
 * follows; otherwise the normal click fires `onTap`. Keyboard activation goes
 * through onClick, so the element stays accessible. Only events from the
 * pointer that started the press count, so a stray mouse pointerleave during a
 * touch does not cancel it.
 */
export function useLongPress(onTap: () => void, onLongPress: () => void, delayMs = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const fired = useRef(false);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    press.current = null;
  }, []);

  useEffect(() => reset, [reset]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      press.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        press.current = null;
        onLongPress();
      }, delayMs);
    },
    [delayMs, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.id) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE_PX) reset();
    },
    [reset],
  );

  const onPointerEnd = useCallback(
    (e: PointerEvent) => {
      if (press.current?.id === e.pointerId) reset();
    },
    [reset],
  );

  const onClick = useCallback(
    (e: MouseEvent) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        return;
      }
      onTap();
    },
    [onTap],
  );

  const onContextMenu = useCallback((e: MouseEvent) => {
    // Stops the long-press context menu on Android and desktop. iOS uses the
    // -webkit-touch-callout CSS on the element instead.
    e.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onPointerLeave: onPointerEnd,
    onClick,
    onContextMenu,
  };
}

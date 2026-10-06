import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional element left of the close button, for example a Back button. */
  leading?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet dialog. Render it only while open. It takes focus on mount,
 * keeps Tab inside, closes on Escape or a backdrop tap, locks page scroll and
 * returns focus to whatever had it before.
 */
export function Sheet({ title, onClose, children, leading }: Props) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div
        className="animate-fade absolute inset-0 bg-[var(--overlay)]"
        aria-hidden
        // Only a press that starts on the backdrop closes the sheet. The click
        // that ends the long-press which opened the sheet lands here too.
        onPointerDown={() => (pressedBackdrop.current = true)}
        onClick={() => {
          if (pressedBackdrop.current) closeRef.current();
          pressedBackdrop.current = false;
        }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-sheet sheet-pad-bottom relative mx-auto flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-3xl border border-b-0 border-line bg-surface shadow-[var(--shadow)] outline-none"
      >
        <div className="flex items-center gap-1 px-2 pt-2">
          {leading}
          <h2 id={titleId} className="min-w-0 flex-1 truncate px-2 text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => closeRef.current()}
            className="inline-flex size-14 items-center justify-center rounded-full text-muted active:bg-surface-2"
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 pt-1 pb-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

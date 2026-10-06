import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ToastContext, type ToastApi, type ToastOptions } from './toast';

interface ActiveToast extends ToastOptions {
  id: number;
}

let nextId = 1;

/** One toast at a time, above the tab bar. A new toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);

  const dismiss = useCallback(() => setToast(null), []);
  const show = useCallback((t: ToastOptions) => setToast({ ...t, id: nextId++ }), []);

  useEffect(() => {
    if (!toast) return;
    const ms = toast.durationMs ?? (toast.action ? 10_000 : 4_000);
    const timer = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, ms);
    return () => clearTimeout(timer);
  }, [toast]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <div
        className="above-tabbar pointer-events-none fixed inset-x-0 z-[35] flex justify-center px-3"
        role="status"
        aria-live="polite"
      >
        {toast && (
          <div
            key={toast.id}
            className={`animate-toast pointer-events-auto flex min-h-14 w-full max-w-md items-center gap-2 rounded-2xl py-1 pr-1 pl-4 shadow-[var(--shadow)] ${
              toast.tone === 'error' ? 'bg-danger text-danger-fg' : 'bg-fg text-bg'
            }`}
          >
            <p className="min-w-0 flex-1 py-2 text-[15px] leading-snug">{toast.message}</p>
            {toast.action && (
              <button
                type="button"
                className="min-h-14 shrink-0 rounded-xl px-4 text-[15px] font-semibold underline-offset-2 active:opacity-70"
                onClick={() => {
                  const action = toast.action;
                  setToast(null);
                  action?.onClick();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext>
  );
}

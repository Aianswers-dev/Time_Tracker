import { createContext, useContext } from 'react';

export interface ToastOptions {
  message: string;
  /** One optional action button, for example Undo. */
  action?: { label: string; onClick: () => void };
  /** Defaults to 4 s, or 10 s when there is an action. */
  durationMs?: number;
  tone?: 'default' | 'error';
}

export interface ToastApi {
  show: (toast: ToastOptions) => void;
  dismiss: () => void;
}

export const ToastContext = createContext<ToastApi>({
  show: () => undefined,
  dismiss: () => undefined,
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** A user-facing message for an error thrown by an action. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong';
}

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg',
  secondary: 'bg-surface-2 text-fg',
  danger: 'bg-danger text-danger-fg',
  ghost: 'bg-transparent text-fg',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/** A 56 px tall button. */
export function Button({ variant = 'secondary', className = '', type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl px-5 text-base font-semibold active:opacity-75 disabled:opacity-45 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** A label above a control. */
export function Field({ label, children, hint, className = '' }: FieldProps) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-sm font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  );
}

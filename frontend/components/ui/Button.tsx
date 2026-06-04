import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Leading element (icon/spinner). Inline-aligned, never shifts text. */
  leading?: ReactNode;
  /** Add the accent bloom shadow — for the single hero action on a view. */
  glow?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover focus-visible:ring-accent/60',
  secondary:
    'bg-surface-overlay text-secondary border border-[rgb(var(--co-edge))] hover:bg-surface-elevated hover:text-primary focus-visible:ring-accent/40',
  ghost: 'bg-transparent text-secondary hover:bg-surface-overlay hover:text-primary focus-visible:ring-accent/40',
  danger: 'bg-danger-subtle text-danger border border-danger/30 hover:bg-danger/20 focus-visible:ring-danger/50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-[34px] px-2.5 text-xs gap-1.5',
  md: 'min-h-[38px] px-3.5 text-sm gap-2',
  lg: 'min-h-[44px] px-5 text-sm gap-2',
};

/** Button — the primary action primitive. Token-driven, keyboard focus ring,
 *  calm 120ms transition. Renders a real <button> (type defaults to "button"). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, leading, glow, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-token font-medium',
        'transition-colors duration-fast ease-token',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        glow && 'shadow-glow',
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
    </button>
  );
});

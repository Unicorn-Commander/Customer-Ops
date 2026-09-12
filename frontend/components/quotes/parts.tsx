/**
 * Small composer primitives. Money is INTEGER CENTS everywhere in the model,
 * so the one thing worth a component of its own is the money field: it parses
 * what a human types into cents and never lets a float near the record.
 */

'use client';

import type { ReactNode } from 'react';

import { cn } from '@/components/ui';
import { inputClass } from '@/components/dashboard/customer360/forms';

export const labelClass = 'block text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted';

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className={labelClass}>
        {label}
        {hint ? <span className="ml-1.5 normal-case tracking-normal text-tertiary">{hint}</span> : null}
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  className,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email';
}) {
  return (
    <input
      {...rest}
      className={cn(inputClass, mono && 'font-mono tabular-nums', className)}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      className={cn(inputClass, 'resize-y leading-relaxed', className)}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  className?: string;
}) {
  return (
    <select className={cn(inputClass, 'cursor-pointer', className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** "1400" / "1,400.50" / "$1,400" → 140000 cents. Anything unreadable → null. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Cents → a plain editable string ("1400", "1400.50") — never a symbol. */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
  return cents < 0 ? `-${body}` : body;
}

export function MoneyInput({
  cents,
  onCents,
  placeholder,
  className,
}: {
  cents: number;
  onCents: (cents: number) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      className={cn(inputClass, 'font-mono tabular-nums text-right', className)}
      inputMode="decimal"
      defaultValue={centsToInput(cents)}
      key={cents}
      placeholder={placeholder}
      onBlur={(e) => {
        const parsed = parseMoneyToCents(e.target.value);
        if (parsed !== null && parsed !== cents) onCents(parsed);
        else e.target.value = centsToInput(cents);
      }}
    />
  );
}

/** A quiet destructive affordance for a row (never a primary button). */
export function RowButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-token border border-subtle text-tertiary',
        'transition-colors duration-fast hover:border-accent/60 hover:text-primary',
        'focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/** A segmented control — used for Studio/Client and for small enum choices. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn('inline-flex rounded-token border border-subtle p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-[7px] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-accent/40',
              on ? 'bg-accent text-accent-contrast' : 'text-tertiary hover:text-primary',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

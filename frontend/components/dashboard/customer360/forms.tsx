/**
 * Customer-360 inline-form primitives — token-styled inputs the create/compose
 * forms share, so every federated action form looks like one design system
 * (replacing the legacy `co-input` leaf class).
 */
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/components/ui';

/** The shared input/textarea/select class string (token-driven focus ring). */
export const inputClass = cn(
  'w-full rounded-token border border-subtle bg-surface-overlay px-3 py-2 text-[13px] text-primary',
  'placeholder:text-muted focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
);

/** A small uppercase field label. */
export function FieldLabel({ children, optional }: { children: ReactNode; optional?: boolean }) {
  return (
    <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-tertiary">
      {children}
      {optional && <span className="font-normal normal-case text-muted">· optional</span>}
    </label>
  );
}

/** A labelled single-line text input. */
export function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  optional,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  optional?: boolean;
  type?: string;
}) {
  return (
    <div>
      <FieldLabel optional={optional}>{label}</FieldLabel>
      <input
        type={type}
        className={inputClass}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** A labelled multi-line textarea. */
export function FieldTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  optional?: boolean;
}) {
  return (
    <div>
      <FieldLabel optional={optional}>{label}</FieldLabel>
      <textarea
        className={cn(inputClass, 'resize-y')}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** An inline form error banner (renders nothing when there's no error). */
export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      <span className="min-w-0 break-words">{error}</span>
    </p>
  );
}

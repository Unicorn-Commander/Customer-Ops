'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw, LayoutDashboard } from 'lucide-react';

/**
 * Global error boundary for the app router. Next renders this when a route
 * segment throws during render (it does NOT catch errors in the root layout —
 * `global-error.tsx` handles that). On-brand glass card with a real retry
 * (`reset()` re-renders the segment) and an escape hatch back to the cockpit.
 *
 * `digest` is the server-stamped error id; we surface it quietly so a user can
 * quote it in a support note without dumping a stack trace into the UI.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Surface to the console for local debugging / error reporters. Never render
  // the raw message (it can carry internals) — the card stays human.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Customer-Ops route error:', error);
  }, [error]);

  return (
    <div className="co-ambient co-ambient-grid relative grid min-h-screen place-items-center overflow-hidden px-6">
      <div aria-hidden className="co-glow co-glow-fuchsia absolute left-[16%] top-[22%] h-72 w-72 opacity-45" />
      <div aria-hidden className="co-glow absolute bottom-[18%] right-[16%] h-72 w-80 opacity-40" />

      <div
        role="alert"
        className="co-glass co-glass-edge relative w-full max-w-[460px] animate-fade-up p-8 text-center sm:p-10"
      >
        <div className="relative mx-auto mb-6 w-fit">
          <span aria-hidden className="co-glow co-glow-fuchsia absolute -inset-3 h-[88px] w-[88px] opacity-70" />
          <span className="relative grid h-16 w-16 place-items-center rounded-[18px] bg-danger-subtle text-danger ring-1 ring-danger/30">
            <AlertTriangle className="h-8 w-8" strokeWidth={2.1} />
          </span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Something went sideways
        </h1>
        <p className="mx-auto mt-2.5 max-w-[360px] text-sm leading-relaxed text-tertiary">
          The cockpit hit an unexpected snag rendering this view. Your data is safe — try again, and
          if it keeps happening, head back to the overview.
        </p>

        <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="inline-flex w-full items-center justify-center gap-2 rounded-token bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-glow transition-[background-color,transform] duration-fast ease-token hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:w-auto"
          >
            <RotateCw className="h-4 w-4" strokeWidth={2.4} />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex w-full items-center justify-center gap-2 rounded-token border border-subtle bg-surface-raised px-4 py-2.5 text-sm font-medium text-secondary transition-colors duration-fast ease-token hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:w-auto"
          >
            <LayoutDashboard className="h-4 w-4" strokeWidth={2.4} />
            Back to cockpit
          </Link>
        </div>

        {error.digest && (
          <p className="mt-6 font-mono text-[11px] text-muted">
            Reference: <span className="text-tertiary">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  );
}

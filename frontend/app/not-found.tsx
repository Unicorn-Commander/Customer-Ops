import Link from 'next/link';
import { Radar, Compass, ArrowRight, LayoutDashboard } from 'lucide-react';

/**
 * Global 404. Replaces Next's bare built-in with a designed, on-brand surface in
 * the cinematic glass language (same shell as the login screen). A 404 isn't an
 * error — it's a wrong turn — so the tone is calm and the actions are forward:
 * back to the cockpit, or to sign-in. Server component (no client state needed).
 */
export default function NotFound() {
  return (
    <div className="co-ambient co-ambient-grid relative grid min-h-screen place-items-center overflow-hidden px-6">
      <div aria-hidden className="co-glow absolute left-[18%] top-[20%] h-72 w-72 opacity-55" />
      <div aria-hidden className="co-glow co-glow-cyan absolute bottom-[18%] right-[16%] h-72 w-80 opacity-40" />

      <div className="co-glass co-glass-edge relative w-full max-w-[460px] animate-fade-up p-8 text-center sm:p-10">
        <div className="relative mx-auto mb-6 w-fit">
          <span aria-hidden className="co-glow absolute -inset-3 h-[88px] w-[88px]" />
          <span className="relative grid h-16 w-16 place-items-center rounded-[18px] bg-gradient-to-br from-accent to-fuchsia shadow-glow">
            <Compass className="h-8 w-8 text-white" strokeWidth={2.1} />
          </span>
        </div>

        <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.2em] text-tertiary">
          404 · not found
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-primary">
          This page wandered off
        </h1>
        <p className="mx-auto mt-2.5 max-w-[340px] text-sm leading-relaxed text-tertiary">
          The link may be stale, or the relationship moved. Let&rsquo;s get you back to your cockpit.
        </p>

        <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
          <Link
            href="/dashboard"
            className="inline-flex w-full items-center justify-center gap-2 rounded-token bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-glow transition-[background-color,transform] duration-fast ease-token hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:w-auto"
          >
            <LayoutDashboard className="h-4 w-4" strokeWidth={2.4} />
            Back to cockpit
            <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
          </Link>
          <Link
            href="/auth/login"
            className="inline-flex w-full items-center justify-center gap-2 rounded-token border border-subtle bg-surface-raised px-4 py-2.5 text-sm font-medium text-secondary transition-colors duration-fast ease-token hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:w-auto"
          >
            <Radar className="h-4 w-4" strokeWidth={2.4} />
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

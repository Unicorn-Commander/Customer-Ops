'use client';

/* =============================================================================
   OnboardingTour — Customer-Ops first-run walkthrough
   -----------------------------------------------------------------------------
   A welcoming, dismissible multi-step intro shown on a user's first authenticated
   visit (gated on the `co_onboarded_v1` localStorage flag). Five steps walk the
   cockpit's spine: Welcome → Pipeline → Customer-360 → Relationship graph →
   Relations Officer.

   Voice: relational, plain, sovereign — agents propose, you decide; a surface,
   not an engine. No marketing language.

   Mechanics follow the suite's overlay conventions exactly (mirrors MobileNav /
   CommandPalette): portaled to <body>, mounted through the exit transition,
   focus-trapped to the card, body-scroll locked, Esc + scrim-click to dismiss,
   focus restored to the opener, reduced-motion safe. The visual accent is the
   on-brand coral/cyan constellation motif.
   ========================================================================== */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Radar, Filter, Users, Waypoints, Bot, X, ArrowLeft, ArrowRight, Check,
  type LucideIcon,
} from 'lucide-react';
import { IconTile } from '../ui/IconTile';
import { cn } from '../ui/cn';

/* ---------------------------------------------------------------------------
   First-run flag — versioned so a future "v2" tour can re-introduce itself.
   ------------------------------------------------------------------------- */

export const ONBOARDED_KEY = 'co_onboarded_v1';

/** Has this browser completed (or skipped) the first-run tour? SSR-safe. */
export function hasOnboarded(): boolean {
  if (typeof window === 'undefined') return true; // never auto-open during SSR
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return true; // storage blocked → don't nag
  }
}

/** Mark the tour complete so it doesn't auto-open again. */
export function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

interface TourStep {
  icon: LucideIcon;
  gradient: string;
  /** Tinted glow color behind the icon — the constellation accent. */
  glow: 'accent' | 'cyan' | 'fuchsia';
  eyebrow: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    icon: Radar,
    gradient: 'from-accent to-fuchsia',
    glow: 'accent',
    eyebrow: 'Welcome',
    title: 'Welcome to Customer-Ops',
    body:
      'Your relationship cockpit. Run the whole customer journey — and see everyone connected to a person in one place. Every relationship, connected.',
  },
  {
    icon: Filter,
    gradient: 'from-amber-400 to-orange-500',
    glow: 'fuchsia',
    eyebrow: 'The pipeline',
    title: 'Lead → Prospect → Customer',
    body:
      'Every relationship sits in one stage. Move a card to promote it; each move is logged on the timeline, so the history is always there.',
  },
  {
    icon: Users,
    gradient: 'from-violet-500 to-fuchsia-500',
    glow: 'accent',
    eyebrow: 'The customer-360',
    title: 'Everything connected, in one view',
    body:
      'Open a contact to see their 360 — deals, projects, invoices, email, and meetings, pulled live from the apps in your suite. Nothing is copied; you always see the real source.',
  },
  {
    icon: Waypoints,
    gradient: 'from-cyan-400 to-blue-500',
    glow: 'cyan',
    eyebrow: 'The graph',
    title: 'A living relationship graph',
    body:
      'People, orgs, and deals are nodes; the links between them are real, walkable edges. Click a node to recenter and follow the relationships outward.',
  },
  {
    icon: Bot,
    gradient: 'from-violet-500 to-cyan-500',
    glow: 'cyan',
    eyebrow: 'Your Relations Officer',
    title: 'It proposes, you decide',
    body:
      'Your AI colleague drafts follow-ups, triages leads, and suggests the next move — on your own models by default. It never sends or changes anything until you say so.',
  },
];

const GLOW_CLASS: Record<TourStep['glow'], string> = {
  accent: 'co-glow',
  cyan: 'co-glow co-glow-cyan',
  fuchsia: 'co-glow co-glow-fuchsia',
};

/* ---------------------------------------------------------------------------
   Reduced-motion hook (kept local so the component is self-contained — matches
   the MobileNav / CommandPalette pattern).
   ------------------------------------------------------------------------- */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/* ---------------------------------------------------------------------------
   Constellation accent — the on-brand coral/cyan motif behind the step icon.
   Pure decoration (aria-hidden): a few soft nodes + faint connecting lines.
   ------------------------------------------------------------------------- */

function Constellation({ reduced }: { reduced: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 320 120"
      className="pointer-events-none absolute inset-x-0 top-0 h-[120px] w-full opacity-70"
      preserveAspectRatio="xMidYMid slice"
    >
      <g stroke="rgb(var(--co-edge))" strokeWidth="1" opacity="0.5">
        <line x1="40" y1="30" x2="120" y2="64" />
        <line x1="120" y1="64" x2="210" y2="34" />
        <line x1="210" y1="34" x2="284" y2="72" />
        <line x1="120" y1="64" x2="170" y2="98" />
      </g>
      <g>
        <circle cx="40" cy="30" r="3" fill="rgb(var(--co-cyan))" />
        <circle cx="120" cy="64" r="4" fill="rgb(var(--co-accent))" className={reduced ? '' : 'animate-bloom'} />
        <circle cx="210" cy="34" r="2.5" fill="rgb(var(--co-fuchsia))" />
        <circle cx="284" cy="72" r="3" fill="rgb(var(--co-cyan))" />
        <circle cx="170" cy="98" r="2.5" fill="rgb(var(--co-accent))" />
      </g>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Component
   ------------------------------------------------------------------------- */

export interface OnboardingTourProps {
  open: boolean;
  /** Called on Skip, Esc, scrim-click, or "Get started" — the host closes us. */
  onClose: () => void;
  /** Called when the user finishes or skips, so the host can set the flag. */
  onComplete: () => void;
}

export function OnboardingTour({ open, onClose, onComplete }: OnboardingTourProps) {
  const reduced = usePrefersReducedMotion();

  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [step, setStep] = useState(0);

  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const last = STEPS.length - 1;
  const isLast = step === last;
  const current = STEPS[step];

  // Finish path — set the flag, then let the host close.
  const finish = useCallback(() => {
    onComplete();
    onClose();
  }, [onComplete, onClose]);

  // Open / close lifecycle (mirrors MobileNav).
  useLayoutEffect(() => {
    if (open) {
      if (exitTimer.current) clearTimeout(exitTimer.current);
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      setStep(0);
      setMounted(true);
      setShown(false);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    if (mounted) {
      const restore = openerRef.current;
      exitTimer.current = setTimeout(() => {
        setMounted(false);
        restore?.focus?.();
      }, reduced ? 0 : 200);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced]);

  // Move focus to the primary action on open + on each step change.
  useEffect(() => {
    if (open && mounted) {
      const id = requestAnimationFrame(() => primaryRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, mounted, step]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!mounted) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mounted]);

  // Esc closes (skip); ←/→ step; simple focus trap on Tab.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key === 'ArrowRight' && !isLast) {
        e.preventDefault();
        setStep((s) => Math.min(last, s + 1));
        return;
      }
      if (e.key === 'ArrowLeft' && step > 0) {
        e.preventDefault();
        setStep((s) => Math.max(0, s - 1));
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        first.focus();
      }
    },
    [finish, isLast, step, last],
  );

  if (!mounted) return null;

  const node = (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      role="presentation"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // Scrim click (mousedown on the overlay itself) dismisses — like a skip.
        if (e.target === e.currentTarget) finish();
      }}
    >
      {/* Scrim — dimmed + blurred, fades with the card. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 bg-surface-base/70 backdrop-blur-md',
          'transition-opacity ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Card */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="co-tour-title"
        aria-describedby="co-tour-body"
        className={cn(
          'co-glass co-glass-edge relative z-10 w-[min(440px,calc(100vw-2rem))] overflow-hidden',
          'rounded-token-xl shadow-token-lg origin-center',
          'transition-[opacity,transform] ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.97] opacity-0',
        )}
      >
        {/* Skip — top-right, always available. */}
        <button
          type="button"
          onClick={finish}
          className="absolute right-3 top-3 z-20 inline-flex items-center gap-1 rounded-token px-2 py-1 text-xs text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Skip
          <X className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>

        {/* Constellation header — the brand motif behind a gradient icon tile. */}
        <div className="relative h-[150px] overflow-hidden border-b border-subtle bg-gradient-to-b from-surface-overlay/60 to-transparent">
          <Constellation reduced={reduced} />
          <div className="absolute inset-0 grid place-items-center">
            <div className="relative">
              <span aria-hidden className={cn('absolute -inset-3 h-[calc(100%+24px)] w-[calc(100%+24px)]', GLOW_CLASS[current.glow])} />
              <IconTile icon={current.icon} gradient={current.gradient} size="lg" glow className="relative" />
            </div>
          </div>
        </div>

        {/* Copy */}
        <div className="px-6 pb-5 pt-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{current.eyebrow}</div>
          <h2 id="co-tour-title" className="mt-1 text-lg font-semibold tracking-tight text-primary">
            {current.title}
          </h2>
          <p id="co-tour-body" className="mt-2 text-sm leading-relaxed text-secondary">
            {current.body}
          </p>
        </div>

        {/* Footer — step dots + Back / Next / Get started. */}
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-6 py-4">
          {/* Step dots */}
          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-token ease-token',
                  i === step ? 'w-5 bg-accent' : 'w-1.5 bg-surface-elevated',
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-token px-2.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={2.4} />
                Back
              </button>
            )}
            {isLast ? (
              <button
                ref={primaryRef}
                type="button"
                onClick={finish}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-token bg-accent px-3.5 text-xs font-semibold text-accent-contrast shadow-glow transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <Check className="h-4 w-4" strokeWidth={2.5} />
                Get started
              </button>
            ) : (
              <button
                ref={primaryRef}
                type="button"
                onClick={() => setStep((s) => Math.min(last, s + 1))}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-token bg-accent px-3.5 text-xs font-semibold text-accent-contrast shadow-glow transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                Next
                <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default OnboardingTour;

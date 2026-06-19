'use client';

/* =============================================================================
   HelpCenter — the global Help affordance + its two overlays
   -----------------------------------------------------------------------------
   A single drop-in for the app header. It owns the open-state for both the Help
   drawer (HelpPanel) and the first-run onboarding tour (OnboardingTour), and:

   • renders the "?" Help button shown on every authenticated page,
   • auto-opens the onboarding tour on a user's FIRST authenticated visit
     (gated on the `co_onboarded_v1` localStorage flag), and
   • lets the Help panel re-trigger the tour ("Replay the intro").

   Co-locating the trigger and the overlays keeps the wiring in AppShell to a
   single element while the overlays themselves portal to <body>.
   ========================================================================== */

import { useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { cn } from '../ui/cn';
import { HelpPanel } from './HelpPanel';
import { OnboardingTour, hasOnboarded, markOnboarded } from './OnboardingTour';

export interface HelpCenterProps {
  /** Current route — drives the Help panel's route-aware topic. */
  pathname: string;
  /** Skip the first-run tour auto-open (e.g. the public `demo` shell). */
  disableFirstRun?: boolean;
  className?: string;
}

export function HelpCenter({ pathname, disableFirstRun = false, className }: HelpCenterProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  // First-run: open the tour once, on the first authenticated visit. Deferred a
  // beat so the cockpit paints first (the welcome lands on a rendered cockpit,
  // not a blank screen). localStorage read is client-only (SSR-safe via the hook).
  useEffect(() => {
    if (disableFirstRun) return undefined;
    if (hasOnboarded()) return undefined;
    const t = setTimeout(() => setTourOpen(true), 450);
    return () => clearTimeout(t);
  }, [disableFirstRun]);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const closeTour = useCallback(() => setTourOpen(false), []);
  // "Replay the intro" — re-open the tour without touching the flag.
  const replayIntro = useCallback(() => setTourOpen(true), []);

  return (
    <>
      <button
        type="button"
        onClick={openHelp}
        aria-label="Help"
        aria-haspopup="dialog"
        title="Help"
        className={cn(
          'grid h-9 w-9 place-items-center rounded-token border border-subtle bg-surface-raised text-tertiary',
          'transition-colors duration-fast ease-token hover:text-primary hover:bg-surface-overlay',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          className,
        )}
      >
        <HelpCircle className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </button>

      <HelpPanel open={helpOpen} onClose={closeHelp} pathname={pathname} onReplayIntro={replayIntro} />

      <OnboardingTour open={tourOpen} onClose={closeTour} onComplete={markOnboarded} />
    </>
  );
}

export default HelpCenter;

'use client';

/* =============================================================================
   useOverlay — the shared accessibility behaviour for modal-style surfaces
   -----------------------------------------------------------------------------
   Factors out the focus mechanics the suite's slide-overs (MobileNav, HelpPanel,
   CommandPalette) implement inline, so simpler modals (the token modals, the
   mark-lost confirm, the add-lead drawer) get the same gold-standard treatment
   without re-deriving it each time:

     • focus trap — Tab / Shift+Tab cycle within the panel
     • Esc to close (opt-out via `closeOnEsc:false` for must-acknowledge modals)
     • body-scroll lock while mounted
     • focus restored to the opener (whatever was focused at mount) on unmount
     • autofocus into the panel — a caller-supplied ref, else the first focusable

   Mount the overlay only while it should be visible (the usual `open && <…/>`
   pattern) and spread the returned `onKeyDown` on the overlay root + attach
   `panelRef` to the focusable panel. The hook keys all of its lifecycle on its
   own mount/unmount, so conditionally rendering the component is enough.
   ========================================================================== */

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UseOverlayOptions {
  /** Called on Esc (when `closeOnEsc`) — typically the same handler the scrim uses. */
  onClose: () => void;
  /** Allow Esc to close. Defaults to true; pass false to force an explicit action. */
  closeOnEsc?: boolean;
  /** Element to focus on open. Falls back to the panel's first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Whether the overlay is active. Defaults to true. Pass the caller's `open`
   *  flag when the hook is called before a conditional `return null` (so the
   *  scroll-lock / focus mechanics only engage while the surface is shown). */
  enabled?: boolean;
}

export interface UseOverlayResult {
  /** Attach to the focusable panel — the focus trap + initial-focus scope. */
  panelRef: RefObject<HTMLDivElement | null>;
  /** Spread on the overlay root to wire Esc + the Tab focus trap. */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useOverlay({
  onClose,
  closeOnEsc = true,
  initialFocusRef,
  enabled = true,
}: UseOverlayOptions): UseOverlayResult {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Remember the opener + restore focus to it on close (keyboard return path).
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    return () => openerRef.current?.focus?.();
  }, [enabled]);

  // Move focus into the panel once it's shown (caller's ref, else first focusable).
  useEffect(() => {
    if (!enabled) return undefined;
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current;
      target?.focus?.();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Lock body scroll while shown.
  useEffect(() => {
    if (!enabled) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [enabled]);

  // Esc to close + a simple focus trap (Tab cycles within the panel).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose, closeOnEsc],
  );

  return { panelRef, onKeyDown };
}

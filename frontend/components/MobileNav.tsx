'use client';

/* =============================================================================
   MobileNav — the cockpit's navigation drawer for small screens
   -----------------------------------------------------------------------------
   The desktop sidebar rail is `hidden md:flex`, so below the md breakpoint this
   slide-over is the ONLY way to move between sections. It mirrors the rail's
   content (brand, primary NAV, theme + user/sign-out) and reuses the SAME NAV /
   isNavActive exports from lib/nav so the two never drift apart.

   It follows the CommandPalette's slide-over conventions exactly — portaled to
   <body>, mounted through the exit transition, focus-trapped to the panel,
   body-scroll locked, Esc + scrim-click to close, focus restored to the opener,
   and reduced-motion safe (the enter/exit transition collapses to instant). The
   panel itself comes in from the left to echo the rail's position.
   ========================================================================== */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Radar, X, LogOut } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { IconTile } from './ui/IconTile';
import { cn } from './ui/cn';
import { NAV, isNavActive } from '@/lib/nav';
import type { CustomerOpsUser } from '@/lib/api';

export interface MobileNavProps {
  open: boolean;
  onClose: () => void;
  pathname: string;
  user: CustomerOpsUser | null;
  onSignOut: () => void;
}

/** Read the reduced-motion preference (kept local so the drawer is self-contained). */
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

export function MobileNav({ open, onClose, pathname, user, onSignOut }: MobileNavProps) {
  const reduced = usePrefersReducedMotion();

  // Keep mounted through the exit transition; `shown` drives the enter/exit CSS.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initials = (user ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}` : '··').toUpperCase();

  // Open / close lifecycle (mirrors CommandPalette).
  useLayoutEffect(() => {
    if (open) {
      if (exitTimer.current) clearTimeout(exitTimer.current);
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
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

  // Move focus into the panel on open (the close button is a safe first stop).
  useEffect(() => {
    if (open && mounted) {
      const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, mounted]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!mounted) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mounted]);

  // Esc to close + a simple focus trap (Tab cycles within the panel).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      );
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
    [onClose],
  );

  if (!mounted) return null;

  const node = (
    <div
      className="fixed inset-0 z-[90] md:hidden"
      role="presentation"
      onKeyDown={onKeyDown}
    >
      {/* Scrim — dimmed + blurred, fades with the panel. */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-surface-base/60 backdrop-blur-md',
          'transition-opacity ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Panel — slides in from the left to echo the desktop rail. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          'absolute inset-y-0 left-0 flex w-[82%] max-w-[300px] flex-col border-r border-[rgb(var(--co-edge))] bg-surface-base shadow-token-lg',
          'transition-transform ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand + close */}
        <div className="relative flex items-center justify-between gap-2 border-b border-subtle px-4 py-4">
          <Link href="/dashboard" onClick={onClose} className="relative flex items-center gap-2.5">
            <span aria-hidden className="co-glow absolute -left-1 -top-1 h-10 w-10" />
            <span className="relative grid h-9 w-9 place-items-center rounded-[11px] bg-gradient-to-br from-accent to-fuchsia shadow-glow">
              <Radar className="h-5 w-5 text-white" strokeWidth={2.4} />
            </span>
            <span className="relative text-[15px] font-semibold tracking-tight">
              <span className="co-wordmark">Customer</span><span className="text-tertiary">-Ops</span>
            </span>
          </Link>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-token text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={2.4} />
          </button>
        </div>

        {/* Scrollable nav body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4">
          <nav className="flex flex-col gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = isNavActive(item, pathname);
              return (
                <Fragment key={item.href}>
                  {/* Section label — mirrors the desktop rail so the two never drift. */}
                  {item.groupLabel && (
                    <span className="mb-1 mt-3 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {item.groupLabel}
                    </span>
                  )}
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-token px-2.5 py-2.5 transition-colors duration-fast ease-token',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      active ? 'bg-surface-overlay' : 'hover:bg-surface-raised',
                    )}
                  >
                    {active && <span className={cn('absolute left-0 top-2 h-[calc(100%-16px)] w-[3px] rounded-full', item.bar)} />}
                    <IconTile icon={item.icon} gradient={item.gradient} size="sm" />
                    <span className={cn('text-sm', active ? 'font-semibold text-primary' : 'font-medium text-primary/85 group-hover:text-primary')}>
                      {item.label}
                    </span>
                  </Link>
                </Fragment>
              );
            })}
          </nav>
        </div>

        {/* Footer: theme + user/sign-out */}
        <div className="space-y-3 border-t border-subtle px-3 py-3.5">
          <div className="flex items-center justify-between px-1.5">
            <span className="text-xs font-medium text-tertiary">Appearance</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-2.5 rounded-token border border-subtle bg-surface-raised p-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-fuchsia text-xs font-bold text-white">{initials}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-primary">{user?.firstName} {user?.lastName}</div>
              <div className="truncate text-[11px] text-tertiary">{user?.email}</div>
            </div>
            <button
              type="button"
              onClick={() => { onClose(); onSignOut(); }}
              aria-label="Sign out"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            >
              <LogOut className="h-4 w-4" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default MobileNav;

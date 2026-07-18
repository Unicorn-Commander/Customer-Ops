'use client';

/* =============================================================================
   HelpPanel — Customer-Ops in-app Help drawer
   -----------------------------------------------------------------------------
   A right-side slide-over with the cockpit's help topics (mirrors
   `docs/USER-GUIDE.md`), rendered as collapsible, scannable sections.

   • ROUTE-AWARE. On open, the topic that matches the current route is expanded
     and scrolled into view (e.g. a customer page → "The customer-360"). See
     `routeTopic()` in `lib/help-content.ts`.
   • REPLAY THE INTRO. A footer action re-triggers the first-run onboarding tour
     (the host wires `onReplayIntro`).
   • Mechanics mirror MobileNav exactly: portaled to <body>, mounted through the
     exit transition, focus-trapped, body-scroll locked, Esc + scrim-click to
     close, focus restored to the opener, reduced-motion safe. The panel slides
     in from the RIGHT (Help is a reference surface, opposite the left nav rail).
   ========================================================================== */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronDown, BookOpen, Sparkles, ShieldCheck, type LucideIcon,
} from 'lucide-react';
import { IconTile } from '../ui/IconTile';
import { cn } from '../ui/cn';
import { HELP_TOPICS, USER_GUIDE_URL, routeTopic, type HelpBlock, type HelpTopic } from '@/lib/help-content';

/* ---------------------------------------------------------------------------
   Reduced-motion hook (local, matching the suite's overlay components).
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
   Topic block renderer
   ------------------------------------------------------------------------- */

function Block({ block }: { block: HelpBlock }) {
  if (block.kind === 'p') {
    return <p className="text-[13px] leading-relaxed text-secondary">{block.text}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {block.items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-secondary">
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------------
   Collapsible topic
   ------------------------------------------------------------------------- */

function TopicSection({
  topic,
  open,
  onToggle,
  registerRef,
}: {
  topic: HelpTopic;
  open: boolean;
  onToggle: () => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const panelId = `co-help-${topic.id}`;
  const btnId = `co-help-btn-${topic.id}`;
  return (
    <div
      ref={(el) => registerRef(topic.id, el)}
      className="overflow-hidden rounded-token-lg border border-subtle bg-surface-raised"
    >
      <h3>
        <button
          id={btnId}
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40',
            open ? 'bg-surface-overlay/50' : 'hover:bg-surface-overlay/40',
          )}
        >
          <IconTile icon={topic.icon} gradient={topic.gradient} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-primary">{topic.title}</span>
            {!open && <span className="block truncate text-[11px] text-tertiary">{topic.summary}</span>}
          </span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-tertiary transition-transform duration-fast ease-token',
              open && 'rotate-180',
            )}
            strokeWidth={2.25}
          />
        </button>
      </h3>
      {open && (
        <div id={panelId} role="region" aria-labelledby={btnId} className="space-y-3 border-t border-subtle px-3.5 py-3.5">
          {topic.body.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   A small action row (footer links / replay).
   ------------------------------------------------------------------------- */

function ActionRow({
  icon: Icon,
  label,
  sub,
  onClick,
  href,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  onClick?: () => void;
  href?: string;
}) {
  const className = cn(
    'flex w-full items-center gap-2.5 rounded-token border border-subtle bg-surface-raised px-3 py-2.5 text-left',
    'transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
  );
  const inner = (
    <>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] border border-subtle bg-surface-overlay text-tertiary">
        <Icon className="h-[15px] w-[15px]" strokeWidth={2.25} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-primary">{label}</span>
        <span className="block truncate text-[11px] text-tertiary">{sub}</span>
      </span>
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Component
   ------------------------------------------------------------------------- */

export interface HelpPanelProps {
  open: boolean;
  onClose: () => void;
  /** Current route — drives which topic opens first. */
  pathname: string;
  /** Re-trigger the first-run onboarding tour from the Help footer. */
  onReplayIntro: () => void;
  /** Link to the full guide / README (best-effort — defaults to the repo README). */
  guideHref?: string;
}

export function HelpPanel({
  open,
  onClose,
  pathname,
  onReplayIntro,
  guideHref = USER_GUIDE_URL,
}: HelpPanelProps) {
  const reduced = usePrefersReducedMotion();

  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  // Which topic is expanded (single-open accordion). Set route-aware on open.
  const [openTopic, setOpenTopic] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-topic section refs, so we can scroll the route-matched one into view.
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  }, []);

  // Open / close lifecycle (mirrors MobileNav). On open, pick the route topic.
  useLayoutEffect(() => {
    if (open) {
      if (exitTimer.current) clearTimeout(exitTimer.current);
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      setOpenTopic(routeTopic(pathname));
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

  // Move focus into the panel on open (close button is a safe first stop).
  useEffect(() => {
    if (open && mounted) {
      const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, mounted]);

  // Scroll the route-matched topic into view once the panel has rendered open.
  useEffect(() => {
    if (!open || !mounted || !openTopic) return undefined;
    const id = requestAnimationFrame(() => {
      sectionRefs.current.get(openTopic)?.scrollIntoView({
        block: 'start',
        behavior: reduced ? 'auto' : 'smooth',
      });
    });
    return () => cancelAnimationFrame(id);
    // Run once per open (and if the matched topic changes) — not on manual toggles.
  }, [open, mounted, openTopic, reduced]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!mounted) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mounted]);

  // Esc to close + a simple focus trap.
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
    <div className="fixed inset-0 z-[95]" role="presentation" onKeyDown={onKeyDown}>
      {/* Scrim */}
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

      {/* Panel — slides in from the right. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className={cn(
          'absolute inset-y-0 right-0 flex w-[92%] max-w-[420px] flex-col border-l border-[rgb(var(--co-edge))] bg-surface-base shadow-token-lg',
          'transition-transform ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="relative flex items-center justify-between gap-2 border-b border-subtle px-4 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/brand-mark.png"
              alt="Customer-Ops"
              className="relative h-9 w-9 shrink-0 rounded-[11px] shadow-glow"
            />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-tight text-primary">Help</div>
              <div className="truncate text-[11px] text-tertiary">Every relationship, connected.</div>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-token text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={2.4} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {/* Intro / persona line */}
          <div className="mb-3 flex items-start gap-2.5 rounded-token-lg border border-subtle bg-surface-raised px-3.5 py-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-accent/12 text-accent">
              <ShieldCheck className="h-[15px] w-[15px]" strokeWidth={2.25} />
            </span>
            <p className="text-[12px] leading-relaxed text-tertiary">
              Customer-Ops is a surface, not an engine — it federates your suite into one living relationship graph. Your
              Relations Officer proposes; you decide.
            </p>
          </div>

          {/* Topics */}
          <div className="space-y-2">
            {HELP_TOPICS.map((topic) => (
              <TopicSection
                key={topic.id}
                topic={topic}
                open={openTopic === topic.id}
                onToggle={() => setOpenTopic((cur) => (cur === topic.id ? null : topic.id))}
                registerRef={registerRef}
              />
            ))}
          </div>

          {/* Footer actions */}
          <div className="mt-4 space-y-2">
            <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">More</div>
            <ActionRow
              icon={Sparkles}
              label="Replay the intro"
              sub="Walk through the cockpit again"
              onClick={() => { onClose(); onReplayIntro(); }}
            />
            <ActionRow
              icon={BookOpen}
              label="Full user guide"
              sub="The complete walkthrough"
              href={guideHref}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default HelpPanel;

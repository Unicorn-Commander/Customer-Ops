'use client';

/* =============================================================================
   CommandPalette — Customer-Ops ⌘K command palette
   -----------------------------------------------------------------------------
   A custom, dependency-free command palette in the Linear / Raycast / cmdk mold.

   Design notes:
   • VIRTUAL FOCUS. The search <input> holds real DOM focus the entire time; the
     active row is tracked in React state and surfaced to AT via the input's
     `aria-activedescendant`. This is the correct combobox a11y pattern and lets
     the user type and arrow at the same time (the cmdk / Linear model).
   • CUSTOM FUZZY MATCH. A small subsequence scorer (no deps) ranks commands and
     returns the matched character indices so we can bold the matched glyphs.
   • EXTENSIBLE. Everything is driven by a flat `CommandItem[]`. The static set is
     assembled in `useCommands()`. To add live entity search later, merge an async
     source into `items` (see the `// FUTURE` marker) — the renderer groups,
     filters, navigates, and runs any item uniformly.
   • CINEMATIC, REDUCED-MOTION SAFE. Mount → next-frame transition (scale + fade)
     on the panel and a fade on the backdrop, using the design-system motion
     tokens. `prefers-reduced-motion` collapses the transition to an instant show.
   • Portaled to <body>, focus-trapped, restores focus to the opener on close,
     closes on Esc + backdrop click, and locks body scroll while open.
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Filter,
  Waypoints,
  UserPlus,
  ListChecks,
  SunMoon,
  PanelLeft,
  Search,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  type LucideIcon,
} from 'lucide-react';
import { IconTile } from './ui/IconTile';
import { cn } from './ui/cn';

/* ---------------------------------------------------------------------------
   Model
   ------------------------------------------------------------------------- */

export type CommandGroup = 'Navigation' | 'Actions' | 'Results';

export interface CommandItem {
  /** Stable id — used for the active-descendant relationship and React keys. */
  id: string;
  /** Primary label, shown and fuzzy-matched. */
  label: string;
  group: CommandGroup;
  /** Extra search terms (synonyms / shortcuts) that match but don't render. */
  keywords?: string;
  /** Optional right-aligned hint (e.g. a destination path or shortcut). */
  hint?: string;
  /** Invoked on Enter / click. The palette closes immediately after. */
  run: () => void;
  /** Visual leading glyph: a gradient IconTile (nav) or a lucide action icon. */
  icon:
    | { kind: 'tile'; icon: LucideIcon; gradient: string }
    | { kind: 'lucide'; icon: LucideIcon };
}

/** Stable order for section rendering. */
const GROUP_ORDER: CommandGroup[] = ['Navigation', 'Actions', 'Results'];

/* ---------------------------------------------------------------------------
   Fuzzy matching — tiny subsequence scorer (no deps)
   -------------------------------------------------------------------------
   Returns null on no-match, otherwise a score (higher = better) plus the set of
   matched character indices in `text` for highlight. Heuristics, in priority:
     • all query chars must appear in order (subsequence)
     • big bonus for a clean prefix and for the first matched char
     • bonus for consecutive runs and for matches at word / CamelCase boundaries
     • small penalty for leading + interior gaps
   ------------------------------------------------------------------------- */

interface MatchResult {
  score: number;
  indices: number[];
}

function isBoundary(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return true;
  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.') return true;
  // CamelCase boundary: lower→Upper.
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

function fuzzyMatch(text: string, query: string): MatchResult | null {
  if (!query) return { score: 1, indices: [] };

  const t = text;
  const tl = t.toLowerCase();
  const ql = query.toLowerCase();

  // Fast path: exact substring (incl. prefix) — score generously, exactly mark it.
  const subIdx = tl.indexOf(ql);
  if (subIdx !== -1) {
    const indices: number[] = [];
    for (let i = 0; i < ql.length; i++) indices.push(subIdx + i);
    let score = 120 + ql.length * 4;
    if (subIdx === 0) score += 80; // clean prefix
    else if (isBoundary(t[subIdx - 1], t[subIdx])) score += 45; // word-start
    score -= subIdx; // earlier is better
    return { score, indices };
  }

  // Subsequence walk.
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastMatch = -1;
  for (let i = 0; i < t.length && qi < ql.length; i++) {
    if (tl[i] === ql[qi]) {
      indices.push(i);
      // base point per matched char
      score += 6;
      // boundary / start bonuses
      if (isBoundary(t[i - 1], t[i])) score += 14;
      if (i === 0) score += 10;
      // consecutive-run bonus (accelerating)
      if (lastMatch === i - 1) {
        run += 1;
        score += 6 + run * 3;
      } else {
        run = 0;
        // small gap penalty (distance since last match)
        if (lastMatch !== -1) score -= Math.min(8, i - lastMatch - 1);
      }
      lastMatch = i;
      qi += 1;
    }
  }
  if (qi < ql.length) return null; // not all query chars consumed

  // Prefer shorter targets when scores are otherwise close, and penalize a long
  // leading gap before the first match.
  score -= indices[0] ?? 0;
  score -= Math.max(0, t.length - query.length) * 0.05;
  return { score, indices };
}

/** Best match across label + keywords; highlight only applies to the label. */
function scoreItem(item: CommandItem, query: string): MatchResult | null {
  const onLabel = fuzzyMatch(item.label, query);
  if (!query) return onLabel;
  if (item.keywords) {
    const onKw = fuzzyMatch(item.keywords, query);
    if (onKw && (!onLabel || onKw.score > onLabel.score)) {
      // Matched via keywords — keep the label highlight if it also matched,
      // otherwise render the label plain but still rank by the keyword score.
      return { score: onKw.score - 8, indices: onLabel?.indices ?? [] };
    }
  }
  return onLabel;
}

/* ---------------------------------------------------------------------------
   Highlighted label
   ------------------------------------------------------------------------- */

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  const out: React.ReactNode[] = [];
  let buf = '';
  let bufHit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== bufHit) {
      out.push(
        bufHit ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {buf}
          </mark>
        ) : (
          <span key={i}>{buf}</span>
        ),
      );
      buf = '';
      bufHit = hit;
    }
    buf += text[i];
  }
  out.push(
    bufHit ? (
      <mark key="end" className="bg-transparent font-semibold text-primary">
        {buf}
      </mark>
    ) : (
      <span key="end">{buf}</span>
    ),
  );
  return <>{out}</>;
}

/* ---------------------------------------------------------------------------
   Command source
   -------------------------------------------------------------------------
   Built once per open (router identity is stable). Mirrors the AppShell NAV
   gradients so the palette reads as the same cockpit. Extend here.
   ------------------------------------------------------------------------- */

function useCommands(close: () => void): CommandItem[] {
  const router = useRouter();

  return useMemo<CommandItem[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
      close();
    };

    const toggleTheme = () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('co-theme', next);
      } catch {
        /* ignore */
      }
      // Let any listeners (e.g. ThemeToggle's local state) reconcile if present.
      window.dispatchEvent(new CustomEvent('co:theme', { detail: next }));
      close();
    };

    const toggleSidebar = () => {
      let next: 'collapsed' | 'open' = 'collapsed';
      try {
        next = localStorage.getItem('co-sidebar') === 'collapsed' ? 'open' : 'collapsed';
        localStorage.setItem('co-sidebar', next);
      } catch {
        /* ignore */
      }
      // The shell may listen for this to update without a reload (safe to ignore).
      window.dispatchEvent(new CustomEvent('co:sidebar', { detail: next }));
      close();
    };

    const items: CommandItem[] = [
      // ---- Navigation -----------------------------------------------------
      {
        id: 'nav-overview',
        label: 'Overview',
        group: 'Navigation',
        keywords: 'home dashboard cockpit start',
        hint: '/dashboard',
        run: go('/dashboard'),
        icon: { kind: 'tile', icon: LayoutDashboard, gradient: 'from-indigo-500 to-violet-500' },
      },
      {
        id: 'nav-relationships',
        label: 'Relationships',
        group: 'Navigation',
        keywords: 'customers contacts people accounts crm',
        hint: '/dashboard/customers',
        run: go('/dashboard/customers'),
        icon: { kind: 'tile', icon: Users, gradient: 'from-violet-500 to-fuchsia-500' },
      },
      {
        id: 'nav-pipeline',
        label: 'Pipeline',
        group: 'Navigation',
        keywords: 'funnel deals stages leads prospects',
        hint: '/dashboard/pipeline',
        run: go('/dashboard/pipeline'),
        icon: { kind: 'tile', icon: Filter, gradient: 'from-amber-400 to-orange-500' },
      },
      {
        id: 'nav-graph',
        label: 'Knowledge graph',
        group: 'Navigation',
        keywords: 'network nodes relationships map connections',
        hint: '/dashboard/graph',
        run: go('/dashboard/graph'),
        icon: { kind: 'tile', icon: Waypoints, gradient: 'from-cyan-400 to-blue-500' },
      },

      // ---- Actions --------------------------------------------------------
      {
        id: 'act-new-relationship',
        label: 'New relationship',
        group: 'Actions',
        keywords: 'add create contact customer person account new',
        run: go('/dashboard/customers'),
        icon: { kind: 'lucide', icon: UserPlus },
      },
      {
        id: 'act-triage',
        label: 'Triage leads',
        group: 'Actions',
        keywords: 'review inbox sort prioritize pipeline leads',
        run: go('/dashboard/pipeline'),
        icon: { kind: 'lucide', icon: ListChecks },
      },
      {
        id: 'act-theme',
        label: 'Toggle theme',
        group: 'Actions',
        keywords: 'dark light mode appearance color',
        run: toggleTheme,
        icon: { kind: 'lucide', icon: SunMoon },
      },
      {
        id: 'act-sidebar',
        label: 'Collapse / expand sidebar',
        group: 'Actions',
        keywords: 'toggle sidebar nav rail panel collapse expand',
        run: toggleSidebar,
        icon: { kind: 'lucide', icon: PanelLeft },
      },
    ];

    // FUTURE: merge an async entity-search source here, e.g.
    //   ...entityResults.map(r => ({ id:`rel-${r.id}`, group:'Results', label:r.name,
    //     run: go(`/dashboard/customers/${r.id}`), icon:{kind:'lucide',icon:Users} }))
    // The renderer groups + ranks + navigates any CommandItem uniformly.

    return items;
  }, [router, close]);
}

/* ---------------------------------------------------------------------------
   Reduced-motion hook
   ------------------------------------------------------------------------- */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/* ---------------------------------------------------------------------------
   Component
   ------------------------------------------------------------------------- */

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const reduced = usePrefersReducedMotion();

  // Keep the node mounted through the exit transition.
  const [mounted, setMounted] = useState(open);
  // Drives the enter/exit CSS state (false = scaled/faded out).
  const [shown, setShown] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);

  const listboxId = useId();

  const close = useCallback(() => onClose(), [onClose]);
  const commands = useCommands(close);

  // ---- Filter + rank ------------------------------------------------------
  const results = useMemo(() => {
    const q = query.trim();
    const scored = commands
      .map((item) => {
        const m = scoreItem(item, q);
        return m ? { item, score: m.score, indices: m.indices } : null;
      })
      .filter((x): x is { item: CommandItem; score: number; indices: number[] } => x !== null);

    // Group-stable sort: by group order, then score desc, then label.
    scored.sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.item.group);
      const gb = GROUP_ORDER.indexOf(b.item.group);
      if (ga !== gb) return ga - gb;
      if (b.score !== a.score) return b.score - a.score;
      return a.item.label.localeCompare(b.item.label);
    });
    return scored;
  }, [commands, query]);

  // Flat list of ids in render order — the spine of keyboard navigation.
  const flatIds = useMemo(() => results.map((r) => r.item.id), [results]);

  // Grouped view for rendering section headers.
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, typeof results>();
    for (const r of results) {
      const arr = map.get(r.item.group) ?? [];
      arr.push(r);
      map.set(r.item.group, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g)! }));
  }, [results]);

  // ---- Open / close lifecycle --------------------------------------------
  useLayoutEffect(() => {
    if (open) {
      if (exitTimer.current) clearTimeout(exitTimer.current);
      // Remember who opened us so we can restore focus on close.
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;

      setMounted(true);
      setQuery('');
      setShown(false);
      // Next frame → animate in (so the browser registers the from-state first).
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }

    // Closing: play the exit transition, then unmount.
    setShown(false);
    if (mounted) {
      const restore = openerRef.current;
      exitTimer.current = setTimeout(
        () => {
          setMounted(false);
          // Restore focus to the trigger for keyboard users.
          restore?.focus?.();
        },
        reduced ? 0 : 180,
      );
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced]);

  // Autofocus the input + reset the active row whenever we (re)open.
  useEffect(() => {
    if (open && mounted) {
      // Defer to ensure the input is in the DOM and visible.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, mounted]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!mounted) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Keep an active row valid as results change; default to the first.
  useEffect(() => {
    if (flatIds.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((cur) => (cur && flatIds.includes(cur) ? cur : flatIds[0]));
  }, [flatIds]);

  // Scroll the active row into view as it moves.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-id="${cssEscape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const move = useCallback(
    (delta: number) => {
      if (flatIds.length === 0) return;
      const idx = activeId ? flatIds.indexOf(activeId) : -1;
      const next = (idx + delta + flatIds.length) % flatIds.length;
      setActiveId(flatIds[next]);
    },
    [activeId, flatIds],
  );

  const runActive = useCallback(() => {
    const row = results.find((r) => r.item.id === activeId);
    row?.item.run();
  }, [results, activeId]);

  // ---- Keyboard model (input-scoped; input keeps real focus) --------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          break;
        case 'Home':
          if (flatIds.length) {
            e.preventDefault();
            setActiveId(flatIds[0]);
          }
          break;
        case 'End':
          if (flatIds.length) {
            e.preventDefault();
            setActiveId(flatIds[flatIds.length - 1]);
          }
          break;
        case 'Enter':
          e.preventDefault();
          runActive();
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
        case 'Tab':
          // Focus trap: only the input is tabbable, so swallow Tab entirely.
          e.preventDefault();
          break;
        default:
          break;
      }
    },
    [move, runActive, close, flatIds],
  );

  if (!mounted) return null;

  const node = (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center"
      role="presentation"
      onMouseDown={(e) => {
        // Backdrop click (mousedown on the overlay itself, not its children).
        if (e.target === e.currentTarget) close();
      }}
    >
      {/* Backdrop — dimmed + blurred, fades with the panel. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 bg-surface-base/55 backdrop-blur-md',
          'transition-opacity ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          'co-glass co-glass-edge relative z-10 mt-[12vh] w-[min(640px,calc(100vw-2rem))] overflow-hidden',
          'rounded-token-xl shadow-token-lg origin-top',
          'transition-[opacity,transform] ease-token',
          reduced ? 'duration-0' : 'duration-token',
          shown ? 'translate-y-0 scale-100 opacity-100' : '-translate-y-1 scale-[0.97] opacity-0',
        )}
      >
        {/* Search row */}
        <div className="flex items-center gap-3 border-b border-subtle px-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-tertiary" strokeWidth={2.25} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeId ? `${listboxId}-${activeId}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Search commands, people, pipeline…"
            className={cn(
              'h-14 w-full bg-transparent text-[15px] text-primary outline-none',
              'placeholder:text-muted',
            )}
          />
          <kbd className="hidden shrink-0 rounded border border-subtle bg-surface-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted sm:block">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="max-h-[min(56vh,420px)] overflow-y-auto overscroll-contain p-2"
        >
          {grouped.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <div className="text-sm font-medium text-secondary">No matches</div>
              <div className="mt-1 text-xs text-tertiary">
                Try a different term — or hit{' '}
                <span className="font-mono text-muted">esc</span> to dismiss.
              </div>
            </div>
          ) : (
            grouped.map(({ group, rows }) => (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
                  {group}
                </div>
                {rows.map(({ item, indices }) => {
                  const active = item.id === activeId;
                  return (
                    <div
                      key={item.id}
                      id={`${listboxId}-${item.id}`}
                      data-cmd-id={item.id}
                      role="option"
                      aria-selected={active}
                      // Pointer hover previews selection; click runs it.
                      onMouseMove={() => setActiveId(item.id)}
                      onClick={() => item.run()}
                      className={cn(
                        'group flex cursor-pointer items-center gap-3 rounded-token px-2.5 py-2',
                        'transition-colors duration-fast ease-token',
                        active ? 'bg-surface-overlay' : 'hover:bg-surface-raised/60',
                      )}
                    >
                      {item.icon.kind === 'tile' ? (
                        <IconTile icon={item.icon.icon} gradient={item.icon.gradient} size="sm" />
                      ) : (
                        <span
                          className={cn(
                            'grid h-7 w-7 shrink-0 place-items-center rounded-[9px] border',
                            active
                              ? 'border-accent/30 bg-accent/15 text-accent'
                              : 'border-subtle bg-surface-overlay text-tertiary group-hover:text-secondary',
                          )}
                        >
                          <item.icon.icon className="h-[15px] w-[15px]" strokeWidth={2.25} />
                        </span>
                      )}

                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm',
                          active ? 'text-primary' : 'text-primary/85',
                        )}
                      >
                        <Highlight text={item.label} indices={indices} />
                      </span>

                      {item.hint && (
                        <span className="hidden shrink-0 truncate font-mono text-[11px] text-muted sm:block">
                          {item.hint}
                        </span>
                      )}

                      {/* Enter affordance on the active row. */}
                      <CornerDownLeft
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-tertiary transition-opacity',
                          active ? 'opacity-100' : 'opacity-0',
                        )}
                        strokeWidth={2.25}
                      />
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Hint footer */}
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-4 py-2.5 text-[11px] text-tertiary">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <FooterKey>
                <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
              </FooterKey>
              <FooterKey>
                <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
              </FooterKey>
              <span className="ml-0.5">navigate</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <FooterKey>
                <CornerDownLeft className="h-3 w-3" strokeWidth={2.5} />
              </FooterKey>
              <span className="ml-0.5">select</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <FooterKey>esc</FooterKey>
              <span className="ml-0.5">close</span>
            </span>
          </div>
          <span className="hidden items-center gap-1.5 text-muted sm:inline-flex">
            <span className="co-wordmark font-semibold">Customer</span>
            <span>-Ops</span>
          </span>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

/* ---------------------------------------------------------------------------
   Small bits
   ------------------------------------------------------------------------- */

function FooterKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-subtle bg-surface-overlay px-1 font-mono text-[10px] leading-none text-muted">
      {children}
    </kbd>
  );
}

/** Minimal CSS.escape fallback for our id selector (ids are URL-ish, no spaces). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\\]\[]/g, '\\$&');
}

export default CommandPalette;

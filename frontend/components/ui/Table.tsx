import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from './cn';

/**
 * Table — a small, token-driven table primitive for the cockpit's data surfaces.
 *
 * Composable parts (`Table` / `THead` / `TBody` / `TR` / `TH` / `TD`) so callers
 * keep full control of cells while inheriting the house look: a sticky frosted
 * header, hairline row separators, zebra + hover rows, comfortable-but-scannable
 * density, and a sortable header affordance with proper `aria-sort`.
 *
 * Scrolling lives on the wrapping element the caller provides (e.g. a Card with
 * `overflow-auto`); the header's `sticky top-0` then pins within that scroller.
 * Motion is limited to color transitions — reduced-motion safe by construction.
 */

export type SortDirection = 'asc' | 'desc';

/* ── Root ─────────────────────────────────────────────────────────────────── */

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full border-separate border-spacing-0 text-sm', className)}
      {...rest}
    />
  );
}

/* ── Header ───────────────────────────────────────────────────────────────── */

/** Sticky, frosted header band. Sits inside a scrolling container and pins to
 *  its top edge; a hairline bottom border carries through on scroll. */
export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'sticky top-0 z-10 [&_th]:bg-surface-overlay/85 [&_th]:backdrop-blur-md',
        className,
      )}
      {...rest}
    />
  );
}

export type TextAlign = 'left' | 'right' | 'center';

const ALIGN: Record<TextAlign, string> = {
  left: 'text-left justify-start',
  right: 'text-right justify-end',
  center: 'text-center justify-center',
};

export interface THProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> {
  align?: TextAlign;
  /** Render the sort affordance. When set, the cell becomes a button. */
  sortable?: boolean;
  /** The active sort direction for THIS column, or null when it isn't the sort key. */
  sortDirection?: SortDirection | null;
  /** Fired when a sortable header is activated (click / Enter / Space). */
  onSort?: () => void;
}

/** A header cell. Pass `sortable` + `sortDirection` + `onSort` to make it a
 *  keyboard-operable sort toggle with the conventional chevron states. */
export function TH({
  align = 'left',
  sortable,
  sortDirection = null,
  onSort,
  className,
  children,
  ...rest
}: THProps) {
  const base = cn(
    'h-10 border-b border-[rgb(var(--co-edge))] px-3 align-middle',
    'text-[11px] font-semibold uppercase tracking-wider text-tertiary',
    'first:pl-4 last:pr-4',
    ALIGN[align],
  );

  if (!sortable) {
    return (
      <th scope="col" className={cn(base, className)} {...rest}>
        {children}
      </th>
    );
  }

  const active = sortDirection !== null;
  const SortIcon = sortDirection === 'asc' ? ChevronUp : sortDirection === 'desc' ? ChevronDown : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none'}
      className={cn(base, 'p-0', className)}
      {...rest}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'group/sort inline-flex h-10 w-full items-center gap-1.5 px-3 first:pl-4 last:pr-4',
          'text-[11px] font-semibold uppercase tracking-wider',
          'transition-colors duration-fast ease-token',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
          active ? 'text-secondary' : 'text-tertiary hover:text-secondary',
          ALIGN[align],
        )}
      >
        {align === 'right' && <SortAffordance Icon={SortIcon} active={active} />}
        <span>{children}</span>
        {align !== 'right' && <SortAffordance Icon={SortIcon} active={active} />}
      </button>
    </th>
  );
}

function SortAffordance({ Icon, active }: { Icon: typeof ChevronsUpDown; active: boolean }) {
  return (
    <Icon
      className={cn(
        'h-3.5 w-3.5 shrink-0 transition-opacity duration-fast',
        active ? 'text-accent opacity-100' : 'opacity-0 group-hover/sort:opacity-60',
      )}
      strokeWidth={2.5}
      aria-hidden
    />
  );
}

/* ── Body ─────────────────────────────────────────────────────────────────── */

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        // Zebra + hover, applied to body rows so the header is exempt. The hover
        // tint wins over the zebra base.
        '[&_tr:nth-child(even)>td]:bg-surface-raised/40',
        '[&_tr:hover>td]:bg-surface-overlay/70',
        '[&_td]:transition-colors [&_td]:duration-fast',
        className,
      )}
      {...rest}
    />
  );
}

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Hint that the row is activatable (cursor + group for child hover styles). */
  interactive?: boolean;
}

export function TR({ interactive, className, ...rest }: TRProps) {
  return (
    <tr
      className={cn('group/row', interactive && 'cursor-pointer', className)}
      {...rest}
    />
  );
}

export interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: TextAlign;
  /** Tabular monospace — for money / ids that should column-align. */
  mono?: boolean;
}

export function TD({ align = 'left', mono, className, children, ...rest }: TDProps) {
  return (
    <td
      className={cn(
        'border-b border-subtle px-3 py-2.5 align-middle text-secondary',
        'first:pl-4 last:pr-4',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        mono && 'font-mono tabular-nums',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** A full-width row used for empty / status states inside a populated table. */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="border-b border-subtle px-4 py-12 text-center text-sm text-tertiary">
        {children}
      </td>
    </tr>
  );
}

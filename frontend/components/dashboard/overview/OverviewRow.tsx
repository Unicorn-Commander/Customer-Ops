'use client';

/* =============================================================================
   OverviewRow — a deep-linking table row for the command-center surfaces.
   -----------------------------------------------------------------------------
   Every row on an overview page belongs to a customer and OPENS that customer's
   360. This mirrors RelationshipsTable exactly: a stretched <Link> overlay makes
   the whole row a generous click target (without hijacking text selection in the
   data cells), the identity cell carries an avatar + name + sub, and a trailing
   ChevronRight cue brightens on row hover so the "open profile" affordance reads.
   ========================================================================== */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { TR, TD } from '@/components/ui/Table';

/** The whole-row 360 deep-link + the identity (avatar + name + sub) cell, then
 *  the caller's data cells, then a trailing chevron column. */
export function OverviewRow({
  customerId,
  name,
  sub,
  children,
}: {
  customerId: string;
  name: string;
  /** Secondary identity line (org / email), if any. */
  sub?: string | null;
  /** The data <TD> cells for this row (rendered between identity + chevron). */
  children: ReactNode;
}) {
  const href = `/dashboard/customers/${customerId}`;
  return (
    <TR>
      {/* Contact identity — the row's primary link. A stretched overlay link
          makes the whole row clickable while keeping it a real <a>. */}
      <TD className="relative cursor-pointer">
        <Link href={href} className="absolute inset-0 z-0 focus-visible:outline-none" aria-label={`Open ${name}`} tabIndex={-1} />
        <div className="relative z-[1] flex items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-overlay text-[11px] font-bold text-secondary">
            {initials(name)}
          </span>
          <div className="min-w-0">
            <Link
              href={href}
              className="block truncate font-medium text-primary outline-none transition-colors hover:text-accent focus-visible:text-accent"
            >
              {name}
            </Link>
            {sub && <div className="truncate text-xs text-tertiary">{sub}</div>}
          </div>
        </div>
      </TD>

      {children}

      {/* Open-profile cue — brightens on row hover; the stretched link does the work. */}
      <TD align="right" className="w-10">
        <ChevronRight
          className="ml-auto h-4 w-4 text-muted opacity-50 transition-all duration-fast ease-token group-hover/row:translate-x-0.5 group-hover/row:text-accent group-hover/row:opacity-100"
          strokeWidth={2.5}
          aria-hidden
        />
      </TD>
    </TR>
  );
}

/** Compact name initials, mirroring RelationshipsTable. */
function initials(name: string): string {
  const parts = name.replace(/[…]/g, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

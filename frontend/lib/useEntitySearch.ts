'use client';

/**
 * useEntitySearch — lazily load the workspace's relationships ONCE so the ⌘K
 * palette can search live entities (people / orgs) alongside its static commands.
 *
 * Contract (mirrors the rest of the cockpit's data posture):
 *   • Lazy + once. The rows are fetched the first time the palette opens
 *     (`active` flips true) and cached in a module-lifetime ref, so re-opening
 *     the palette never re-fetches. The fetch is resolved through the same
 *     membership-derived workspace id every other surface uses
 *     (`resolveWorkspaceId` → `listCustomers`); Customer-Ops never mints one.
 *   • Degrade silently. No workspace, or any fetch error, resolves to an empty
 *     set — the palette simply shows commands only, never an error. Entity search
 *     is purely additive.
 *   • Presentational only. This hook owns loading + caching; it does NOT rank or
 *     filter. The palette scores the returned rows through its own fuzzy matcher
 *     so entity results rank and interleave with commands in one uniform pass.
 *
 * `loaded` lets the caller distinguish "still loading" from "loaded, but empty"
 * for an honest, flicker-free Results affordance.
 */

import { useEffect, useRef, useState } from 'react';
import { resolveWorkspaceId, listCustomers, type CustomerRow } from './customers';

export interface EntitySearchState {
  /** The cached relationship rows (empty until the first load resolves / on degrade). */
  rows: CustomerRow[];
  /** True once the first load settles (success OR silent-degrade) — never resets. */
  loaded: boolean;
}

export function useEntitySearch(active: boolean): EntitySearchState {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Guards a single in-flight / completed fetch across open→close→open cycles.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const ws = await resolveWorkspaceId();
        if (cancelled) return;
        if (!ws) {
          // No workspace membership yet → commands-only, silently.
          setLoaded(true);
          return;
        }
        const fetched = await listCustomers(ws);
        if (cancelled) return;
        // Lost relationships stay out of quick-jump (they're archived, not active).
        setRows(fetched.filter((r) => !r.isLost));
      } catch {
        // Degrade clean: any failure → commands-only.
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active]);

  return { rows, loaded };
}

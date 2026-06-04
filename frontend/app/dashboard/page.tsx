'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, MyWorkspace } from '@/lib/api';

/**
 * Dashboard overview. Lists the caller's membership-derived workspaces (proving
 * the tenancy wiring end-to-end) and points into the Phase 2 cockpit — the
 * relationship list, the pipeline board, and (via a relationship) the
 * customer-360.
 */
export default function DashboardHome() {
  const [workspaces, setWorkspaces] = useState<MyWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces')
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => setError('Could not load workspaces.'));
  }, []);

  return (
    <>
      <div className="co-panel">
        <h2 className="co-title" style={{ fontSize: 18 }}>
          Welcome to Customer-Ops
        </h2>
        <p className="co-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
          The relationship / funnel cockpit. Work the lifecycle — lead → prospect
          → customer — in one place. Contacts are federated from Contact-Ops; the
          relationship and its lifecycle stage live here. Invoicing, meetings, and
          email surfaces fold in next.
        </p>
        <div className="co-row" style={{ gap: 8, marginTop: 16 }}>
          <Link className="co-btn co-btn--sm" href="/dashboard/customers" style={{ textDecoration: 'none' }}>
            Relationships
          </Link>
          <Link
            className="co-btn co-btn--sm co-btn--ghost"
            href="/dashboard/pipeline"
            style={{ textDecoration: 'none' }}
          >
            Pipeline board
          </Link>
        </div>
      </div>

      <div className="co-panel">
        <div className="co-row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Your workspaces</h3>
          <span className="co-tag">membership-gated</span>
        </div>
        <div style={{ marginTop: 16 }}>
          {error && <p className="co-error">{error}</p>}
          {!error && workspaces === null && <p className="co-muted">Loading…</p>}
          {!error && workspaces !== null && workspaces.length === 0 && (
            <p className="co-muted">
              No workspace membership yet. (With tenancy enabled, an allow-listed
              user is seeded into the bootstrap workspace on first sign-in.)
            </p>
          )}
          {!error &&
            workspaces?.map((w) => (
              <div
                key={w.workspace_id}
                className="co-row"
                style={{
                  justifyContent: 'space-between',
                  padding: '10px 0',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{w.display_name}</div>
                  <div className="co-muted" style={{ fontSize: 12 }}>
                    {w.slug}
                    {w.is_default ? ' · default' : ''}
                  </div>
                </div>
                <span className="co-tag">{w.role}</span>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

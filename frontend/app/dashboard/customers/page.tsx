'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  contactLabel,
  CustomerRow,
  createCustomer,
  listCustomers,
  money,
  Stage,
  STAGES,
  STAGE_LABEL,
} from '@/lib/customers';
import { PriorityTag, StageBadge } from '@/components/Badges';

/**
 * Relationships list — every customer relationship in the workspace, filterable
 * by funnel stage, with a quick-create. Contact names are FEDERATED from
 * Contact-Ops by the backend (shown as a placeholder when CO is dormant).
 */
export default function CustomersPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [stage, setStage] = useState<Stage | 'ALL'>('ALL');
  const [includeLost, setIncludeLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newContactId, setNewContactId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const items = await listCustomers(workspaceId, {
        stage: stage === 'ALL' ? undefined : stage,
        includeLost,
      });
      setRows(items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId, stage, includeLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async () => {
    if (!workspaceId || !newContactId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomer(workspaceId, { contactId: newContactId.trim() });
      setNewContactId('');
      setCreating(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="co-pagehead">
        <div>
          <h1>Relationships</h1>
          <p>
            The customer lifecycle — lead → prospect → customer. Contacts are
            federated from Contact-Ops; the relationship + stage live here.
          </p>
        </div>
        <button className="co-btn co-btn--sm" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ New relationship'}
        </button>
      </div>

      {creating && (
        <div className="co-panel">
          <div className="co-field">
            <label>Contact-Ops contact id</label>
            <input
              className="co-input"
              placeholder="person_id from Contact-Ops (federated; not copied)"
              value={newContactId}
              onChange={(e) => setNewContactId(e.target.value)}
            />
          </div>
          <button className="co-btn co-btn--sm" disabled={busy || !newContactId.trim()} onClick={submitCreate}>
            {busy ? 'Creating…' : 'Create as Lead'}
          </button>
        </div>
      )}

      <div className="co-panel">
        <div className="co-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="co-row" style={{ gap: 8 }}>
            <button
              className={`co-btn co-btn--sm ${stage === 'ALL' ? '' : 'co-btn--ghost'}`}
              onClick={() => setStage('ALL')}
            >
              All
            </button>
            {STAGES.map((s) => (
              <button
                key={s}
                className={`co-btn co-btn--sm ${stage === s ? '' : 'co-btn--ghost'}`}
                onClick={() => setStage(s)}
              >
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
          <label className="co-row co-muted" style={{ gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeLost}
              onChange={(e) => setIncludeLost(e.target.checked)}
            />
            Show lost
          </label>
        </div>

        {(wsError || error) && <p className="co-error">{wsError || error}</p>}
        {!wsError && !error && (wsLoading || rows === null) && <p className="co-muted">Loading…</p>}
        {!wsError && !error && rows !== null && rows.length === 0 && (
          <p className="co-empty">No relationships in this stage yet.</p>
        )}

        {rows && rows.length > 0 && (
          <table className="co-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Stage</th>
                <th>Priority</th>
                <th>Value</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{contactLabel(r)}</div>
                    <div className="co-muted" style={{ fontSize: 12 }}>
                      {r.contact?.primaryEmail ?? r.contact?.currentOrgName ?? r.contactId}
                    </div>
                  </td>
                  <td>
                    <StageBadge stage={r.stage} lost={r.isLost} />
                  </td>
                  <td>
                    <PriorityTag priority={r.priority} />
                  </td>
                  <td>{money(r.expectedValue, r.currency ?? 'USD')}</td>
                  <td className="co-muted">{r.source ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link className="co-link" href={`/dashboard/customers/${r.id}`}>
                      Open 360 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

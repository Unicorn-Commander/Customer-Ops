'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  addNote,
  Customer360,
  getCustomer360,
  markLost,
  money,
  reopen,
  Stage,
  STAGES,
  STAGE_LABEL,
  transitionStage,
} from '@/lib/customers';
import { PriorityTag, StageBadge } from '@/components/Badges';

/**
 * Customer-360 — the relationship cockpit's detail view. Stitches:
 *   - the LOCAL relationship (stage, priority, value, owner) + controls,
 *   - the FEDERATED Contact-Ops contact (name, emails, phones, org, tags) —
 *     resolved by the backend at read time, NEVER copied; a placeholder when CO
 *     is dormant,
 *   - the activity timeline (stage changes / notes), and
 *   - the Phase-3 federation slots (invoices/meetings/email — empty seams).
 */
export default function Customer360Page() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { workspaceId, error: wsError } = useWorkspace();
  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      setData(await getCustomer360(workspaceId, id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const doTransition = async (to: Stage) => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await transitionStage(workspaceId, id, to);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doLost = async () => {
    if (!workspaceId) return;
    const reason = window.prompt('Reason for marking this relationship lost?');
    if (!reason) return;
    setBusy(true);
    try {
      await markLost(workspaceId, id, reason);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doReopen = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await reopen(workspaceId, id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async () => {
    if (!workspaceId || !note.trim()) return;
    setBusy(true);
    try {
      await addNote(workspaceId, id, note.trim());
      setNote('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (wsError) return <p className="co-error">{wsError}</p>;
  if (!data && !error) return <p className="co-muted">Loading…</p>;
  if (error && !data) return <p className="co-error">{error}</p>;
  if (!data) return null;

  const { relationship: rel, contact, contactFederation, timeline } = data;

  return (
    <>
      <div className="co-pagehead">
        <div>
          <Link className="co-link" href="/dashboard/customers">
            ← Relationships
          </Link>
          <h1 style={{ marginTop: 6 }}>
            {contact?.displayName ?? `Contact ${rel.contactId.slice(0, 8)}…`}
          </h1>
          <p>
            <StageBadge stage={rel.stage} lost={rel.isLost} /> &nbsp;
            <PriorityTag priority={rel.priority} /> &nbsp;
            {money(rel.expectedValue, rel.currency ?? 'USD')}
          </p>
        </div>
      </div>

      {error && <p className="co-error">{error}</p>}

      <div className="co-360">
        {/* LEFT: relationship + contact + timeline */}
        <div>
          {/* Stage controls */}
          <div className="co-panel">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Lifecycle</h3>
            <div className="co-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {STAGES.map((s) => (
                <button
                  key={s}
                  className={`co-btn co-btn--sm ${rel.stage === s ? '' : 'co-btn--ghost'}`}
                  disabled={busy || rel.stage === s || rel.isLost}
                  onClick={() => doTransition(s)}
                  title={
                    rel.isLost
                      ? 'Re-open before moving stage'
                      : `Move to ${STAGE_LABEL[s]} (funnel rules enforced)`
                  }
                >
                  {STAGE_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="co-row" style={{ gap: 8 }}>
              {rel.isLost ? (
                <button className="co-btn co-btn--sm" disabled={busy} onClick={doReopen}>
                  Re-open
                </button>
              ) : (
                <button className="co-btn co-btn--sm co-btn--ghost" disabled={busy} onClick={doLost}>
                  Mark lost
                </button>
              )}
            </div>
            {rel.isLost && rel.lostReason && (
              <p className="co-muted" style={{ marginTop: 10 }}>
                Lost: {rel.lostReason}
              </p>
            )}
          </div>

          {/* Federated contact */}
          <div className="co-panel">
            <div className="co-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Contact</h3>
              <span className="co-tag">
                {contactFederation.resolved ? 'federated · contact-ops' : 'contact-ops · unavailable'}
              </span>
            </div>
            {contact ? (
              <dl className="co-deflist" style={{ marginTop: 14 }}>
                <dt>Name</dt>
                <dd>{contact.displayName}</dd>
                {contact.currentOrgName && (
                  <>
                    <dt>Org</dt>
                    <dd>{contact.currentOrgName}</dd>
                  </>
                )}
                <dt>Email</dt>
                <dd>
                  {contact.emails?.length
                    ? contact.emails.map((e) => e.address).join(', ')
                    : (contact.primaryEmail ?? '—')}
                </dd>
                <dt>Phone</dt>
                <dd>{contact.phones?.length ? contact.phones.map((p) => p.e164).join(', ') : '—'}</dd>
                {contact.tags?.length > 0 && (
                  <>
                    <dt>Tags</dt>
                    <dd>
                      {contact.tags.map((t) => (
                        <span key={t} className="co-tag" style={{ marginRight: 6 }}>
                          {t}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="co-muted" style={{ marginTop: 12 }}>
                Contact details are federated from Contact-Ops and aren’t available
                right now. The relationship (contactId{' '}
                <code>{rel.contactId}</code>) is unaffected — Customer-Ops holds the
                reference, never a copy.
              </p>
            )}
          </div>

          {/* Timeline */}
          <div className="co-panel">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Timeline</h3>
            <div className="co-field" style={{ marginTop: 8 }}>
              <textarea
                className="co-input"
                rows={2}
                placeholder="Add a note to the relationship timeline…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <button className="co-btn co-btn--sm" disabled={busy || !note.trim()} onClick={submitNote}>
              Add note
            </button>
            <ul className="co-timeline" style={{ marginTop: 18 }}>
              {timeline.length === 0 && <p className="co-empty">No activity yet.</p>}
              {timeline.map((t) => (
                <li key={t.id}>
                  <div className="co-timeline__kind">{t.kind.replace(/_/g, ' ')}</div>
                  <div className="co-timeline__body">
                    {t.body ??
                      (t.fromStage && t.toStage ? `${t.fromStage} → ${t.toStage}` : '—')}
                  </div>
                  <div className="co-timeline__time">{new Date(t.createdAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* RIGHT: relationship facts + Phase-3 federation slots */}
        <div>
          <div className="co-panel">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Relationship</h3>
            <dl className="co-deflist" style={{ marginTop: 12 }}>
              <dt>Stage</dt>
              <dd>
                <StageBadge stage={rel.stage} lost={rel.isLost} />
              </dd>
              <dt>Priority</dt>
              <dd>
                <PriorityTag priority={rel.priority} />
              </dd>
              <dt>Value</dt>
              <dd>{money(rel.expectedValue, rel.currency ?? 'USD')}</dd>
              <dt>Owner</dt>
              <dd>{rel.ownerUserKey ?? 'Unassigned'}</dd>
              <dt>Source</dt>
              <dd>{rel.source ?? '—'}</dd>
              <dt>Next action</dt>
              <dd>{rel.nextActionAt ? new Date(rel.nextActionAt).toLocaleDateString() : '—'}</dd>
              <dt>Stage since</dt>
              <dd>{new Date(rel.lastStageChangeAt).toLocaleDateString()}</dd>
            </dl>
          </div>

          <div className="co-panel">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Connected (Phase 3)</h3>
            <p className="co-muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 13 }}>
              These surfaces federate from their own engines. The seams are wired;
              the data plane lands in Phase 3.
            </p>
            <div className="co-slot">
              <span>Invoices &amp; AR</span>
              <span className="co-tag">accounting-ops</span>
            </div>
            <div className="co-slot">
              <span>Meetings &amp; action items</span>
              <span className="co-tag">meeting-ops</span>
            </div>
            <div className="co-slot">
              <span>Email threads</span>
              <span className="co-tag">email-ops</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

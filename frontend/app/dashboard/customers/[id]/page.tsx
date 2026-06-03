'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  addNote,
  createInvoice,
  CreateInvoiceInput,
  Customer360,
  EmailPanel,
  emailStatusLabel,
  getCustomer360,
  InvoicePanel,
  invoiceStatusLabel,
  markLost,
  money,
  OutreachPanel,
  outreachStatusLabel,
  reopen,
  sendEmail,
  SendEmailInput,
  Stage,
  startCampaign,
  StartCampaignInput,
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
 *   - the activity timeline (stage changes / notes),
 *   - the Phase-3 Accounting-Ops invoice panel (federated), and
 *   - the Phase-4 Outreach + Email-Ops panels (federated; campaigns/touches +
 *     start-campaign, mailbox threads + send/draft), with degrade-clean +
 *     entitlement affordances. Meeting-Ops remains the one empty seam.
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

  const { relationship: rel, contact, contactFederation, timeline, invoices, outreach, email } =
    data;

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

          {/* Phase 3: the federated Accounting-Ops invoice panel */}
          <InvoicesPanel
            workspaceId={workspaceId}
            customerId={id}
            initial={invoices}
            customerName={contact?.displayName ?? `Contact ${rel.contactId.slice(0, 8)}`}
            customerEmail={contact?.primaryEmail ?? undefined}
            currency={rel.currency ?? 'USD'}
            onChanged={load}
          />

          {/* Phase 4: the federated Email-Ops mailbox panel */}
          <EmailPanelView
            workspaceId={workspaceId}
            customerId={id}
            initial={email}
            defaultToAddress={contact?.primaryEmail ?? undefined}
            onChanged={load}
          />

          {/* Phase 4: the federated Outreach campaigns/touches panel */}
          <OutreachPanelView
            workspaceId={workspaceId}
            customerId={id}
            initial={outreach}
            onChanged={load}
          />

          {/* The one remaining federation seam (later phase) */}
          <div className="co-panel">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Connected (next phase)</h3>
            <p className="co-muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 13 }}>
              This surface federates from its own engine. The seam is wired; the
              data plane lands in a later phase.
            </p>
            <div className="co-slot">
              <span>Meetings &amp; action items</span>
              <span className="co-tag">meeting-ops</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The Accounting-Ops invoice panel of the customer-360. Renders the FEDERATED
 * invoice list (live status polled by the backend), with degrade-clean /
 * entitlement affordances, and a "create invoice" action when entitled. AO is
 * the AR engine / ledger system-of-record; this UI never posts a ledger entry —
 * it assembles a draft and asks the backend to create it in Accounting-Ops.
 */
function InvoicesPanel(props: {
  workspaceId: string | null;
  customerId: string;
  initial: InvoicePanel;
  customerName: string;
  customerEmail?: string;
  currency: string;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, initial, customerName, customerEmail, currency } = props;
  const [panel, setPanel] = useState<InvoicePanel>(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep in sync when the parent reloads the 360.
  useEffect(() => setPanel(initial), [initial]);

  const tone = (t: string): string =>
    t === 'ok'
      ? 'co-tag co-tag--ok'
      : t === 'warn'
        ? 'co-tag co-tag--warn'
        : t === 'info'
          ? 'co-tag'
          : 'co-tag co-tag--muted';

  return (
    <div className="co-panel">
      <div className="co-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Invoices &amp; AR</h3>
        <span className="co-tag">
          {panel.configured ? 'federated · accounting-ops' : 'accounting-ops · not connected'}
        </span>
      </div>

      {!panel.configured ? (
        <p className="co-muted" style={{ marginTop: 12 }}>
          Connect Accounting-Ops to invoice this customer. Invoicing is federated
          to Accounting-Ops (the AR engine) — Customer-Ops never holds the ledger.
        </p>
      ) : (
        <>
          {panel.items.length === 0 ? (
            <p className="co-muted" style={{ marginTop: 12, marginBottom: 8 }}>
              No invoices yet for this customer.
            </p>
          ) : (
            <ul className="co-invoices" style={{ marginTop: 12, marginBottom: 8 }}>
              {panel.items.map((inv) => {
                const s = invoiceStatusLabel(inv.status);
                return (
                  <li
                    key={inv.id}
                    className="co-row"
                    style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                  >
                    <span>
                      <strong>{inv.invoiceNumber ?? inv.externalRef}</strong>
                      <span className="co-muted" style={{ marginLeft: 8 }}>
                        {money(inv.total, inv.currency)}
                        {inv.balanceDue && inv.status !== 'paid'
                          ? ` · ${money(inv.balanceDue, inv.currency)} due`
                          : ''}
                      </span>
                    </span>
                    <span className={tone(s.tone)}>{s.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {panel.canCreate ? (
            !open ? (
              <button className="co-btn co-btn--sm" onClick={() => setOpen(true)}>
                Create invoice
              </button>
            ) : (
              <InvoiceForm
                defaultCustomerName={customerName}
                defaultCustomerEmail={customerEmail}
                defaultCurrency={currency}
                busy={busy}
                error={err}
                onCancel={() => {
                  setOpen(false);
                  setErr(null);
                }}
                onSubmit={async (body) => {
                  if (!workspaceId) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    await createInvoice(workspaceId, customerId, body);
                    setOpen(false);
                    await props.onChanged();
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )
          ) : (
            <p className="co-muted" style={{ marginTop: 8, fontSize: 13 }}>
              Invoicing requires both the Customer-Ops and Accounting-Ops
              entitlements. Existing invoices are shown read-only.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The minimal create-invoice form: entity, a line item, and optional terms. */
function InvoiceForm(props: {
  defaultCustomerName: string;
  defaultCustomerEmail?: string;
  defaultCurrency: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: CreateInvoiceInput) => void | Promise<void>;
}) {
  const [entityId, setEntityId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [dueDate, setDueDate] = useState('');

  const canSubmit =
    entityId.trim().length > 0 &&
    description.trim().length > 0 &&
    unitPrice.trim().length > 0 &&
    !props.busy;

  return (
    <div className="co-field" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
      {props.error && <p className="co-error">{props.error}</p>}
      <input
        className="co-input"
        placeholder="Accounting-Ops entity id (UUID)"
        value={entityId}
        onChange={(e) => setEntityId(e.target.value)}
      />
      <input
        className="co-input"
        placeholder="Line description (e.g. Consulting — June)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="co-row" style={{ gap: 8 }}>
        <input
          className="co-input"
          style={{ flex: 1 }}
          placeholder="Qty"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <input
          className="co-input"
          style={{ flex: 2 }}
          placeholder="Unit price (e.g. 150.00)"
          value={unitPrice}
          onChange={(e) => setUnitPrice(e.target.value)}
        />
      </div>
      <input
        className="co-input"
        placeholder="Due date (YYYY-MM-DD, optional)"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
      />
      <div className="co-row" style={{ gap: 8 }}>
        <button
          className="co-btn co-btn--sm"
          disabled={!canSubmit}
          onClick={() =>
            props.onSubmit({
              entityId: entityId.trim(),
              customerName: props.defaultCustomerName,
              customerEmail: props.defaultCustomerEmail,
              currency: props.defaultCurrency,
              dueDate: dueDate.trim() || undefined,
              lineItems: [
                {
                  description: description.trim(),
                  quantity: quantity.trim() || '1',
                  unitPrice: unitPrice.trim(),
                },
              ],
            })
          }
        >
          {props.busy ? 'Creating…' : 'Send to Accounting-Ops'}
        </button>
        <button className="co-btn co-btn--sm co-btn--ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Map a status tone to the design-system tag class (shared by Phase-4 panels). */
function toneClass(t: string): string {
  return t === 'ok'
    ? 'co-tag co-tag--ok'
    : t === 'warn'
      ? 'co-tag co-tag--warn'
      : t === 'info'
        ? 'co-tag'
        : 'co-tag co-tag--muted';
}

/**
 * The Email-Ops mailbox panel of the customer-360. Renders the FEDERATED mailbox
 * threads with the contact (live, by the backend) + the local outbound links,
 * with degrade-clean / entitlement affordances, and a "send / draft" action when
 * entitled. Email-Ops (Stalwart) is the mailbox system-of-record; this UI never
 * stores a message — it asks the backend to send/draft via the Email-Ops app.
 */
function EmailPanelView(props: {
  workspaceId: string | null;
  customerId: string;
  initial: EmailPanel;
  defaultToAddress?: string;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, initial, defaultToAddress } = props;
  const [panel, setPanel] = useState<EmailPanel>(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setPanel(initial), [initial]);

  return (
    <div className="co-panel">
      <div className="co-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Email</h3>
        <span className="co-tag">
          {panel.configured ? 'federated · email-ops' : 'email-ops · not connected'}
        </span>
      </div>

      {!panel.configured ? (
        <p className="co-muted" style={{ marginTop: 12 }}>
          Connect Email-Ops to see this contact’s mailbox threads and send mail.
          Mailboxes are federated to Email-Ops (the Stalwart mail surface) —
          Customer-Ops never stores message content.
        </p>
      ) : (
        <>
          {panel.threads.length === 0 && panel.sent.length === 0 ? (
            <p className="co-muted" style={{ marginTop: 12, marginBottom: 8 }}>
              No email threads with this contact yet.
            </p>
          ) : (
            <ul className="co-invoices" style={{ marginTop: 12, marginBottom: 8 }}>
              {panel.threads.map((t) => (
                <li
                  key={t.id}
                  className="co-row"
                  style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                >
                  <span>
                    <strong>{t.subject ?? '(no subject)'}</strong>
                    <span className="co-muted" style={{ marginLeft: 8 }}>
                      {t.messageCount} msg{t.messageCount === 1 ? '' : 's'}
                      {t.lastSnippet ? ` · ${t.lastSnippet}` : ''}
                    </span>
                  </span>
                  {t.unread && <span className="co-tag co-tag--warn">Unread</span>}
                </li>
              ))}
              {/* Local outbound links we initiated (de-dupe memory + status). */}
              {panel.sent.map((m) => {
                const s = emailStatusLabel(m.status);
                return (
                  <li
                    key={m.id}
                    className="co-row"
                    style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                  >
                    <span>
                      <strong>{m.subject ?? m.externalRef}</strong>
                      <span className="co-muted" style={{ marginLeft: 8 }}>
                        {m.mode === 'draft' ? 'drafted' : 'sent'}
                      </span>
                    </span>
                    <span className={toneClass(s.tone)}>{s.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {panel.canSend ? (
            !open ? (
              <button className="co-btn co-btn--sm" onClick={() => setOpen(true)}>
                Send email
              </button>
            ) : (
              <EmailForm
                defaultToAddress={defaultToAddress}
                busy={busy}
                error={err}
                onCancel={() => {
                  setOpen(false);
                  setErr(null);
                }}
                onSubmit={async (body) => {
                  if (!workspaceId) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    await sendEmail(workspaceId, customerId, body);
                    setOpen(false);
                    await props.onChanged();
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )
          ) : (
            <p className="co-muted" style={{ marginTop: 8, fontSize: 13 }}>
              Sending requires both the Customer-Ops and Email-Ops entitlements.
              Mailbox threads are shown read-only.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The minimal compose form: to, subject, body, and send-vs-draft. */
function EmailForm(props: {
  defaultToAddress?: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: SendEmailInput) => void | Promise<void>;
}) {
  const [toAddress, setToAddress] = useState(props.defaultToAddress ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const canSubmit = subject.trim().length > 0 && body.trim().length > 0 && !props.busy;

  return (
    <div className="co-field" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
      {props.error && <p className="co-error">{props.error}</p>}
      <input
        className="co-input"
        placeholder="To (defaults to the contact’s primary email)"
        value={toAddress}
        onChange={(e) => setToAddress(e.target.value)}
      />
      <input
        className="co-input"
        placeholder="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className="co-input"
        rows={4}
        placeholder="Message…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="co-row" style={{ gap: 8 }}>
        <button
          className="co-btn co-btn--sm"
          disabled={!canSubmit}
          onClick={() =>
            props.onSubmit({
              toAddress: toAddress.trim() || undefined,
              subject: subject.trim(),
              body: body.trim(),
              mode: 'send',
            })
          }
        >
          {props.busy ? 'Sending…' : 'Send now'}
        </button>
        <button
          className="co-btn co-btn--sm co-btn--ghost"
          disabled={!canSubmit}
          onClick={() =>
            props.onSubmit({
              toAddress: toAddress.trim() || undefined,
              subject: subject.trim(),
              body: body.trim(),
              mode: 'draft',
            })
          }
          title="Stage in the Email-Ops agent-inbox approval surface"
        >
          Save as draft
        </button>
        <button className="co-btn co-btn--sm co-btn--ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The Outreach panel of the customer-360. Renders the FEDERATED outreach touches
 * for the contact (live, by the backend) + the live campaign picker + the local
 * enrollment links, with degrade-clean / entitlement affordances, and a "start
 * campaign" action when entitled. Outreach (Listmonk + Postiz) is the campaign
 * system-of-record; this UI never sends a campaign — it asks the backend to
 * enroll the contact via the Outreach app.
 */
function OutreachPanelView(props: {
  workspaceId: string | null;
  customerId: string;
  initial: OutreachPanel;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, initial } = props;
  const [panel, setPanel] = useState<OutreachPanel>(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setPanel(initial), [initial]);

  return (
    <div className="co-panel">
      <div className="co-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Outreach</h3>
        <span className="co-tag">
          {panel.configured ? 'federated · outreach' : 'outreach · not connected'}
        </span>
      </div>

      {!panel.configured ? (
        <p className="co-muted" style={{ marginTop: 12 }}>
          Connect Outreach to run email campaigns and social touches for this
          contact. Campaigns are federated to Outreach (Listmonk + Postiz) —
          Customer-Ops never holds a recipient list or sends a campaign.
        </p>
      ) : (
        <>
          {panel.touches.length === 0 && panel.enrollments.length === 0 ? (
            <p className="co-muted" style={{ marginTop: 12, marginBottom: 8 }}>
              No outreach touches for this contact yet.
            </p>
          ) : (
            <ul className="co-invoices" style={{ marginTop: 12, marginBottom: 8 }}>
              {panel.touches.map((t) => {
                const s = outreachStatusLabel(t.status);
                return (
                  <li
                    key={t.id}
                    className="co-row"
                    style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                  >
                    <span>
                      <strong>{t.campaignName ?? t.subject ?? `${t.channel} touch`}</strong>
                      <span className="co-muted" style={{ marginLeft: 8 }}>
                        {t.channel}
                        {t.lastEngagementKind ? ` · ${t.lastEngagementKind}` : ''}
                      </span>
                    </span>
                    <span className={toneClass(s.tone)}>{s.label}</span>
                  </li>
                );
              })}
              {/* Local enrollment links we initiated (de-dupe memory + status). */}
              {panel.enrollments.map((en) => {
                const s = outreachStatusLabel(en.status);
                return (
                  <li
                    key={en.id}
                    className="co-row"
                    style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                  >
                    <span>
                      <strong>{en.campaignName ?? en.externalRef}</strong>
                      <span className="co-muted" style={{ marginLeft: 8 }}>
                        {en.channel} · enrolled
                      </span>
                    </span>
                    <span className={toneClass(s.tone)}>{s.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {panel.canStart ? (
            !open ? (
              <button className="co-btn co-btn--sm" onClick={() => setOpen(true)}>
                Start campaign
              </button>
            ) : (
              <CampaignForm
                campaigns={panel.campaigns}
                busy={busy}
                error={err}
                onCancel={() => {
                  setOpen(false);
                  setErr(null);
                }}
                onSubmit={async (body) => {
                  if (!workspaceId) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    await startCampaign(workspaceId, customerId, body);
                    setOpen(false);
                    await props.onChanged();
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )
          ) : (
            <p className="co-muted" style={{ marginTop: 8, fontSize: 13 }}>
              Starting a campaign requires both the Customer-Ops and Outreach
              entitlements. Outreach history is shown read-only.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The minimal start-campaign form: pick a federated campaign to enroll into. */
function CampaignForm(props: {
  campaigns: OutreachPanel['campaigns'];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: StartCampaignInput) => void | Promise<void>;
}) {
  const [campaignId, setCampaignId] = useState(props.campaigns[0]?.id ?? '');
  const canSubmit = campaignId.trim().length > 0 && !props.busy;

  return (
    <div className="co-field" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
      {props.error && <p className="co-error">{props.error}</p>}
      {props.campaigns.length === 0 ? (
        <p className="co-muted" style={{ fontSize: 13 }}>
          No campaigns are available in the Outreach app yet. Create one in
          Outreach, then enroll this contact here.
        </p>
      ) : (
        <select
          className="co-input"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
        >
          {props.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.channel}
              {c.isSequence ? ' · sequence' : ''})
            </option>
          ))}
        </select>
      )}
      <div className="co-row" style={{ gap: 8 }}>
        <button
          className="co-btn co-btn--sm"
          disabled={!canSubmit}
          onClick={() => props.onSubmit({ campaignId: campaignId.trim() })}
        >
          {props.busy ? 'Enrolling…' : 'Enroll contact'}
        </button>
        <button className="co-btn co-btn--sm co-btn--ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

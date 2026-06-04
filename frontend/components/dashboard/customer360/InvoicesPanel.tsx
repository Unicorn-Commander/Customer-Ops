'use client';

import { useState } from 'react';
import { Receipt, Plus, CircleDollarSign } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  createInvoice,
  invoiceStatusLabel,
  money,
  type CreateInvoiceInput,
  type InvoicePanel,
} from '@/lib/customers';
import {
  ConnectNotice, EmptyRow, EntitlementNotice, ListRow, PanelSection, SourceTag, StatusPill,
} from './shared';
import { FieldInput, FormError } from './forms';

/**
 * Invoices & AR — the FEDERATED Accounting-Ops panel. Lists the customer's
 * invoices with live (backend-polled) status + the open balance, degrades clean
 * when AO is not connected, and offers a create-invoice draft only when entitled.
 * AO is the ledger system-of-record; this UI never posts an entry — it assembles
 * a draft and asks the backend to create it.
 */
export function InvoicesPanel(props: {
  workspaceId: string | null;
  customerId: string;
  panel: InvoicePanel;
  customerName: string;
  customerEmail?: string;
  currency: string;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, panel, customerName, customerEmail, currency } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Total outstanding across non-paid invoices, for the subtitle.
  const outstanding = panel.items.reduce((sum, inv) => {
    if (inv.status === 'paid' || inv.status === 'void') return sum;
    const n = Number(inv.balanceDue ?? inv.total ?? '0');
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  const subtitle = panel.configured
    ? panel.items.length === 0
      ? 'No invoices yet'
      : `${panel.items.length} invoice${panel.items.length === 1 ? '' : 's'}${
          outstanding > 0 ? ` · ${money(String(outstanding), currency)} outstanding` : ''
        }`
    : 'Accounting-Ops';

  return (
    <PanelSection
      icon={Receipt}
      gradient="from-emerald-400 to-teal-500"
      title="Invoices & AR"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="accounting-ops" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="Accounting-Ops">
          Invoicing is federated to Accounting-Ops, the AR engine — Customer-Ops never holds the ledger.
        </ConnectNotice>
      ) : (
        <>
          {panel.items.length === 0 ? (
            <EmptyRow>No invoices for this customer yet.</EmptyRow>
          ) : (
            <ul className="-mx-1 mb-1 space-y-0.5">
              {panel.items.map((inv) => {
                const s = invoiceStatusLabel(inv.status);
                const unpaid = inv.balanceDue && inv.status !== 'paid' && inv.status !== 'void';
                return (
                  <ListRow
                    key={inv.id}
                    title={inv.invoiceNumber ?? inv.externalRef}
                    meta={
                      <span className="tabular-nums">
                        {money(inv.total, inv.currency)}
                        {unpaid ? ` · ${money(inv.balanceDue, inv.currency)} due` : ''}
                      </span>
                    }
                    trailing={<StatusPill status={s} />}
                  />
                );
              })}
            </ul>
          )}

          {panel.canCreate ? (
            !open ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-1"
                leading={<Plus className="h-4 w-4" strokeWidth={2.4} />}
                onClick={() => setOpen(true)}
              >
                Create invoice
              </Button>
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
            <EntitlementNotice>
              Invoicing requires the Customer-Ops + Accounting-Ops entitlements. History is read-only.
            </EntitlementNotice>
          )}
        </>
      )}
    </PanelSection>
  );
}

/** The minimal create-invoice draft form: entity, a line item, optional due date. */
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
    <div className="mt-3 grid gap-2.5 rounded-token border border-subtle bg-surface-overlay/50 p-3">
      <FormError error={props.error} />
      <FieldInput label="Accounting-Ops entity id" placeholder="entity UUID" value={entityId} onChange={setEntityId} />
      <FieldInput label="Line description" placeholder="e.g. Consulting — June" value={description} onChange={setDescription} />
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <FieldInput label="Qty" placeholder="1" value={quantity} onChange={setQuantity} />
        <FieldInput label="Unit price" placeholder="150.00" value={unitPrice} onChange={setUnitPrice} />
      </div>
      <FieldInput label="Due date" placeholder="YYYY-MM-DD (optional)" value={dueDate} onChange={setDueDate} optional />
      <div className="mt-0.5 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!canSubmit}
          leading={<CircleDollarSign className="h-4 w-4" strokeWidth={2.4} />}
          onClick={() =>
            props.onSubmit({
              entityId: entityId.trim(),
              customerName: props.defaultCustomerName,
              customerEmail: props.defaultCustomerEmail,
              currency: props.defaultCurrency,
              dueDate: dueDate.trim() || undefined,
              lineItems: [
                { description: description.trim(), quantity: quantity.trim() || '1', unitPrice: unitPrice.trim() },
              ],
            })
          }
        >
          {props.busy ? 'Creating…' : 'Send to Accounting-Ops'}
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

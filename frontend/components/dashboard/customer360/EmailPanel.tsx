'use client';

import { useState } from 'react';
import { Mail, PenLine, Send, FileText } from 'lucide-react';
import { Button, Badge } from '@/components/ui';
import {
  emailStatusLabel,
  sendEmail,
  type EmailPanel as EmailPanelData,
  type SendEmailInput,
} from '@/lib/customers';
import {
  ConnectNotice, EmptyRow, EntitlementNotice, ListRow, PanelSection, SourceTag, StatusPill,
} from './shared';
import { FieldInput, FieldTextarea, FormError } from './forms';

/**
 * Email — the FEDERATED Email-Ops mailbox panel. Renders the contact's mailbox
 * threads (live, backend-resolved) + the outbound links Customer-Ops initiated,
 * degrades clean when Email-Ops is not connected, and offers send / save-as-draft
 * only when entitled. Email-Ops (Stalwart) is the mailbox SoR; this UI never
 * stores a message — it asks the backend to send/draft.
 */
export function EmailPanel(props: {
  workspaceId: string | null;
  customerId: string;
  panel: EmailPanelData;
  defaultToAddress?: string;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, panel, defaultToAddress } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const empty = panel.threads.length === 0 && panel.sent.length === 0;
  const unread = panel.threads.filter((t) => t.unread).length;
  const subtitle = panel.configured
    ? empty
      ? 'No threads yet'
      : `${panel.threads.length} thread${panel.threads.length === 1 ? '' : 's'}${unread ? ` · ${unread} unread` : ''}`
    : 'Email-Ops · Stalwart';

  return (
    <PanelSection
      icon={Mail}
      gradient="from-sky-400 to-blue-500"
      title="Email"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="email-ops" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="Email-Ops">
          Mailboxes are federated to Email-Ops (the Stalwart mail surface) — Customer-Ops never stores message content.
        </ConnectNotice>
      ) : (
        <>
          {empty ? (
            <EmptyRow>No email threads with this contact yet.</EmptyRow>
          ) : (
            <ul className="-mx-1 mb-1 space-y-0.5">
              {panel.threads.map((t) => (
                <ListRow
                  key={t.id}
                  leadingDot={t.unread ? 'bg-info' : 'bg-[rgb(var(--co-edge))]'}
                  title={t.subject ?? '(no subject)'}
                  meta={
                    <>
                      {t.messageCount} msg{t.messageCount === 1 ? '' : 's'}
                      {t.lastSnippet ? ` · ${t.lastSnippet}` : ''}
                    </>
                  }
                  trailing={t.unread ? <Badge variant="info">Unread</Badge> : undefined}
                />
              ))}
              {/* Outbound links we initiated (de-dupe memory + live status). */}
              {panel.sent.map((m) => {
                const s = emailStatusLabel(m.status);
                return (
                  <ListRow
                    key={m.id}
                    leadingDot="bg-feat-email/70"
                    title={
                      <span className="inline-flex items-center gap-1.5">
                        {m.mode === 'draft' ? (
                          <FileText className="h-3.5 w-3.5 text-tertiary" strokeWidth={2.25} />
                        ) : (
                          <Send className="h-3.5 w-3.5 text-tertiary" strokeWidth={2.25} />
                        )}
                        {m.subject ?? m.externalRef}
                      </span>
                    }
                    meta={m.mode === 'draft' ? 'Drafted by you' : 'Sent by you'}
                    trailing={<StatusPill status={s} />}
                  />
                );
              })}
            </ul>
          )}

          {panel.canSend ? (
            !open ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-1"
                leading={<PenLine className="h-4 w-4" strokeWidth={2.4} />}
                onClick={() => setOpen(true)}
              >
                Compose email
              </Button>
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
            <EntitlementNotice>
              Sending requires the Customer-Ops + Email-Ops entitlements. Threads are read-only.
            </EntitlementNotice>
          )}
        </>
      )}
    </PanelSection>
  );
}

/** The compose form: to, subject, body, and send-now vs save-as-draft. */
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
  const compose = (mode: 'send' | 'draft'): SendEmailInput => ({
    toAddress: toAddress.trim() || undefined,
    subject: subject.trim(),
    body: body.trim(),
    mode,
  });

  return (
    <div className="mt-3 grid gap-2.5 rounded-token border border-subtle bg-surface-overlay/50 p-3">
      <FormError error={props.error} />
      <FieldInput
        label="To"
        type="email"
        placeholder="defaults to the contact's primary email"
        value={toAddress}
        onChange={setToAddress}
        optional
      />
      <FieldInput label="Subject" placeholder="Subject line" value={subject} onChange={setSubject} />
      <FieldTextarea label="Message" placeholder="Write your message…" value={body} onChange={setBody} rows={5} />
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!canSubmit}
          leading={<Send className="h-4 w-4" strokeWidth={2.4} />}
          onClick={() => props.onSubmit(compose('send'))}
        >
          {props.busy ? 'Sending…' : 'Send now'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canSubmit}
          leading={<FileText className="h-4 w-4" strokeWidth={2.4} />}
          title="Stage in the Email-Ops agent-inbox approval surface"
          onClick={() => props.onSubmit(compose('draft'))}
        >
          Save as draft
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

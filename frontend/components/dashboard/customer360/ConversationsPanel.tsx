'use client';

import { useState } from 'react';
import { MessageSquare, Send, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import {
  listConversationMessages,
  sendMessage,
  type ConversationMessage,
  type ConversationsPanel as ConversationsPanelData,
  type SendMessageInput,
} from '@/lib/customers';
import { ConnectNotice, EmptyRow, EntitlementNotice, ListRow, PanelSection, SourceTag } from './shared';
import { FieldInput, FieldTextarea, FormError } from './forms';

/**
 * Messages — the FEDERATED device conversations panel (the omni-channel surface's
 * first channel). Renders the worker's iMessage + SMS threads with the contact's
 * handles, live from the UUDC device bridge, expands a thread for previews, and
 * offers a compose form when entitled. Outbound defaults to dry-run until
 * CONVERSATIONS_OPS_LIVE_SEND_ENABLED is set after the Aaron-attended checkpoint.
 * The device is the conversation source-of-truth; this UI never stores a message.
 */
export function ConversationsPanel(props: {
  workspaceId: string | null;
  customerId: string;
  panel: ConversationsPanelData;
  onChanged: () => void | Promise<void>;
}) {
  const { panel, workspaceId, customerId } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const empty = panel.threads.length === 0;
  const channels = panel.enabledChannels?.join(' · ') || 'iMessage & SMS';
  const dryRun = panel.dryRunDefault !== false;
  const subtitle = panel.configured
    ? empty
      ? 'No conversations yet'
      : `${panel.threads.length} conversation${panel.threads.length === 1 ? '' : 's'}${dryRun ? ' · dry-run send' : ''}`
    : `Device · ${channels}`;

  async function toggleThread(chatId: string) {
    if (expanded === chatId) {
      setExpanded(null);
      setMessages([]);
      return;
    }
    if (!workspaceId) return;
    setExpanded(chatId);
    setLoadingThread(true);
    try {
      const res = await listConversationMessages(workspaceId, customerId, chatId);
      setMessages(res.messages);
    } catch {
      setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }

  return (
    <PanelSection
      icon={MessageSquare}
      gradient="from-teal-400 to-emerald-500"
      title="Messages"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="conversations-ops" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="the device bridge">
          iMessage & SMS are federated from the worker&apos;s device (the UUDC messages bridge) — Customer-Ops never stores message content.
        </ConnectNotice>
      ) : (
        <>
          {empty ? (
            <EmptyRow>No iMessage or SMS conversations with this contact yet.</EmptyRow>
          ) : (
            <ul className="-mx-1 mb-1 space-y-0.5">
              {panel.threads.map((t) => {
                const isOpen = expanded === t.id;
                return (
                  <li key={`${t.channel}:${t.id}`}>
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => void toggleThread(t.id)}
                    >
                      <ListRow
                        leadingDot={t.lastFromMe ? 'bg-[rgb(var(--co-edge))]' : 'bg-info'}
                        title={
                          <span className="inline-flex items-center gap-1.5">
                            {isOpen ? (
                              <ChevronDown className="h-3 w-3 text-tertiary" strokeWidth={2.25} />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-tertiary" strokeWidth={2.25} />
                            )}
                            {t.displayName ?? t.handle}
                          </span>
                        }
                        meta={
                          t.lastFromMe ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Send className="h-3 w-3 text-tertiary" strokeWidth={2.25} />
                              {t.lastSnippet ?? '—'}
                            </span>
                          ) : (
                            (t.lastSnippet ?? '—')
                          )
                        }
                        trailing={<Badge variant="info">{t.channel}</Badge>}
                      />
                    </button>
                    {isOpen ? (
                      <div className="mb-2 ml-5 mt-1 space-y-1 rounded-token border border-subtle bg-surface-overlay/40 p-2 text-xs text-secondary">
                        {loadingThread ? (
                          <p className="text-tertiary">Loading thread…</p>
                        ) : messages.length === 0 ? (
                          <p className="text-tertiary">No messages in this thread (or bridge returned none).</p>
                        ) : (
                          messages.map((m) => (
                            <div
                              key={m.id}
                              className={`rounded px-2 py-1 ${m.fromMe ? 'bg-[rgb(var(--co-edge))]/30' : 'bg-surface'}`}
                            >
                              <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-tertiary">
                                <span>{m.fromMe ? 'You' : m.sender || 'Them'}</span>
                                <span>{m.at ? new Date(m.at).toLocaleString() : ''}</span>
                              </div>
                              <p className="mt-0.5 whitespace-pre-wrap text-primary">{m.text || '—'}</p>
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </li>
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
                leading={<Send className="h-4 w-4" strokeWidth={2.4} />}
                onClick={() => setOpen(true)}
              >
                {dryRun ? 'Compose message (dry-run)' : 'Compose message'}
              </Button>
            ) : (
              <MessageForm
                busy={busy}
                error={err}
                dryRun={dryRun}
                enabledChannels={panel.enabledChannels ?? ['iMessage', 'SMS']}
                onCancel={() => {
                  setOpen(false);
                  setErr(null);
                }}
                onSubmit={async (body) => {
                  if (!workspaceId) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    await sendMessage(workspaceId, customerId, body);
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
              Sending from the device requires the Customer-Ops entitlement and an enabled channel. Conversations are read-only.
            </EntitlementNotice>
          )}
        </>
      )}
    </PanelSection>
  );
}

function MessageForm(props: {
  busy: boolean;
  error: string | null;
  dryRun: boolean;
  enabledChannels: string[];
  onCancel: () => void;
  onSubmit: (body: SendMessageInput) => void | Promise<void>;
}) {
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState(props.enabledChannels[0] ?? 'iMessage');
  const canSubmit = body.trim().length > 0 && !props.busy;

  return (
    <div className="mt-3 grid gap-2.5 rounded-token border border-subtle bg-surface-overlay/50 p-3">
      <FormError error={props.error} />
      {props.dryRun ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Dry-run mode: the bridge will rehearse the send but will not deliver until an Aaron-attended checkpoint sets CONVERSATIONS_OPS_LIVE_SEND_ENABLED=true.
        </p>
      ) : null}
      <FieldInput
        label="To"
        placeholder="phone e164 or Apple ID email (defaults to contact primary)"
        value={to}
        onChange={setTo}
        optional
      />
      <label className="grid gap-1 text-xs font-medium text-secondary">
        Channel
        <select
          className="rounded-token border border-subtle bg-surface px-2 py-1.5 text-sm text-primary"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          {props.enabledChannels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <FieldTextarea label="Message" placeholder="Write your message…" value={body} onChange={setBody} rows={4} />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit}
          leading={<Send className="h-4 w-4" strokeWidth={2.4} />}
          onClick={() =>
            void props.onSubmit({
              to: to.trim() || undefined,
              body: body.trim(),
              channel: channel as SendMessageInput['channel'],
            })
          }
        >
          {props.dryRun ? 'Dry-run send' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

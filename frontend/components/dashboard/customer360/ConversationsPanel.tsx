'use client';

import { MessageSquare, Send } from 'lucide-react';
import { Badge } from '@/components/ui';
import { type ConversationsPanel as ConversationsPanelData } from '@/lib/customers';
import { ConnectNotice, EmptyRow, EntitlementNotice, ListRow, PanelSection, SourceTag } from './shared';

/**
 * Messages — the FEDERATED device conversations panel (the omni-channel surface's
 * first channel). Renders the worker's iMessage + SMS threads with the contact's
 * handles, live from the UUDC device bridge, and degrades clean when the bridge is
 * not connected. The device is the conversation source-of-truth; this UI never
 * stores a message. Read-only in v1 — sending from the cockpit lands once the
 * live device transport is stood up.
 */
export function ConversationsPanel(props: {
  workspaceId: string | null;
  customerId: string;
  panel: ConversationsPanelData;
  onChanged: () => void | Promise<void>;
}) {
  const { panel } = props;

  const empty = panel.threads.length === 0;
  const subtitle = panel.configured
    ? empty
      ? 'No conversations yet'
      : `${panel.threads.length} conversation${panel.threads.length === 1 ? '' : 's'}`
    : 'Device · iMessage & SMS';

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
              {panel.threads.map((t) => (
                <ListRow
                  key={`${t.channel}:${t.id}`}
                  leadingDot={t.lastFromMe ? 'bg-[rgb(var(--co-edge))]' : 'bg-info'}
                  title={t.displayName ?? t.handle}
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
              ))}
            </ul>
          )}

          {!panel.canSend ? (
            <EntitlementNotice>
              Sending from the device requires the Customer-Ops entitlement. Conversations are read-only.
            </EntitlementNotice>
          ) : null}
        </>
      )}
    </PanelSection>
  );
}

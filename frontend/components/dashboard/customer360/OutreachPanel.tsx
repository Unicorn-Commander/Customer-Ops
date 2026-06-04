'use client';

import { useState } from 'react';
import { Megaphone, Rocket, Mail, Share2 } from 'lucide-react';
import { Button, cn } from '@/components/ui';
import {
  outreachStatusLabel,
  startCampaign,
  type OutreachPanel as OutreachPanelData,
  type StartCampaignInput,
} from '@/lib/customers';
import {
  ConnectNotice, EmptyRow, EntitlementNotice, ListRow, PanelSection, SourceTag, StatusPill,
} from './shared';
import { FieldLabel, FormError, inputClass } from './forms';

/**
 * Outreach — the FEDERATED Outreach panel (the Outreach app: Listmonk + Postiz).
 * Renders the contact's outreach touches (live) + the local enrollment links +
 * the live campaign picker, degrades clean when not connected, and offers a
 * start-campaign action only when entitled. The Outreach app is the campaign SoR;
 * this UI never sends a campaign — it asks the backend to enroll the contact.
 */
export function OutreachPanel(props: {
  workspaceId: string | null;
  customerId: string;
  panel: OutreachPanelData;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId, panel } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const empty = panel.touches.length === 0 && panel.enrollments.length === 0;
  const subtitle = panel.configured
    ? empty
      ? 'No touches yet'
      : `${panel.touches.length + panel.enrollments.length} touch${
          panel.touches.length + panel.enrollments.length === 1 ? '' : 'es'
        } · ${panel.campaigns.length} campaign${panel.campaigns.length === 1 ? '' : 's'}`
    : 'Outreach · Listmonk + Postiz';

  const channelIcon = (channel: string) =>
    channel === 'social' ? (
      <Share2 className="h-3.5 w-3.5 text-tertiary" strokeWidth={2.25} />
    ) : (
      <Mail className="h-3.5 w-3.5 text-tertiary" strokeWidth={2.25} />
    );

  return (
    <PanelSection
      icon={Megaphone}
      gradient="from-fuchsia-500 to-pink-500"
      title="Outreach"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="outreach" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="Outreach">
          Campaigns are federated to Outreach (Listmonk + Postiz) — Customer-Ops never holds a recipient list.
        </ConnectNotice>
      ) : (
        <>
          {empty ? (
            <EmptyRow>No outreach touches for this contact yet.</EmptyRow>
          ) : (
            <ul className="-mx-1 mb-1 space-y-0.5">
              {panel.touches.map((t) => {
                const s = outreachStatusLabel(t.status);
                return (
                  <ListRow
                    key={t.id}
                    title={
                      <span className="inline-flex items-center gap-1.5">
                        {channelIcon(t.channel)}
                        {t.campaignName ?? t.subject ?? `${t.channel} touch`}
                      </span>
                    }
                    meta={
                      <>
                        {t.channel}
                        {t.lastEngagementKind ? ` · last: ${t.lastEngagementKind}` : ''}
                      </>
                    }
                    trailing={<StatusPill status={s} />}
                  />
                );
              })}
              {/* Local enrollment links we initiated (de-dupe memory + status). */}
              {panel.enrollments.map((en) => {
                const s = outreachStatusLabel(en.status);
                return (
                  <ListRow
                    key={en.id}
                    title={
                      <span className="inline-flex items-center gap-1.5">
                        {channelIcon(en.channel)}
                        {en.campaignName ?? en.externalRef}
                      </span>
                    }
                    meta={`${en.channel} · enrolled`}
                    trailing={<StatusPill status={s} />}
                  />
                );
              })}
            </ul>
          )}

          {panel.canStart ? (
            !open ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-1"
                leading={<Rocket className="h-4 w-4" strokeWidth={2.4} />}
                onClick={() => setOpen(true)}
              >
                Start campaign
              </Button>
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
            <EntitlementNotice>
              Starting a campaign requires the Customer-Ops + Outreach entitlements. History is read-only.
            </EntitlementNotice>
          )}
        </>
      )}
    </PanelSection>
  );
}

/** The start-campaign form: pick a federated campaign to enroll the contact into. */
function CampaignForm(props: {
  campaigns: OutreachPanelData['campaigns'];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: StartCampaignInput) => void | Promise<void>;
}) {
  const [campaignId, setCampaignId] = useState(props.campaigns[0]?.id ?? '');
  const canSubmit = campaignId.trim().length > 0 && !props.busy;

  return (
    <div className="mt-3 grid gap-2.5 rounded-token border border-subtle bg-surface-overlay/50 p-3">
      <FormError error={props.error} />
      {props.campaigns.length === 0 ? (
        <p className="text-xs leading-relaxed text-tertiary">
          No campaigns are available in the Outreach app yet. Create one in Outreach, then enroll this contact here.
        </p>
      ) : (
        <div>
          <FieldLabel>Campaign</FieldLabel>
          <select className={cn(inputClass, 'appearance-none')} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {props.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.channel}
                {c.isSequence ? ' · sequence' : ''})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!canSubmit}
          leading={<Rocket className="h-4 w-4" strokeWidth={2.4} />}
          onClick={() => props.onSubmit({ campaignId: campaignId.trim() })}
        >
          {props.busy ? 'Enrolling…' : 'Enroll contact'}
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

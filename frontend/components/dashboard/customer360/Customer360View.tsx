'use client';

import { useState } from 'react';
import { LayoutGrid, History, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui';
import type { Customer360, Stage } from '@/lib/customers';
import { Customer360Header } from './Header';
import { Timeline } from './Timeline';
import { ContactCard } from './ContactCard';
import { AgentsPanel } from './AgentsPanel';
import { InvoicesPanel } from './InvoicesPanel';
import { EmailPanel } from './EmailPanel';
import { ConversationsPanel } from './ConversationsPanel';
import { OutreachPanel } from './OutreachPanel';
import { MeetingsPanel } from './MeetingsPanel';
import { ProjectsPanel } from './ProjectsPanel';

/**
 * Customer360View — the PRESENTATIONAL relationship cockpit. Pure props: the
 * federated `Customer360` snapshot + the wired action handlers (the page owns the
 * live data + the API calls). Layout: a full-width identity/lifecycle header, then
 * a two-column body — the activity Timeline on the left, the stack of federated
 * "app tile" panels on the right. On small screens the columns stack and a
 * segmented control toggles between the two so neither gets cramped.
 */
export interface Customer360Handlers {
  onTransition: (to: Stage) => void;
  onMarkLost: () => void;
  onReopen: () => void;
  onAddNote: (body: string) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}

export function Customer360View({
  data,
  workspaceId,
  customerId,
  busy,
  handlers,
}: {
  data: Customer360;
  workspaceId: string | null;
  customerId: string;
  busy: boolean;
  handlers: Customer360Handlers;
}) {
  const { relationship: rel, contact, contactFederation, timeline, invoices, outreach, email, conversations, meetings, projects } = data;
  const [mobileTab, setMobileTab] = useState<'panels' | 'activity'>('panels');

  const customerName = contact?.displayName ?? `Contact ${rel.contactId.slice(0, 8)}`;
  const primaryEmail = contact?.emails?.find((e) => e.is_primary)?.address ?? contact?.primaryEmail ?? undefined;

  const timelineCol = (
    <Timeline entries={timeline} onAddNote={handlers.onAddNote} busy={busy} />
  );

  const panelsCol = (
    <div className="space-y-4">
      <ContactCard contact={contact} federation={contactFederation} contactId={rel.contactId} />
      <AgentsPanel workspaceId={workspaceId} customerId={customerId} onChanged={handlers.onChanged} />
      <InvoicesPanel
        workspaceId={workspaceId}
        customerId={customerId}
        panel={invoices}
        customerName={customerName}
        customerEmail={primaryEmail}
        currency={rel.currency ?? 'USD'}
        onChanged={handlers.onChanged}
      />
      <EmailPanel
        workspaceId={workspaceId}
        customerId={customerId}
        panel={email}
        defaultToAddress={primaryEmail}
        onChanged={handlers.onChanged}
      />
      <ConversationsPanel
        workspaceId={workspaceId}
        customerId={customerId}
        panel={conversations}
        onChanged={handlers.onChanged}
      />
      <OutreachPanel workspaceId={workspaceId} customerId={customerId} panel={outreach} onChanged={handlers.onChanged} />
      <MeetingsPanel panel={meetings} />
      <ProjectsPanel panel={projects} />
    </div>
  );

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      <Customer360Header
        data={data}
        busy={busy}
        onTransition={handlers.onTransition}
        onMarkLost={handlers.onMarkLost}
        onReopen={handlers.onReopen}
      />

      {/* mobile segmented control */}
      <div className="flex rounded-token border border-subtle bg-surface-raised p-1 lg:hidden">
        <SegTab active={mobileTab === 'panels'} icon={LayoutGrid} label="Panels" onClick={() => setMobileTab('panels')} />
        <SegTab active={mobileTab === 'activity'} icon={History} label={`Activity (${timeline.length})`} onClick={() => setMobileTab('activity')} />
      </div>

      {/* desktop: two columns; mobile: tabbed single column */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className={cn('lg:block', mobileTab === 'activity' ? 'block' : 'hidden')}>{timelineCol}</div>
        <div className={cn('lg:block', mobileTab === 'panels' ? 'block' : 'hidden')}>{panelsCol}</div>
      </div>
    </div>
  );
}

function SegTab({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors',
        active ? 'bg-surface-overlay text-primary shadow-token' : 'text-tertiary hover:text-primary',
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2.25} />
      {label}
    </button>
  );
}

'use client';

import { Users, Mail, Phone, Building2, Tag } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { Customer360 } from '@/lib/customers';
import { ConnectNotice, PanelSection, SourceTag } from './shared';

type Contact = Customer360['contact'];
type Federation = Customer360['contactFederation'];

/** A labelled row in the contact card (icon · label · value/children). */
function Row({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-tertiary" strokeWidth={2.25} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-tertiary">{label}</div>
        <div className="mt-0.5 text-[13px] text-secondary">{children}</div>
      </div>
    </div>
  );
}

/**
 * ContactCard — the FEDERATED Contact-Ops identity. Renders the full email/phone
 * lists, org, kind/status, and tags. The contact is resolved read-time by the
 * backend and NEVER copied; when Contact-Ops is dormant the card shows a clean
 * placeholder (the relationship still references the contactId).
 */
export function ContactCard({
  contact,
  federation,
  contactId,
}: {
  contact: Contact;
  federation: Federation;
  contactId: string;
}) {
  return (
    <PanelSection
      icon={Users}
      gradient="from-violet-500 to-fuchsia-500"
      title="Contact"
      subtitle={contact ? (contact.kind ? `${contact.kind}${contact.status ? ` · ${contact.status}` : ''}` : 'Contact-Ops') : 'Contact-Ops'}
      tag={<SourceTag configured={federation.resolved} source="contact-ops" />}
    >
      {!contact ? (
        <ConnectNotice app="Contact-Ops">
          Contact details federate from Contact-Ops and aren’t available right now. The relationship references
          contactId <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[11px] text-tertiary">{contactId.slice(0, 12)}…</code>{' '}
          — Customer-Ops holds the reference, never a copy.
        </ConnectNotice>
      ) : (
        <div className="-my-1.5 divide-y divide-[rgb(var(--co-edge-subtle))]">
          {contact.currentOrgName && (
            <Row icon={Building2} label="Organization">{contact.currentOrgName}</Row>
          )}
          <Row icon={Mail} label={contact.emails && contact.emails.length > 1 ? 'Emails' : 'Email'}>
            {contact.emails && contact.emails.length > 0 ? (
              <ul className="space-y-1">
                {contact.emails.map((e, i) => (
                  <li key={`${e.address}-${i}`} className="flex items-center gap-2">
                    <a href={`mailto:${e.address}`} className="truncate text-secondary transition-colors hover:text-accent">
                      {e.address}
                    </a>
                    {e.is_primary && <Badge variant="accent">primary</Badge>}
                    {e.type && !e.is_primary && <span className="text-[11px] text-muted">{e.type}</span>}
                  </li>
                ))}
              </ul>
            ) : contact.primaryEmail ? (
              <a href={`mailto:${contact.primaryEmail}`} className="text-secondary transition-colors hover:text-accent">
                {contact.primaryEmail}
              </a>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Row>
          <Row icon={Phone} label={contact.phones && contact.phones.length > 1 ? 'Phones' : 'Phone'}>
            {contact.phones && contact.phones.length > 0 ? (
              <ul className="space-y-1">
                {contact.phones.map((p, i) => (
                  <li key={`${p.e164}-${i}`} className="flex items-center gap-2">
                    <a href={`tel:${p.e164}`} className="truncate text-secondary transition-colors hover:text-accent">
                      {p.e164}
                    </a>
                    {p.is_primary && <Badge variant="accent">primary</Badge>}
                    {p.type && !p.is_primary && <span className="text-[11px] text-muted">{p.type}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Row>
          {contact.tags && contact.tags.length > 0 && (
            <Row icon={Tag} label="Tags">
              <div className="flex flex-wrap gap-1.5">
                {contact.tags.map((t) => (
                  <Badge key={t} variant="neutral">{t}</Badge>
                ))}
              </div>
            </Row>
          )}
        </div>
      )}
    </PanelSection>
  );
}

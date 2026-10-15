'use client';

import { Users, Mail, Phone, Building2, Tag, UserRound, AtSign, Link2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { Customer360 } from '@/lib/customers';
import { ConnectNotice, PanelSection, SourceTag } from './shared';

type Contact = NonNullable<Customer360['contact']>;
type Federation = Customer360['contactFederation'];
type Identifier = Contact['identifiers'][number];

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
 * The reported display name when the structured parts differ from it. Contact-Ops
 * keeps `display_name` as the canonical label; given/family (and any honorific)
 * are the parts. When both are present we show "Given Family" as the full name so
 * a contact known only as an alias ("Diesel") still gets its real parts rendered.
 */
export function contactFullName(contact: Contact): string | null {
  const parts = [contact.honorificPrefix, contact.givenName, contact.familyName]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  if (parts.length === 0) {
    // No structured parts — fall back to the honorific-suffixed display name.
    return contact.honorificSuffix ? `${contact.displayName} ${contact.honorificSuffix}`.trim() : null;
  }
  let name = parts.join(' ');
  if (contact.honorificSuffix) name = `${name} ${contact.honorificSuffix}`;
  return name;
}

/** True when the structured full name adds nothing over the display name. */
function fullNameIsDistinct(contact: Contact): boolean {
  const full = contactFullName(contact);
  return !!full && full.toLowerCase() !== contact.displayName.trim().toLowerCase();
}

/** Resolve the lifecycle marker shown for merged or archived Contact-Ops rows. */
export function contactLifecycle(contact: Pick<Contact, 'status' | 'mergedIntoId'>): 'merged' | 'archived' | null {
  if (contact.mergedIntoId) return 'merged';
  if (contact.status.toLowerCase() === 'archived') return 'archived';
  return null;
}

/**
 * The profile/deep link for a known handle protocol, else null. Protocols without
 * a canonical public URL scheme (signal, imessage, phone) intentionally return
 * null so the handle renders as plain text rather than a dead link.
 */
export function profileUrlForProtocol(protocol: string, handle: string): string | null {
  const h = handle.trim().replace(/^@/, '');
  if (!h) return null;
  switch (protocol.trim().toLowerCase()) {
    case 'telegram':
      return `https://t.me/${h}`;
    case 'whatsapp':
      return `https://wa.me/${h.replace(/[^\d]/g, '')}`;
    case 'matrix': {
      // Matrix ids are `@user:server` — the leading @ is part of the id.
      const raw = handle.trim();
      return raw.startsWith('@') && raw.includes(':') ? `https://matrix.to/#/${raw}` : null;
    }
    case 'x':
    case 'twitter':
      return `https://x.com/${h}`;
    case 'github':
      return `https://github.com/${h}`;
    case 'linkedin':
      return `https://www.linkedin.com/in/${h}`;
    case 'instagram':
      return `https://instagram.com/${h}`;
    case 'mastodon': {
      // Mastodon handles are `@user@server` — build the instance profile URL.
      const parts = h.split('@').filter(Boolean);
      return parts.length === 2 ? `https://${parts[1]}/@${parts[0]}` : null;
    }
    default:
      return null;
  }
}

/**
 * The profile/deep link for an identifier. Contact-Ops may carry a verified
 * `url`; otherwise build one from a known namespace + value.
 */
export function profileUrlForIdentifier(id: Identifier): string | null {
  if (id.url && id.url.trim()) return safeExternalUrl(id.url.trim());
  return profileUrlForProtocol(id.namespace, id.value);
}

/**
 * Guard an href from federated data. Contact-Ops stores URLs as free text (no
 * scheme validation on write), so a `javascript:`/`data:` value must never
 * become a clickable link in the operator's browser. Returns the URL only when
 * it is an http(s) or mailto URL, else null (caller renders plain text).
 */
export function safeExternalUrl(url: string): string | null {
  try {
    // Parse WITHOUT a base so a bare/relative string ("not a url", "/x") throws —
    // only an explicit http(s)/mailto scheme is allowed through.
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * ContactCard — the FEDERATED Contact-Ops identity. Renders the full name,
 * nicknames/AKA, email/phone lists, IM handles + profile links, org, kind/status,
 * and tags. The contact is resolved read-time by the backend and NEVER copied;
 * when Contact-Ops is dormant the card shows a clean placeholder (the
 * relationship still references the contactId).
 */
export function ContactCard({
  contact,
  federation,
  contactId,
}: {
  contact: Contact | null;
  federation: Federation;
  contactId: string;
}) {
  const fullName = contact ? contactFullName(contact) : null;
  const showFullName = contact ? fullNameIsDistinct(contact) : false;
  const nicknames = contact?.nicknames ?? [];
  const additionalNames = contact?.additionalNames ?? [];
  const fileAs = contact?.fileAs?.trim() || null;
  // Contact-Ops carries phonetic given/family names for pronunciation; surface
  // them as secondary text so they aren't dead data in the federated DTO.
  const phoneticGivenName = contact?.phoneticGivenName?.trim() || null;
  const phoneticFamilyName = contact?.phoneticFamilyName?.trim() || null;
  const phoneticName = [phoneticGivenName, phoneticFamilyName].filter(Boolean).join(' ') || null;
  const imHandles = contact?.imHandles ?? [];
  const identifiers = contact?.identifiers ?? [];
  const urls = contact?.urls ?? [];
  const lifecycle = contact ? contactLifecycle(contact) : null;
  const relationshipCategory = contact?.relationshipCategory?.trim() || null;

  return (
    <PanelSection
      icon={Users}
      gradient="from-violet-500 to-fuchsia-500"
      title="Contact"
      subtitle={contact ? (contact.kind ? `${contact.kind}${contact.status ? ` · ${contact.status}` : ''}${lifecycle ? ` · ${lifecycle}` : ''}` : 'Contact-Ops') : 'Contact-Ops'}
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
          {lifecycle && (
            <div role="status" className="flex items-center gap-2 py-2 text-[12px] text-tertiary">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={2.25} />
              {lifecycle === 'merged' ? (
                <span>
                  This contact was <strong className="font-medium text-secondary">merged</strong> into another record.
                  Edits here won’t apply — use the surviving contact.
                </span>
              ) : (
                <span>
                  This contact is <strong className="font-medium text-secondary">archived</strong> and is no longer active.
                </span>
              )}
            </div>
          )}
          {(showFullName || nicknames.length > 0 || additionalNames.length > 0 || contact.pronouns || fileAs || phoneticName) && (
            <Row icon={UserRound} label="Name">
              <div className="flex flex-wrap items-center gap-2">
                {showFullName && <span className="text-secondary">{fullName}</span>}
                {additionalNames.length > 0 && (
                  <span className="text-secondary" title="Additional names">
                    {additionalNames.join(' · ')}
                  </span>
                )}
                {contact.pronouns && <span className="text-[11px] text-muted">({contact.pronouns})</span>}
                {phoneticName && (
                  <span className="text-[11px] text-muted" title="Phonetic name">
                    [{phoneticName}]
                  </span>
                )}
                {fileAs && fileAs.toLowerCase() !== fullName?.trim().toLowerCase() && (
                  <span className="text-[11px] text-muted">file as {fileAs}</span>
                )}
                {nicknames.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted">AKA</span>
                    {nicknames.map((n, i) => (
                      <Badge key={`${n}-${i}`} variant="neutral">{n}</Badge>
                    ))}
                  </span>
                )}
              </div>
            </Row>
          )}
          {contact.currentOrgName && (
            <Row icon={Building2} label="Organization">{contact.currentOrgName}</Row>
          )}
          {relationshipCategory && (
            <Row icon={UserRound} label="Relationship">
              <span className="capitalize">{relationshipCategory}</span>
            </Row>
          )}
          <Row icon={Mail} label={contact.emails && contact.emails.length > 1 ? 'Emails' : 'Email'}>
            {contact.emails && contact.emails.length > 0 ? (
              <ul className="space-y-1">
                {contact.emails.map((e, i) => (
                  <li key={`${e.address}-${i}`} className="flex items-center gap-2">
                    <a href={`mailto:${e.address}`} className="min-w-0 break-all text-secondary transition-colors hover:text-accent">
                      {e.address}
                    </a>
                    {e.is_primary && <Badge variant="accent">primary</Badge>}
                    {e.type && !e.is_primary && <span className="text-[11px] text-muted">{e.type}</span>}
                  </li>
                ))}
              </ul>
            ) : contact.primaryEmail ? (
              <a href={`mailto:${contact.primaryEmail}`} className="break-all text-secondary transition-colors hover:text-accent">
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
                    <a href={`tel:${p.e164}`} className="min-w-0 break-all text-secondary transition-colors hover:text-accent">
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
          <Row icon={AtSign} label={imHandles.length > 1 ? 'Handles' : 'Handle'}>
            {imHandles.length > 0 ? (
              <ul className="space-y-1">
                {imHandles.map((h) => {
                  const href = profileUrlForProtocol(h.protocol, h.handle);
                  return (
                    <li key={h.id} className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">{h.protocol}</span>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="truncate text-secondary transition-colors hover:text-accent"
                        >
                          {h.handle}
                        </a>
                      ) : (
                        <span className="truncate text-secondary">{h.handle}</span>
                      )}
                      {h.is_primary && <Badge variant="accent">primary</Badge>}
                      {h.label && !h.is_primary && <span className="text-[11px] text-muted">{h.label}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Row>
          <Row icon={Link2} label={(identifiers.length + urls.length) > 1 ? 'Links' : 'Link'}>
            {identifiers.length > 0 || urls.length > 0 ? (
              <ul className="space-y-1">
                {identifiers.map((id) => {
                  const href = profileUrlForIdentifier(id);
                  return (
                    <li key={id.id} className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">{id.namespace}</span>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="truncate text-secondary transition-colors hover:text-accent"
                        >
                          {id.value}
                        </a>
                      ) : (
                        <span className="truncate text-secondary">{id.value}</span>
                      )}
                      {id.verified && <Badge variant="accent">verified</Badge>}
                    </li>
                  );
                })}
                {urls.map((u) => {
                  const href = safeExternalUrl(u.url);
                  return (
                    <li key={u.id} className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">{u.type ?? 'url'}</span>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="truncate text-secondary transition-colors hover:text-accent"
                        >
                          {u.label ?? u.url}
                        </a>
                      ) : (
                        <span className="truncate text-secondary">{u.label ?? u.url}</span>
                      )}
                      {u.is_primary && <Badge variant="accent">primary</Badge>}
                    </li>
                  );
                })}
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

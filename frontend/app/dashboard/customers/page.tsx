'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Plus, X, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconTile } from '@/components/ui/IconTile';
import { cn } from '@/components/ui/cn';
import { RelationshipsTable } from '@/components/dashboard/RelationshipsTable';
import { useWorkspace } from '@/lib/useWorkspace';
import { createCustomer, listCustomers, searchContacts, type CustomerRow } from '@/lib/customers';
import {
  contactOptionLabel,
  createPayloadFor,
  searchContactOptions,
  type ContactOption,
} from '@/lib/contactPicker';

/**
 * Relationships — the funnel cockpit's master list. THIN live wrapper: it
 * resolves the workspace, loads every relationship once, and renders the
 * presentational <RelationshipsTable>, which owns stage-filter / search / sort
 * over that set (so the chip counts stay live without re-fetching per filter).
 *
 * Contact names are FEDERATED from Contact-Ops by the backend; a relationship
 * row may carry a null contact (CO dormant) — the table renders a placeholder,
 * never a copy. Creating one binds an existing Contact-Ops contact id as a Lead.
 */
export default function CustomersPage() {
  const { workspaceId, canWrite, loading: wsLoading, error: wsError } = useWorkspace();
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [includeLost, setIncludeLost] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ContactOption | null>(null);
  const [options, setOptions] = useState<ContactOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      setRows(await listCustomers(workspaceId, { includeLost }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId, includeLost]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced type-ahead against the workspace's Contact-Ops contacts.
  useEffect(() => {
    if (!workspaceId || picked) return;
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchContactOptions(workspaceId, query, searchContacts);
        if (live) setOptions(found);
      } catch {
        if (live) setOptions([]);
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [workspaceId, query, picked]);

  const openCreate = () => {
    setCreating(true);
    // Focus the field on the next paint so it's ready to type into.
    requestAnimationFrame(() => createInputRef.current?.focus());
  };

  const submitCreate = async () => {
    const payload = createPayloadFor(picked);
    if (!workspaceId || !payload) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomer(workspaceId, payload);
      setQuery('');
      setPicked(null);
      setOptions([]);
      setCreating(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loading = wsLoading || (rows === null && !error && !wsError);
  const fatalError = wsError || error;

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      {/* ── Header ── */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <IconTile icon={Users} gradient="from-violet-500 to-fuchsia-500" size="lg" glow />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-primary">Relationships</h1>
            <p className="mt-0.5 max-w-xl text-sm text-tertiary">
              The whole customer lifecycle — lead → prospect → customer. Contacts federate from
              Contact-Ops; the relationship and stage live here.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label
            className="inline-flex cursor-pointer select-none items-center gap-2 rounded-token border border-subtle bg-surface-raised px-3 py-2 text-xs font-medium text-tertiary transition-colors hover:text-secondary"
            title="Include relationships marked as lost"
          >
            <input
              type="checkbox"
              checked={includeLost}
              onChange={(e) => setIncludeLost(e.target.checked)}
              className="h-3.5 w-3.5 accent-[rgb(var(--co-accent))]"
            />
            Show lost
          </label>
          {canWrite && <Button
            glow={!creating}
            variant={creating ? 'secondary' : 'primary'}
            leading={creating ? <X className="h-4 w-4" strokeWidth={2.5} /> : <Plus className="h-4 w-4" strokeWidth={2.5} />}
            onClick={() => (creating ? setCreating(false) : openCreate())}
          >
            {creating ? 'Cancel' : 'New relationship'}
          </Button>}
        </div>
      </header>

      {/* ── Inline create ── */}
      {canWrite && creating && (
        <div className="rounded-token-lg border border-subtle bg-surface-raised p-4 shadow-token">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="relative flex-1">
              <label htmlFor="co-new-contact" className="mb-1.5 block text-xs font-semibold text-secondary">
                Contact
              </label>
              <input
                id="co-new-contact"
                ref={createInputRef}
                role="combobox"
                aria-expanded={!picked && options.length > 0}
                aria-controls="co-new-contact-options"
                autoComplete="off"
                value={picked ? picked.displayName : query}
                onChange={(e) => {
                  setPicked(null);
                  setQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate();
                  if (e.key === 'Escape') setCreating(false);
                }}
                placeholder="Search your Contact-Ops contacts by name or email"
                className={cn(
                  'h-10 w-full rounded-token border border-subtle bg-surface-overlay/60 px-3 text-sm text-primary',
                  'placeholder:text-muted',
                  'transition-colors duration-fast ease-token',
                  'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
                )}
              />
              {!picked && options.length > 0 && (
                <ul
                  id="co-new-contact-options"
                  role="listbox"
                  className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-token border border-subtle bg-surface-raised shadow-token"
                >
                  {options.map((o) => {
                    const { title, subtitle } = contactOptionLabel(o);
                    return (
                      <li key={o.contactId} role="option" aria-selected={false}>
                        <button
                          type="button"
                          className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-overlay/60"
                          onClick={() => {
                            setPicked(o);
                            setOptions([]);
                          }}
                        >
                          <span className="text-sm font-medium text-primary">{title}</span>
                          {subtitle && <span className="text-xs text-tertiary">{subtitle}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!picked && !searching && query.trim().length >= 2 && options.length === 0 && (
                <p className="mt-1.5 text-xs text-tertiary">
                  No matching contact in Contact-Ops. Create the person there first, then come back.
                </p>
              )}
            </div>
            <Button onClick={submitCreate} disabled={busy || !picked}>
              {busy ? 'Creating…' : 'Create as Lead'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-tertiary">
            The new relationship enters the funnel as a <span className="font-medium text-stage-lead">Lead</span>.
            The contact stays in Contact-Ops — only the relationship is created here.
          </p>
        </div>
      )}

      {/* ── Error ── */}
      {fatalError && (
        <div className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Couldn’t load relationships</p>
            <p className="mt-0.5 break-words text-danger/85">{fatalError}</p>
          </div>
          {!wsError && (
            <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
      )}

      {/* ── Table (renders its own skeleton via `loading`) ── */}
      {!fatalError && (
        <RelationshipsTable rows={rows ?? []} loading={loading} onNew={canWrite ? openCreate : undefined} />
      )}
    </div>
  );
}

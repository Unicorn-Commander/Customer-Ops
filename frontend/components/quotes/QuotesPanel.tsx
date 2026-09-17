'use client';

import { useEffect, useState } from 'react';
import { FileSignature } from 'lucide-react';
import { Badge } from '@/components/ui';
import { PanelSection } from '@/components/dashboard/customer360/shared';
import { apiGet } from '@/lib/api';

type QuoteSummary = { id: string; number: string; title: string; status: string };

/** Read only the current relationship's quotes in its explicit workspace. */
export function QuotesPanel({ workspaceId, customerId }: { workspaceId?: string | null; customerId: string }) {
  const [state, setState] = useState<{ key: string; quotes?: QuoteSummary[]; error?: boolean }>({ key: '' });
  const key = `${workspaceId ?? ''}:${customerId}`;
  useEffect(() => {
    let active = true;
    if (!workspaceId) return;
    apiGet<QuoteSummary[]>(`/quotes?customerId=${encodeURIComponent(customerId)}`, undefined, {
      'X-Workspace-Id': workspaceId,
    }).then((quotes) => {
      if (!Array.isArray(quotes)) throw new Error('Invalid quote response');
      if (active) setState({ key, quotes });
    }).catch(() => { if (active) setState({ key, error: true }); });
    return () => { active = false; };
  }, [workspaceId, customerId, key]);
  const current = state.key === key ? state : undefined;
  return (
    <PanelSection icon={FileSignature} gradient="from-amber-500 to-rose-500"
      title="Quotes & proposals" subtitle="Customer-Ops is the system of record">
      {!workspaceId || current?.error ? (
        <p className="text-sm text-secondary">Quotes are unavailable right now.</p>
      ) : !current?.quotes ? (
        <p className="text-sm text-secondary" role="status">Loading quotes…</p>
      ) : current.quotes.length === 0 ? (
        <p className="text-sm text-secondary">No quotes for this relationship yet.</p>
      ) : (
        <ul className="space-y-2">{current.quotes.map((quote) => (
          <li key={quote.id} className="rounded-token border border-subtle p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-tertiary">{quote.number}</span>
              <Badge variant="neutral">{quote.status}</Badge>
            </div>
            <h4 className="mt-1 break-words text-sm font-semibold text-primary">{quote.title}</h4>
          </li>
        ))}</ul>
      )}
    </PanelSection>
  );
}

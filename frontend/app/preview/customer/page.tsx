'use client';

import { AppShell } from '@/components/AppShell';
import { Customer360View, type Customer360Handlers } from '@/components/dashboard/customer360/Customer360View';
import { SAMPLE_360 } from '@/lib/sample-screens';

/**
 * Design preview — the rebuilt Customer-360 cockpit with one fully-fleshed
 * relationship (Northwind Remodeling) and every federated panel alive, no
 * auth/backend required. All handlers are no-ops; the live screen at
 * /dashboard/customers/[id] wires the real stage/note/invoice actions.
 */
const noopHandlers: Customer360Handlers = {
  onTransition: () => {},
  onMarkLost: () => {},
  onReopen: () => {},
  onAddNote: () => {},
  onChanged: () => {},
};

export default function PreviewCustomerPage() {
  return (
    <AppShell demo>
      <Customer360View canWrite={true}
        data={SAMPLE_360}
        workspaceId="preview"
        customerId={SAMPLE_360.relationship.id}
        busy={false}
        handlers={noopHandlers}
      />
    </AppShell>
  );
}

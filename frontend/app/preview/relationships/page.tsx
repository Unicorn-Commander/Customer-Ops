'use client';

import { AppShell } from '@/components/AppShell';
import { RelationshipsTable } from '@/components/dashboard/RelationshipsTable';
import { SAMPLE_ROWS } from '@/lib/sample-screens';

/**
 * Design preview — the rebuilt Relationships table with rich sample data, no
 * auth/backend required. Used to review the visual direction (and screenshot
 * it). The live screen lives at /dashboard/customers.
 */
export default function PreviewRelationshipsPage() {
  return (
    <AppShell demo>
      <RelationshipsTable rows={SAMPLE_ROWS} onNew={() => {}} />
    </AppShell>
  );
}

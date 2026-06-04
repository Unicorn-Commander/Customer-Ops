'use client';

import { AppShell } from '@/components/AppShell';
import { GraphExplorer } from '@/components/dashboard/GraphExplorer';

/** No-auth preview of the 3D relationship explorer (design review / screenshots).
 *  The live explorer lives at /dashboard/graph. */
export default function GraphPreviewPage() {
  return (
    <AppShell demo>
      <GraphExplorer />
    </AppShell>
  );
}

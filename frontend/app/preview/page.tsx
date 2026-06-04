'use client';

import { AppShell } from '@/components/AppShell';
import { CockpitDashboard } from '@/components/dashboard/CockpitDashboard';
import { SAMPLE_BOARD, SAMPLE_ATTENTION, SAMPLE_ACTIVITY, SAMPLE_GRAPH } from '@/lib/sample';

/**
 * Design preview — renders the full cockpit shell + dashboard with sample data,
 * no auth/backend required. Used to review the visual direction (and screenshot
 * it). The live cockpit lives at /dashboard.
 */
export default function PreviewPage() {
  return (
    <AppShell demo>
      <CockpitDashboard
        userName="Aaron"
        board={SAMPLE_BOARD}
        attention={SAMPLE_ATTENTION}
        activity={SAMPLE_ACTIVITY}
        graph={SAMPLE_GRAPH}
      />
    </AppShell>
  );
}

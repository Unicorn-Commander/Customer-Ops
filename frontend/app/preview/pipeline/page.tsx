'use client';

import { AppShell } from '@/components/AppShell';
import { PipelineBoard } from '@/components/dashboard/PipelineBoard';
import { SAMPLE_PIPELINE } from '@/lib/sample-screens';

/**
 * Design preview — the rebuilt Pipeline kanban with rich sample data, no
 * auth/backend required. Drag/transition is a no-op here (the live screen at
 * /dashboard/pipeline wires the optimistic move + API call).
 */
export default function PreviewPipelinePage() {
  return (
    <AppShell demo>
      <PipelineBoard readOnly={false} board={SAMPLE_PIPELINE} onTransition={() => {}} onOpen={() => {}} />
    </AppShell>
  );
}

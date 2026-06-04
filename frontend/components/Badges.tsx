'use client';

import { Priority, Stage } from '@/lib/customers';

const STAGE_CLASS: Record<Stage, string> = {
  LEAD: 'co-badge--lead',
  PROSPECT: 'co-badge--prospect',
  CUSTOMER: 'co-badge--customer',
};

const STAGE_TEXT: Record<Stage, string> = {
  LEAD: 'Lead',
  PROSPECT: 'Prospect',
  CUSTOMER: 'Customer',
};

export function StageBadge({ stage, lost }: { stage: Stage; lost?: boolean }) {
  if (lost) return <span className="co-badge co-badge--lost">Lost</span>;
  return <span className={`co-badge ${STAGE_CLASS[stage]}`}>{STAGE_TEXT[stage]}</span>;
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return <span className={`co-prio co-prio--${priority}`}>{priority}</span>;
}

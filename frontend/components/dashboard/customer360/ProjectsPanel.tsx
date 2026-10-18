'use client';

import { ListChecks, Clock, Users } from 'lucide-react';
import { cn } from '@/components/ui';
import { projectStatusLabel, type ProjectPanel as ProjectPanelData, type ProjectPriority } from '@/lib/customers';
import { formatDateOnly } from '@/lib/date-only';
import { ConnectNotice, EmptyRow, ListRow, PanelSection, SourceTag, StatusPill } from './shared';

function fmtDate(iso: string | null): string | null {
  return formatDateOnly(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* Project priority → a tinted, dotted token. Mirrors shared.tsx PRIORITY_META,
 * but covers the Project-Ops set (adds URGENT) which the relationship-level
 * PriorityPill doesn't model. */
const PRIORITY_META: Record<ProjectPriority, { label: string; text: string; well: string; dot: string }> = {
  URGENT: { label: 'Urgent', text: 'text-danger', well: 'bg-danger-subtle', dot: 'bg-danger' },
  HIGH: { label: 'High', text: 'text-danger', well: 'bg-danger-subtle', dot: 'bg-danger' },
  MEDIUM: { label: 'Medium', text: 'text-warning', well: 'bg-warning-subtle', dot: 'bg-warning' },
  LOW: { label: 'Low', text: 'text-tertiary', well: 'bg-surface-overlay', dot: 'bg-muted' },
};

function ProjectPriorityTag({ priority }: { priority: ProjectPriority }) {
  const m = PRIORITY_META[priority];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold', m.well, m.text)}>
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

/**
 * Projects — the FEDERATED Project-Ops delivery panel (Phase 5). Renders the
 * customer's projects with live status + priority + due date, resolved read-time
 * by the backend (never copied; Customer-Ops holds no project or task). Reads are
 * viewer-level, so the only affordance is the connect state — read-only, no
 * create/start affordance.
 */
export function ProjectsPanel({ panel }: { panel: ProjectPanelData }) {
  const n = panel.projects.length;
  const subtitle = panel.configured ? (n === 0 ? 'No projects yet' : `${n} project${n === 1 ? '' : 's'}`) : 'Project-Ops';

  return (
    <PanelSection
      icon={ListChecks}
      gradient="from-amber-400 to-orange-500"
      title="Projects"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="project-ops" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="Project-Ops">
          Delivery &amp; project status is federated from Project-Ops — Customer-Ops never stores a project or task.
        </ConnectNotice>
      ) : n === 0 ? (
        <EmptyRow>No projects for this account in Project-Ops yet.</EmptyRow>
      ) : (
        <ul className="-mx-1 space-y-0.5">
          {panel.projects.map((p) => {
            const s = projectStatusLabel(p.status);
            const due = fmtDate(p.dueDate);
            return (
              <ListRow
                key={p.id}
                leadingDot="bg-feat-projects/70"
                title={
                  <span className="inline-flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{p.title}</span>
                    <span className="shrink-0 font-mono text-[11px] font-normal text-tertiary">{p.projectNumber}</span>
                  </span>
                }
                meta={
                  <span className="inline-flex items-center gap-1.5">
                    <ProjectPriorityTag priority={p.priority} />
                    {due && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" strokeWidth={2.25} />
                        due {due}
                      </span>
                    )}
                    {p.assignedTo?.displayName && (
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" strokeWidth={2.25} />
                        {p.assignedTo.displayName}
                      </span>
                    )}
                    <span
                      className="text-[10px] font-medium text-tertiary"
                      title={p.matchedBy === 'name' ? 'Matched by project/client name' : 'Linked by relationship id'}
                    >
                      {p.matchedBy === 'name' ? 'matched by name' : 'linked by id'}
                    </span>
                  </span>
                }
                trailing={<StatusPill status={s} />}
              />
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}

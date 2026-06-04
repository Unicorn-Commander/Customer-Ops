import Link from 'next/link';
import {
  Users, Banknote, BadgeCheck, AlarmClock, Sparkles, Upload, ArrowRight, Flame, Waypoints, ArrowUpRight,
} from 'lucide-react';
import { Card, Stat, StageBadge, Button } from '@/components/ui';
import { STAGE_META } from '@/components/ui/tokens';
import { IconTile } from '@/components/ui/IconTile';
import type { GraphData } from './KnowledgeGraph';
import { KnowledgeGraph3D } from './KnowledgeGraph3D';
import { money, STAGES, type PipelineBoard, type Stage, type Priority } from '@/lib/customers';

export interface AttentionItem {
  id: string;
  name: string;
  stage: Stage;
  priority: Priority;
  note: string;
}
export interface ActivityItem {
  id: string;
  name: string;
  stage: Stage;
  text: string;
  when: string;
}
export interface CockpitProps {
  userName: string;
  board: PipelineBoard;
  attention: AttentionItem[];
  activity: ActivityItem[];
  graph?: GraphData;
}

const PRIORITY_TONE: Record<Priority, string> = {
  HIGH: 'text-danger',
  MEDIUM: 'text-warning',
  LOW: 'text-tertiary',
};

export function CockpitDashboard({ userName, board, attention, activity, graph }: CockpitProps) {
  const laneOf = (s: Stage) => board.lanes.find((l) => l.stage === s);
  const count = (s: Stage) => laneOf(s)?.count ?? 0;
  const maxCount = Math.max(1, ...board.lanes.map((l) => l.count));
  const total = board.totals.count;
  const won = count('CUSTOMER');
  const leadToProspect = count('LEAD') ? Math.round((count('PROSPECT') / count('LEAD')) * 100) : 0;
  const prospectToCustomer = count('PROSPECT') ? Math.round((won / count('PROSPECT')) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-6">
      {/* ---- Hero ---- */}
      <section className="relative overflow-hidden rounded-token-xl border border-subtle bg-surface-raised/60 p-6">
        <div aria-hidden className="co-glow absolute -left-10 -top-16 h-48 w-72 opacity-70" />
        <div aria-hidden className="co-glow co-glow-fuchsia absolute -right-10 -top-20 h-48 w-72 opacity-50" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">
              Customer-Ops · Relationship cockpit
            </p>
            <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-primary">
              Welcome back, {userName} <span className="co-wordmark">✦</span>
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-tertiary">
              Run the whole lifecycle in one place — source a lead, work it through outreach, qualify,
              convert, then keep the relationship warm. Contacts federate from Contact-Ops; the funnel lives here.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button glow leading={<Sparkles className="h-4 w-4" strokeWidth={2.4} />}>Triage leads</Button>
            <Button variant="secondary" leading={<Upload className="h-4 w-4" strokeWidth={2.4} />}>Import</Button>
          </div>
        </div>
      </section>

      {/* ---- KPI row ---- */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Active relationships" value={total} icon={Users}
          gradient="from-violet-500 to-fuchsia-500"
          sub={`${count('LEAD')} leads · ${count('PROSPECT')} prospects · ${won} customers`}
        />
        <Stat
          glow label="Pipeline value" value={money(board.totals.expectedValue)} icon={Banknote}
          gradient="from-emerald-400 to-teal-500"
          sub="Expected across open stages"
        />
        <Stat
          label="Customers won" value={won} icon={BadgeCheck}
          gradient="from-emerald-500 to-green-600"
          delta={{ value: `${prospectToCustomer}% close`, positive: true }}
          sub="Converted this cycle"
        />
        <Stat
          label="Needs attention" value={attention.length} icon={AlarmClock}
          gradient="from-amber-400 to-orange-500"
          sub="Overdue next-actions & hot leads"
        />
      </section>

      {/* ---- Knowledge graph (centerpiece) ---- */}
      {graph && (
        <section className="co-glass co-glass-edge relative overflow-hidden p-5">
          <div aria-hidden className="co-glow co-glow-cyan absolute -right-16 -top-24 h-56 w-80 opacity-50" />
          <div aria-hidden className="co-glow absolute -left-20 top-10 h-56 w-72 opacity-40" />
          <div className="relative mb-1 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <IconTile icon={Waypoints} gradient="from-cyan-400 to-blue-500" size="sm" />
              <div>
                <h3 className="text-sm font-semibold text-primary">Relationship graph</h3>
                <p className="text-[11px] text-tertiary">{graph.nodes.length} entities · {graph.edges.length} links · live 3D</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-3 text-[11px] text-tertiary sm:flex">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-lead" />Lead</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-prospect" />Prospect</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-customer" />Customer</span>
              </div>
              <Link href="/dashboard/graph" className="inline-flex items-center gap-1 rounded-token border border-subtle bg-surface-raised/70 px-2.5 py-1.5 text-xs font-medium text-secondary transition-colors hover:text-primary">
                Explore <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />
              </Link>
            </div>
          </div>
          <div className="relative -mx-1 h-[384px] w-[calc(100%+0.5rem)]">
            <KnowledgeGraph3D data={graph} preview />
          </div>
        </section>
      )}

      {/* ---- Funnel + attention ---- */}
      <section className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded>
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-primary">The funnel</h3>
            <span className="text-xs text-tertiary">{total} in flight · {money(board.totals.expectedValue)}</span>
          </div>

          <div className="space-y-4">
            {STAGES.map((stage, i) => {
              const lane = laneOf(stage);
              const c = lane?.count ?? 0;
              const meta = STAGE_META[stage];
              const pct = Math.round((c / maxCount) * 100);
              return (
                <div key={stage}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <StageBadge stage={stage} />
                    <span className="text-tertiary">
                      <span className="font-mono font-semibold text-primary tabular-nums">{c}</span>
                      <span className="mx-1.5 text-muted">·</span>
                      <span className="font-mono tabular-nums">{money(lane?.expectedValue ?? '0')}</span>
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-overlay">
                    <div
                      className={`h-full rounded-full ${meta.dot}`}
                      style={{ width: `${Math.max(pct, 3)}%`, transition: 'width var(--co-dur) var(--co-ease)' }}
                    />
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className="mt-2 flex items-center gap-1.5 pl-1 text-[11px] text-muted">
                      <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
                      {i === 0 ? `${leadToProspect}% qualify to prospect` : `${prospectToCustomer}% convert to customer`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Needs attention */}
        <Card padded>
          <div className="mb-4 flex items-center gap-2.5">
            <IconTile icon={Flame} gradient="from-rose-500 to-orange-500" size="sm" />
            <h3 className="text-sm font-semibold text-primary">Needs your attention</h3>
          </div>
          <ul className="space-y-1">
            {attention.length === 0 && <li className="py-6 text-center text-sm text-tertiary">All clear — nothing overdue.</li>}
            {attention.map((a) => (
              <li key={a.id} className="group flex items-center gap-3 rounded-token px-2 py-2 transition-colors hover:bg-surface-overlay">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STAGE_META[a.stage].dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-primary">{a.name}</div>
                  <div className="truncate text-xs text-tertiary">{a.note}</div>
                </div>
                <span className={`text-[11px] font-semibold ${PRIORITY_TONE[a.priority]}`}>{a.priority}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* ---- Recent activity ---- */}
      <Card padded>
        <h3 className="mb-4 text-sm font-semibold text-primary">Recent activity</h3>
        <ul className="space-y-0">
          {activity.map((ev, i) => (
            <li key={ev.id} className="flex items-center gap-3 py-2.5" style={i ? { borderTop: '1px solid rgb(var(--co-edge-subtle))' } : undefined}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${STAGE_META[ev.stage].well}`}>
                <span className={`h-2 w-2 rounded-full ${STAGE_META[ev.stage].dot}`} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-sm text-secondary"><span className="font-medium text-primary">{ev.name}</span> {ev.text}</span>
              </div>
              <span className="shrink-0 text-xs text-muted">{ev.when}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

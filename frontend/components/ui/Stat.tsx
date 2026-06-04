import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';
import { IconTile } from './IconTile';

export interface StatProps {
  label: string;
  value: ReactNode;
  /** A small caption under the value (e.g. "$182k expected"). */
  sub?: ReactNode;
  /** Signed delta, rendered in money-green / loss-red. */
  delta?: { value: string; positive: boolean } | null;
  icon?: LucideIcon;
  /** Premium gradient app-icon tile, e.g. "from-violet-500 to-fuchsia-500". */
  gradient?: string;
  /** Fallback (no gradient): a tinted-well glyph. */
  iconText?: string;
  iconWell?: string;
  /** Accent the whole card with a faint top bloom. */
  glow?: boolean;
}

/** Stat — a KPI tile for the dashboard hero. Big number, colored icon chip,
 *  optional signed delta. */
export function Stat({ label, value, sub, delta, icon: Icon, gradient, iconText, iconWell, glow }: StatProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-token-lg border border-subtle bg-surface-raised p-5 shadow-token',
        'co-lift',
      )}
    >
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full opacity-60 blur-2xl"
          style={{ background: 'radial-gradient(circle, rgb(var(--co-accent) / 0.4), transparent 70%)' }}
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-tertiary">{label}</span>
        {Icon &&
          (gradient ? (
            <IconTile icon={Icon} gradient={gradient} size="md" />
          ) : (
            <span className={cn('grid h-9 w-9 place-items-center rounded-token', iconWell ?? 'bg-accent/12')}>
              <Icon className={cn('h-[18px] w-[18px]', iconText ?? 'text-accent')} strokeWidth={2.25} />
            </span>
          ))}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tracking-tight text-primary tabular-nums">{value}</span>
        {delta && (
          <span className={cn('text-xs font-semibold', delta.positive ? 'text-pos' : 'text-neg')}>
            {delta.positive ? '▲' : '▼'} {delta.value}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-xs text-tertiary">{sub}</div>}
    </div>
  );
}

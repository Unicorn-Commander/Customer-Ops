import { cn } from './cn';
import { STAGE_META } from './tokens';
import type { Stage } from '@/lib/customers';

/** StageBadge — the funnel-stage pill with its hue + icon. */
export function StageBadge({ stage, className }: { stage: Stage; className?: string }) {
  const m = STAGE_META[stage];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        m.well, m.text, className,
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      {m.label}
    </span>
  );
}

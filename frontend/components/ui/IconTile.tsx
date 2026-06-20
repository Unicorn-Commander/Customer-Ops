import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

const DIM: Record<string, string> = { sm: 'h-7 w-7 rounded-[9px]', md: 'h-8 w-8 rounded-[10px]', lg: 'h-11 w-11 rounded-[13px]' };
const GLYPH: Record<string, string> = { sm: 'h-[15px] w-[15px]', md: 'h-[18px] w-[18px]', lg: 'h-[23px] w-[23px]' };

/**
 * IconTile — a premium "app-icon" glyph: a vivid 2-tone gradient rounded tile
 * with a crisp white icon, an inner top light-line, and a soft drop shadow. Far
 * more legible + modern than a bare line icon floating on a surface.
 */
export function IconTile({
  icon: Icon, gradient, size = 'md', className, glow = false,
}: {
  icon: LucideIcon;
  /** Tailwind gradient stops, e.g. "from-violet-500 to-fuchsia-500". */
  gradient: string;
  size?: 'sm' | 'md' | 'lg';
  glow?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center bg-gradient-to-br',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_3px_8px_-2px_rgba(0,0,0,0.45)]',
        DIM[size], gradient, glow && 'ring-1 ring-white/10', className,
      )}
    >
      <Icon aria-hidden focusable={false} className={cn('text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.25)]', GLYPH[size])} strokeWidth={2.4} />
    </span>
  );
}

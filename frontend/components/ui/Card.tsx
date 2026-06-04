import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  /** Lift a step on hover — for clickable cards. */
  interactive?: boolean;
  /** Cinematic translucent glass surface (hero / command surfaces). */
  glass?: boolean;
}

/** Card — a raised surface separated from the page by LUMINANCE (dark) or a soft
 *  shadow (light). `glass` swaps in the cinematic layered-glass treatment. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padded, interactive, glass, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        glass
          ? 'co-glass co-glass-edge text-secondary'
          : 'rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token',
        padded && 'p-5',
        interactive && 'co-lift cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-start justify-between gap-3 border-b border-subtle p-5', className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold text-primary', className)} {...rest} />;
}
export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...rest} />;
}

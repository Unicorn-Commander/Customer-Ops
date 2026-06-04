'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowLeft, RotateCcw, SearchX } from 'lucide-react';
import { Button, cn } from '@/components/ui';

/** A shimmering placeholder block (reduced-motion safe via motion-safe:). */
function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-token bg-surface-overlay/70 motion-safe:animate-pulse',
        className,
      )}
    />
  );
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised shadow-token">
      <div className="flex items-center gap-2.5 border-b border-subtle px-4 py-3">
        <Shimmer className="h-7 w-7" />
        <div className="flex-1 space-y-1.5">
          <Shimmer className="h-3 w-28" />
          <Shimmer className="h-2.5 w-20" />
        </div>
      </div>
      <div className="space-y-2.5 p-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <Shimmer className="h-3.5 w-2/3" />
            <Shimmer className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The full-view loading skeleton — mirrors the real header + two-column layout. */
export function Customer360Skeleton() {
  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      {/* header */}
      <div className="rounded-token-xl border border-subtle bg-surface-raised/70 p-6">
        <Shimmer className="h-3 w-24" />
        <div className="mt-3 flex items-start justify-between gap-5">
          <div className="flex items-start gap-4">
            <Shimmer className="h-14 w-14 rounded-token-lg" />
            <div className="space-y-2.5 pt-1">
              <Shimmer className="h-6 w-56" />
              <Shimmer className="h-3.5 w-72" />
              <Shimmer className="h-3 w-44" />
            </div>
          </div>
          <div className="flex gap-2">
            <Shimmer className="h-[34px] w-40 rounded-token" />
            <Shimmer className="h-[34px] w-24 rounded-token" />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-subtle pt-4 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Shimmer className="h-2.5 w-16" />
              <Shimmer className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
      {/* body */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <PanelSkeleton rows={5} />
        <div className="space-y-4">
          <PanelSkeleton rows={3} />
          <PanelSkeleton rows={2} />
          <PanelSkeleton rows={3} />
        </div>
      </div>
    </div>
  );
}

/** A centered status panel (shared by the error + not-found states). */
function CenteredState({
  icon: Icon,
  tone,
  title,
  children,
  actions,
}: {
  icon: typeof AlertTriangle;
  tone: 'danger' | 'neutral';
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up">
      <div className="mx-auto mt-10 max-w-md rounded-token-lg border border-subtle bg-surface-raised p-8 text-center shadow-token">
        <span
          className={cn(
            'mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full',
            tone === 'danger' ? 'bg-danger-subtle text-danger' : 'bg-surface-overlay text-tertiary',
          )}
        >
          <Icon className="h-7 w-7" strokeWidth={2} />
        </span>
        <h2 className="text-base font-semibold text-primary">{title}</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-tertiary">{children}</p>
        {actions && <div className="mt-5 flex items-center justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** The error state — a real message + a retry. */
export function Customer360Error({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <CenteredState
      icon={AlertTriangle}
      tone="danger"
      title="Couldn’t load this relationship"
      actions={
        <>
          {onRetry && (
            <Button size="sm" leading={<RotateCcw className="h-4 w-4" strokeWidth={2.4} />} onClick={onRetry}>
              Try again
            </Button>
          )}
          <Link href="/dashboard/customers">
            <Button size="sm" variant="ghost" leading={<ArrowLeft className="h-4 w-4" strokeWidth={2.4} />}>
              Back to relationships
            </Button>
          </Link>
        </>
      }
    >
      {message}
    </CenteredState>
  );
}

/** The not-found / empty state (no record for this id). */
export function Customer360NotFound() {
  return (
    <CenteredState
      icon={SearchX}
      tone="neutral"
      title="Relationship not found"
      actions={
        <Link href="/dashboard/customers">
          <Button size="sm" leading={<ArrowLeft className="h-4 w-4" strokeWidth={2.4} />}>
            Back to relationships
          </Button>
        </Link>
      }
    >
      This relationship doesn’t exist, or you don’t have access to it in this workspace.
    </CenteredState>
  );
}

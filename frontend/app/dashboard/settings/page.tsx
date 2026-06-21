'use client';

/* =============================================================================
   Settings — the section landing
   -----------------------------------------------------------------------------
   A simple shell that lists the cockpit's settings sections as cards.
   Integrations is the first (and currently only) live section; the rest are
   shown as honest "coming" cards — present so the shape is clear, but plainly
   not yet available (no fake controls). The voice stays plain + sovereign.
   ========================================================================== */

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Settings, Network, UserCircle, Building2, ArrowRight } from 'lucide-react';
import { cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { ApiTokensCard } from './api-tokens-card';

interface Section {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  gradient: string;
  href?: string;
  /** When set, the section renders as a non-clickable "coming" card. */
  coming?: boolean;
}

const SECTIONS: Section[] = [
  {
    key: 'integrations',
    title: 'Integrations',
    description: 'The live federation connections to your suite — what’s connected, and what each seam brings into a customer’s profile.',
    icon: Network,
    gradient: 'from-cyan-400 to-blue-500',
    href: '/dashboard/settings/integrations',
  },
  {
    key: 'profile',
    title: 'Profile',
    description: 'Your name, sign-in, and the workspaces you belong to. Identity is managed through suite SSO.',
    icon: UserCircle,
    gradient: 'from-violet-500 to-fuchsia-500',
    href: '/dashboard/settings/profile',
  },
  {
    key: 'workspace',
    title: 'Workspace',
    description: 'Members, roles, and workspace identity. Each workspace stays fully separated.',
    icon: Building2,
    gradient: 'from-amber-400 to-orange-500',
    href: '/dashboard/settings/workspace',
  },
];

/* ── a section card (a Link when live, a muted div when coming) ──────────────── */
function SectionCard({ section }: { section: Section }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <IconTile icon={section.icon} gradient={section.gradient} size="lg" />
        {section.coming ? (
          <span className="rounded-full bg-surface-overlay px-2.5 py-0.5 text-[11px] font-medium text-tertiary">
            Coming
          </span>
        ) : (
          <ArrowRight className="h-4 w-4 text-tertiary transition-transform duration-fast ease-token group-hover:translate-x-0.5 group-hover:text-primary" strokeWidth={2.25} />
        )}
      </div>
      <h2 className="mt-3.5 text-sm font-semibold text-primary">{section.title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-tertiary">{section.description}</p>
    </>
  );

  if (section.coming || !section.href) {
    return (
      <div className="rounded-token-lg border border-subtle bg-surface-raised p-5 opacity-70">
        {body}
      </div>
    );
  }

  return (
    <Link
      href={section.href}
      className={cn(
        'group rounded-token-lg border border-subtle bg-surface-raised p-5 shadow-token co-lift',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
      {body}
    </Link>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */
export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-6">
      {/* Header */}
      <header className="co-glass co-glass-edge flex items-center gap-3 rounded-token-lg p-5">
        <IconTile icon={Settings} gradient="from-slate-400 to-slate-600" size="lg" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-primary">Settings</h1>
          <p className="mt-1 text-[13px] text-tertiary">Configure your cockpit. Manage the suite connections that feed it.</p>
        </div>
      </header>

      {/* Section cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => <SectionCard key={s.key} section={s} />)}
      </div>

      {/* Personal access tokens — a live, inline section (not a sub-page link) */}
      <ApiTokensCard />
    </div>
  );
}

'use client';

/* =============================================================================
   Help — the full, scannable help section
   -----------------------------------------------------------------------------
   The complete help reference: every topic from `lib/help-content.ts` (the same
   content the `?` quick-drawer uses) rendered as anchored, scannable sections
   with a sticky left mini-TOC. The `?` in the top bar stays the quick,
   contextual help; this page is the full read.

   Footer actions mirror the drawer: a link to the full user guide and "Replay
   the welcome tour" (reuses the exact OnboardingTour component the first-run
   flow uses, opened with local state here).
   ========================================================================== */

import { useState } from 'react';
import { LifeBuoy, BookOpen, Sparkles, ShieldCheck } from 'lucide-react';
import { cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { OnboardingTour, markOnboarded } from '@/components/help/OnboardingTour';
import { HELP_TOPICS, USER_GUIDE_URL, type HelpBlock } from '@/lib/help-content';

/* The full user guide — same target the drawer footer links to. */
const GUIDE_HREF = USER_GUIDE_URL;

/* ── one block (paragraph or bullet list) — matches HelpPanel's renderer ────── */
function Block({ block }: { block: HelpBlock }) {
  if (block.kind === 'p') {
    return <p className="text-sm leading-relaxed text-secondary">{block.text}</p>;
  }
  return (
    <ul className="space-y-2">
      {block.items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-secondary">
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */
export default function HelpPage() {
  const [tourOpen, setTourOpen] = useState(false);

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-up space-y-6">
      {/* ── Header ── */}
      <header className="co-glass co-glass-edge flex items-start gap-3 rounded-token-lg p-5">
        <IconTile icon={LifeBuoy} gradient="from-fuchsia-500 to-pink-500" size="lg" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-primary">Help</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-tertiary">
            The complete guide to your relationship cockpit. Looking for a quick answer? The
            {' '}<span className="font-medium text-secondary">?</span> in the top bar opens contextual help for the page
            you&rsquo;re on.
          </p>
        </div>
      </header>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        {/* ── Mini-TOC (sticky on desktop) ── */}
        <nav aria-label="Help contents" className="mb-6 lg:mb-0">
          <div className="lg:sticky lg:top-[84px]">
            <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">On this page</div>
            <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
              {HELP_TOPICS.map((topic) => (
                <li key={topic.id}>
                  <a
                    href={`#${topic.id}`}
                    className={cn(
                      'flex items-center gap-2 rounded-token px-2.5 py-1.5 text-[13px] text-tertiary',
                      'transition-colors hover:bg-surface-raised hover:text-primary',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <IconTile icon={topic.icon} gradient={topic.gradient} size="sm" />
                    <span className="truncate">{topic.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* ── Topic sections ── */}
        <div className="min-w-0 space-y-4">
          {/* Persona / framing line — mirrors the drawer's intro */}
          <div className="flex items-start gap-2.5 rounded-token-lg border border-subtle bg-surface-raised px-4 py-3.5">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-accent/12 text-accent">
              <ShieldCheck className="h-[17px] w-[17px]" strokeWidth={2.25} />
            </span>
            <p className="text-[13px] leading-relaxed text-tertiary">
              Customer-Ops is a surface, not an engine — it federates your suite into one living relationship graph. Your
              Relations Officer proposes; you decide.
            </p>
          </div>

          {HELP_TOPICS.map((topic) => (
            <section
              key={topic.id}
              id={topic.id}
              className="scroll-mt-[84px] overflow-hidden rounded-token-lg border border-subtle bg-surface-raised shadow-token"
            >
              <header className="flex items-center gap-2.5 border-b border-subtle px-5 py-4">
                <IconTile icon={topic.icon} gradient={topic.gradient} size="md" />
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-primary">{topic.title}</h2>
                  <p className="truncate text-[11px] text-tertiary">{topic.summary}</p>
                </div>
              </header>
              <div className="space-y-3.5 px-5 py-4">
                {topic.body.map((block, i) => <Block key={i} block={block} />)}
              </div>
            </section>
          ))}

          {/* ── Footer actions ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setTourOpen(true)}
              className={cn(
                'flex items-center gap-3 rounded-token-lg border border-subtle bg-surface-raised px-4 py-3.5 text-left shadow-token co-lift',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              )}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-subtle bg-surface-overlay text-accent">
                <Sparkles className="h-[17px] w-[17px]" strokeWidth={2.25} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-primary">Replay the welcome tour</span>
                <span className="block text-[11px] text-tertiary">Walk through the cockpit again</span>
              </span>
            </button>

            <a
              href={GUIDE_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'flex items-center gap-3 rounded-token-lg border border-subtle bg-surface-raised px-4 py-3.5 shadow-token co-lift',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              )}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-subtle bg-surface-overlay text-tertiary">
                <BookOpen className="h-[17px] w-[17px]" strokeWidth={2.25} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-primary">Full user guide</span>
                <span className="block text-[11px] text-tertiary">The complete walkthrough</span>
              </span>
            </a>
          </div>

          <p className="px-1 text-center text-[11px] text-muted">
            Need more? Ask your Relations Officer on the Agents page — it knows your book.
          </p>
        </div>
      </div>

      {/* The exact first-run tour component, opened on demand here. */}
      <OnboardingTour open={tourOpen} onClose={() => setTourOpen(false)} onComplete={markOnboarded} />
    </div>
  );
}

import type { Metadata } from 'next';
import { ArrowRight, CheckCircle2, Radar, ShieldCheck } from 'lucide-react';
import { LandingGate } from '@/components/LandingGate';

export const metadata: Metadata = {
  title: 'Customer-Ops | Magic Unicorn',
  description:
    "Every customer's invoices, emails, meetings, and projects in one live 360, with an AI Relations Officer who drafts the next move.",
  alternates: { canonical: 'https://customer-ops.unicorncommander.ai/' },
  openGraph: {
    type: 'website',
    url: 'https://customer-ops.unicorncommander.ai/',
    title: 'Customer-Ops | Magic Unicorn',
    description:
      "Every customer's invoices, emails, meetings, and projects in one live 360, with an AI Relations Officer who drafts the next move.",
  },
};

const valueProps = [
  'Your pipeline stays current without anyone re-keying data into a CRM.',
  'Follow-ups, meeting prep, and collections nudges show up already drafted.',
  'Every write and every agent run lands in an append-only audit log.',
];

const steps = [
  ['Connect once', 'Customer-Ops reads contacts, books, mail, meetings, and projects live from the apps that own them.'],
  ['Agents work the pipeline', 'Five relationship agents triage leads, prepare meetings, and draft the next move.'],
  ['You confirm, it acts', 'Proposed actions execute only after confirmation, with a complete audit trail.'],
];

export default function Home() {
  return (
    <>
      <LandingGate />
      <main className="co-ambient co-ambient-grid min-h-screen overflow-hidden px-6 py-8 sm:px-10 lg:px-14">
        <nav className="mx-auto flex w-full max-w-6xl items-center justify-between" aria-label="Primary navigation">
          <a href="/" className="flex items-center gap-3" aria-label="Customer-Ops home">
            <img src="/brand-mark.png" alt="" className="h-11 w-11 rounded-[13px] shadow-glow" />
            <span className="text-lg font-semibold tracking-tight"><span className="co-wordmark">Customer</span><span className="text-tertiary">-Ops</span></span>
          </a>
          <a href="/?app=1" className="inline-flex items-center gap-2 rounded-token bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-glow transition-transform hover:-translate-y-0.5">
            Open the app <ArrowRight className="h-4 w-4" />
          </a>
        </nav>

        <section className="mx-auto grid w-full max-w-6xl gap-10 pb-20 pt-20 lg:grid-cols-[1.2fr_0.8fr] lg:items-center lg:pt-28">
          <div className="animate-fade-up">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-accent">AI employee · Sales-ops manager</p>
            <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[1.03] tracking-[-0.04em] text-primary sm:text-6xl lg:text-7xl">
              Every customer relationship, <span className="co-wordmark">alive in one cockpit.</span>
            </h1>
            <p className="mt-7 max-w-3xl text-lg leading-8 text-secondary sm:text-xl">
              Every customer&apos;s invoices, emails, meetings, and projects in one live 360, with an AI Relations Officer who drafts the next move.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <span className="rounded-full border border-subtle bg-surface-raised px-4 py-2 text-sm font-semibold text-secondary">In development</span>
              <span className="rounded-full border border-success/30 bg-success/10 px-4 py-2 text-sm font-semibold text-success">We run our company on this.</span>
            </div>
            <div className="mt-9 flex flex-wrap gap-3">
              <a href="/?app=1" className="inline-flex items-center gap-2 rounded-token bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast shadow-glow transition-transform hover:-translate-y-0.5">
                Open the live app <ArrowRight className="h-4 w-4" />
              </a>
              <a href="https://magicunicorn.dev/log" className="inline-flex items-center gap-2 rounded-token border border-subtle bg-surface-raised px-5 py-3 text-sm font-semibold text-secondary transition-colors hover:text-primary">
                Follow the build log
              </a>
            </div>
            <p className="mt-4 text-sm text-tertiary">One Unicorn Commander login covers the whole suite.</p>
          </div>

          <div className="co-glass co-glass-edge relative p-7 sm:p-9">
            <div aria-hidden className="co-glow absolute -inset-10 opacity-60" />
            <div className="relative">
              <div className="mb-7 flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-gradient-to-br from-accent to-fuchsia text-white shadow-glow"><Radar className="h-6 w-6" /></span>
                <div><p className="font-semibold text-primary">Relations Officer</p><p className="text-sm text-tertiary">Watching the whole customer picture</p></div>
              </div>
              <div className="space-y-4">
                {valueProps.map((item) => <div key={item} className="flex gap-3 rounded-token border border-subtle bg-surface-overlay/70 p-4"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" /><p className="text-sm leading-6 text-secondary">{item}</p></div>)}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl border-t border-subtle py-20">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-accent">How it works</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-primary sm:text-4xl">Meet the customer. Act. Close the loop.</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {steps.map(([title, body], index) => <article key={title} className="co-glass co-glass-edge p-6"><span className="font-mono text-xs text-accent">0{index + 1}</span><h3 className="mt-4 text-lg font-semibold text-primary">{title}</h3><p className="mt-3 text-sm leading-6 text-tertiary">{body}</p></article>)}
          </div>
        </section>

        <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 border-t border-subtle py-16 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="flex items-center gap-2 text-sm font-semibold text-success"><ShieldCheck className="h-4 w-4" /> Sovereign infrastructure</p><h2 className="mt-3 text-3xl font-semibold tracking-tight text-primary">Your customer data stays on a stack you control.</h2></div>
          <a href="/?app=1" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-token bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast shadow-glow">Open the app <ArrowRight className="h-4 w-4" /></a>
        </section>
      </main>
    </>
  );
}

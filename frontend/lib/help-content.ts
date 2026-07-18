/**
 * Help content model — the single source of truth for the in-app Help panel.
 *
 * Each topic mirrors a section of the public user guide (condensed for in-app
 * reading — no invented features). The Help panel renders these as collapsible,
 * scannable sections; `routeTopic()` maps the current route to the topic to open
 * to first, so opening Help on a customer page lands on "The customer-360".
 *
 * Pure data + a couple of pure helpers — no React, no `'use client'`, so both the
 * panel and (later) any other surface can import it freely.
 */
import {
  LayoutDashboard, Filter, Users, Waypoints, Bot, UserPlus, HelpCircle,
  type LucideIcon,
} from 'lucide-react';

/** Placeholder URL for the public user guide. */
export const USER_GUIDE_URL = 'https://docs.customer-ops.example.com';

/** A short paragraph or a bullet line inside a topic. */
export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] };

export interface HelpTopic {
  /** Stable id — anchors route-aware scroll + the collapsible open-state. */
  id: string;
  title: string;
  /** One-line summary shown under the title when collapsed. */
  summary: string;
  icon: LucideIcon;
  /** Two-stop gradient for the topic's IconTile — mirrors the nav language. */
  gradient: string;
  body: HelpBlock[];
}

/**
 * The topics, in reading order. Faithful to USER-GUIDE.md §2–§8 and condensed.
 * Gradients echo `lib/nav.ts` so the panel reads as the same cockpit.
 */
export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'dashboard',
    title: 'The dashboard',
    summary: 'Your home screen — start the day here.',
    icon: LayoutDashboard,
    gradient: 'from-indigo-500 to-violet-500',
    body: [
      { kind: 'p', text: 'Your home screen — the whole book of relationships at a glance.' },
      {
        kind: 'list',
        items: [
          'Needs attention — relationships that are high priority or have an overdue next action. Start here.',
          'Recent activity — the latest stage changes across your book.',
          'Pipeline snapshot — how many relationships sit in each stage, and their value.',
          'The graph — a live constellation of your contacts and the people, orgs, and deals around them.',
        ],
      },
      { kind: 'p', text: `You only ever see your workspace’s data — each workspace stays fully separated. See the [User Guide](${USER_GUIDE_URL}) for more.` },
    ],
  },
  {
    id: 'pipeline',
    title: 'The pipeline',
    summary: 'Lead → Prospect → Customer, left to right.',
    icon: Filter,
    gradient: 'from-amber-400 to-orange-500',
    body: [
      { kind: 'p', text: 'Your funnel, left to right: Lead → Prospect → Customer. Each relationship sits in exactly one stage.' },
      {
        kind: 'list',
        items: [
          'Lead (cyan) — a new signal; sourced, not yet worked.',
          'Prospect (coral) — an active relationship you’re qualifying or converting.',
          'Customer (green) — won.',
        ],
      },
      { kind: 'p', text: 'Drag a card, or use the relationship’s menu, to move a stage. Every move is logged on the timeline, so you always have the history.' },
      { kind: 'p', text: 'A relationship can be marked Lost (with a reason) and reopened later — nothing is ever truly gone.' },
    ],
  },
  {
    id: 'customer360',
    title: 'The customer-360',
    summary: 'One screen for everything connected to a person.',
    icon: Users,
    gradient: 'from-violet-500 to-fuchsia-500',
    body: [
      { kind: 'p', text: 'Click any contact to open their 360 — one screen that pulls together the relationship and everything linked to it: contact details, the deal, projects, invoices, email, meetings, and outreach.' },
      { kind: 'p', text: 'The panels are federated: they show live data from the other apps in your suite, fetched the moment you open the view. Customer-Ops never copies that data — it always shows the real, current source.' },
      { kind: 'p', text: 'If a panel says “connect ‹App›,” that sibling app isn’t wired into your deployment yet — the cockpit keeps working, that panel just stays quiet. If a panel is connected but empty, there simply isn’t data for that contact yet. See the [User Guide](${USER_GUIDE_URL}) for more.' },
    ],
  },
  {
    id: 'graph',
    title: 'The relationship graph',
    summary: 'People, orgs & deals as a living network.',
    icon: Waypoints,
    gradient: 'from-cyan-400 to-blue-500',
    body: [
      { kind: 'p', text: 'Customer-Ops is graph-native: every contact, org, deal, meeting, invoice, and campaign is a node, and the links between them are real, walkable edges.' },
      { kind: 'p', text: 'Open Graph to explore. You’ll see a contact at the center with edges fanning out to the org they work at, the deal they own, the meetings they attended, the invoices they were billed for, the emails and campaigns they’re part of, and the source they came from.' },
      { kind: 'p', text: 'Click a node to recenter on it and follow the relationships outward. The graph updates itself as you work — every change is reflected automatically. See the [User Guide](${USER_GUIDE_URL}) for more.' },
    ],
  },
  {
    id: 'agents',
    title: 'The Relations Officer & agents',
    summary: 'Your AI colleague — it proposes, you decide.',
    icon: Bot,
    gradient: 'from-violet-500 to-cyan-500',
    body: [
      { kind: 'p', text: 'The Relations Officer is your AI colleague for relationship work. It doesn’t act on its own — it proposes, you decide. Behind it is a focused team you can call on:' },
      {
        kind: 'list',
        items: [
          'Lead triage — score and route a new lead.',
          'Next best action — suggest the next move on a contact.',
          'Meeting prep — build a brief before a meeting.',
          'Follow-up drafter — draft a follow-up message.',
          'Collections nudge — draft a nudge on an overdue invoice.',
        ],
      },
      { kind: 'p', text: 'By default the agents run on your own local models — private, on your infrastructure, no per-word cost. For a task that warrants extra horsepower, you (or an admin) can route a single call to a frontier model. Either way you get a draft or a recommendation; nothing is sent or changed until you say so. See the [User Guide](${USER_GUIDE_URL}) for more.' },
    ],
  },
  {
    id: 'leads',
    title: 'Adding leads',
    summary: 'New relationships enter as leads.',
    icon: UserPlus,
    gradient: 'from-lime-400 to-emerald-500',
    body: [
      { kind: 'p', text: 'New relationships enter Customer-Ops as leads — either manually (create a contact from the cockpit) or by ingestion (leads flow in from your sources — a sent-mail sweep, an import, a form — through the lead intake).' },
      { kind: 'p', text: 'Either way, the underlying contact lives in Contact-Ops — the one phonebook for the whole suite. Customer-Ops adds the relationship (the stage, the pipeline position, the provenance) on top. A “lead” is just a contact at an early stage; promoting it never moves or duplicates the person. See the [User Guide](${USER_GUIDE_URL}) for more.' },
    ],
  },
  {
    id: 'quick-answers',
    title: 'Quick answers',
    summary: 'Common questions, answered fast.',
    icon: HelpCircle,
    gradient: 'from-fuchsia-500 to-pink-500',
    body: [
      {
        kind: 'list',
        items: [
          'A panel says “connect ‹App›.” That sibling app isn’t wired in yet. Nothing’s broken — an admin connects it and the panel fills in automatically.',
          'A connected panel is empty. There’s no data for this contact in that app yet (no invoices, meetings, threads…). It’ll populate as the relationship deepens.',
          '“Could not load / please sign in.” Your session timed out — sign in again. Customer-Ops never stores a password of its own.',
          'A contact shows a placeholder name. It was imported name-only and is still resolving; the real name fills in once it lands in Contact-Ops.',
          'Is my data shared with a vendor? No. Customer-Ops runs on infrastructure you own, and the AI runs on your models by default.',
        ],
      },
      { kind: 'p', text: `For more details, see the [User Guide](${USER_GUIDE_URL}).` },
    ],
  },
];

/**
 * Map the current pathname to the topic to open to first (best-effort).
 * Falls back to the first topic. Order matters: most specific first.
 */
export function routeTopic(pathname: string): string {
  if (pathname.startsWith('/dashboard/customers/')) return 'customer360'; // a 360 detail page
  if (pathname.startsWith('/dashboard/customers')) return 'customer360';
  if (pathname.startsWith('/dashboard/pipeline')) return 'pipeline';
  if (pathname.startsWith('/dashboard/graph')) return 'graph';
  if (pathname.startsWith('/dashboard/leads')) return 'leads';
  return 'dashboard';
}

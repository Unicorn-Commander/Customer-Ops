# Customer‑Ops — User Guide

*Every relationship, connected.*

Customer‑Ops is your relationship cockpit. It's where you run the whole customer journey — from a fresh lead to a long‑term account — and see everything connected to a person in one place: their contact details, the deals you're working, the invoices, the emails, the meetings, the projects, and how they all link together.

This guide walks through the cockpit surface by surface. Each section maps to the in‑app **Help** panel, so you can open Help anywhere and land on the matching topic.

---

## 1. Signing in

Customer‑Ops uses single sign‑on (your Unicorn Commander account). Click **Continue with Unicorn Commander** and you're in — no separate password.

If you ever see a message about reconnecting or your session, just sign in again; your session simply timed out. (Customer‑Ops never stores a password of its own.)

---

## 2. The dashboard

Your home screen. At a glance:

- **Needs attention** — the relationships with a high priority or an overdue next action. Start your day here.
- **Recent activity** — the latest stage changes across your book.
- **Pipeline snapshot** — how many relationships sit in each stage, and their value.
- **The graph** — a live constellation of your contacts and the people, orgs, and deals around them.

Everything is your workspace's data only — Customer‑Ops keeps each workspace fully separated.

---

## 3. The pipeline

The pipeline is your funnel, left to right:

> **Lead** → **Prospect** → **Customer**

Each relationship sits in exactly one stage. Drag or use the customer's menu to **move a stage** — for example, promote a qualified lead to Prospect. Every move is logged on the relationship's timeline, so you always have the history.

- **Lead** *(cyan)* — new signal; sourced, not yet worked.
- **Prospect** *(coral)* — an active relationship you're qualifying or converting.
- **Customer** *(green)* — won.

A relationship can also be marked **Lost** (with a reason) and **reopened** later — nothing is ever truly gone.

---

## 4. The customer‑360

Click any contact to open their **360** — one screen that pulls together the relationship and everything connected to it. The panels are **federated**: they show live data from the other apps in your suite, fetched the moment you open the view. Customer‑Ops doesn't copy that data — it always shows you the real, current source.

| Panel | What you see | Comes from |
|---|---|---|
| **Contact** | Name, org, email, communication strength | Contact‑Ops |
| **Pipeline / stage** | Where this relationship sits + its value | Customer‑Ops |
| **Timeline** | Stage changes, notes, engagement | Customer‑Ops |
| **Projects** | Delivery work running for this account | Project‑Ops |
| **Invoices** | Live billing status | Accounting‑Ops |
| **Email** | Mailbox threads + compose | Email‑Ops |
| **Meetings** | Meetings, summaries, action items | Meeting‑Ops |
| **Outreach** | Campaigns + touches | Outreach |

**If a panel says "connect ‹App›"** — that sibling app isn't wired into your deployment yet. The cockpit keeps working; that panel just stays quiet until it's connected. **If a panel is empty but connected**, there simply isn't data for that contact yet (no invoices raised, no meetings logged, etc.).

---

## 5. The relationship graph

Customer‑Ops is **graph‑native**: every contact, org, deal, meeting, invoice, and campaign is a node, and the links between them are real, walkable edges.

Open **Graph** to explore. You'll see a contact at the center with edges fanning out to:

- the **org** they work at,
- the **deal** they own (labeled with their name and stage),
- the **meetings** they attended, **invoices** they were billed for, **emails** and **campaigns** they're part of,
- and the **source** they came from (or who **referred** them).

Click a node to recenter the graph on it and follow the relationships outward. The graph updates itself as you work — every change you make is reflected automatically.

---

## 6. The Relations Officer & your agent team

The **Relations Officer** is your AI colleague for relationship work. It doesn't act on its own — it **proposes, you decide**. Behind it is a focused team you can call on:

| Agent | Ask it to… |
|---|---|
| **Lead triage** | Score and route a new lead |
| **Next best action** | Suggest the next move on a contact |
| **Meeting prep** | Build a brief before a meeting |
| **Follow‑up drafter** | Draft a follow‑up message |
| **Collections nudge** | Draft a nudge on an overdue invoice |

By default the agents run on **your own local models** — private, on your infrastructure, no per‑word cost. For a task that warrants extra horsepower, you (or an admin) can route a single call to a frontier model. Either way, the agent hands you a draft or a recommendation; nothing is sent or changed until you say so.

---

## 7. Adding leads & contacts

New relationships enter Customer‑Ops as **leads**:

- **Manually** — create a contact from the cockpit.
- **By ingestion** — leads flow in from your sources (a sent‑mail sweep, an import, a form) through the lead intake.

Either way, the underlying **contact lives in Contact‑Ops** — the one phonebook for the whole suite. Customer‑Ops adds the *relationship* (the stage, the pipeline position, the provenance) on top. A "lead" is just a contact at an early stage; promoting it never moves or duplicates the person.

---

## 8. Quick answers

- **A panel says "connect ‹App›."** That sibling app isn't wired in yet. Nothing's broken — connect it (admin) and the panel fills in automatically.
- **A connected panel is empty.** There's no data for this contact in that app yet (no invoices, meetings, threads…). It'll populate as the relationship deepens.
- **"Could not load / please sign in."** Your session timed out — sign in again.
- **A contact shows a placeholder name.** It was imported name‑only and is still being resolved; the real name fills in once it lands in Contact‑Ops.
- **Is my data shared with a vendor?** No. Customer‑Ops runs on infrastructure you own, and the AI runs on your models by default.

---

## 9. For admins & operators

- **Health at a glance:** `GET /api/v1/health/integrations` reports every federation seam as `ok` / `auth-error` / `unreachable` / `not-configured` — the fastest way to see which siblings are connected.
- **The audit trail** — open **System → Audit** to see who did what, when. Every relationship write (stage moves, notes, federated actions) and every agent run is recorded. The trail is **append‑only**: entries are never edited or deleted, so it's a faithful record. You only ever see your own workspace's entries.
- **Personal Access Tokens** — for scripts, integrations, or an MCP agent that needs to act without a browser session. Mint them in **Settings → API tokens**:
  - **The token is shown only once**, right after you create it. Copy it then — you can't see it again. If you lose it, revoke it and mint a new one.
  - **Scope it down.** A token carries only the scopes you grant (e.g. read customers, run agents). It can do nothing outside them — and a token can never mint or revoke other tokens, so a leaked token can't escalate itself.
  - **It's bound to one workspace.** A token only works in the workspace you create it for.
  - **Revoke any time** from the same screen; revocation takes effect immediately.
- **Connecting a sibling app:** see [`README.md`](../README.md#how-it-federates) and the per‑seam settings in [`deploy/.env.example`](../deploy/.env.example).
- **Architecture & internals:** [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **Runbooks:** [`runbooks/`](runbooks/) — deploy, backup/restore, tenancy, inference, entitlements.

---

*Customer‑Ops is a surface, not an engine — it federates your suite into one living relationship graph, and it never becomes a second phonebook or biller. Every relationship, connected.*

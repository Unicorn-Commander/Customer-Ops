<div align="center">

<img src="docs/brand/customer-ops-logo-transparent.png" width="320" alt="Customer-Ops constellation logo">

# Customer-Ops

### The relationship and funnel cockpit for leads, customers, quotes, and outreach.

*Every relationship, connected.*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-2f80ed?style=flat-square)](#licence)
[![Release: 0.12.0](https://img.shields.io/badge/Release-0.12.0-6f42c1?style=flat-square)](#architecture)
[![NestJS 10](https://img.shields.io/badge/NestJS-10-E0234E?style=flat-square&logo=nestjs&logoColor=white)](#architecture)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-000?style=flat-square&logo=nextdotjs&logoColor=white)](#architecture)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)](#architecture)
[![Self-hosted](https://img.shields.io/badge/Deployment-self--hosted-FF5D73?style=flat-square)](#quick-start)
[![MCP server](https://img.shields.io/badge/Agents-MCP--enabled-38DCEB?style=flat-square)](#built-for-agents)

[Quick start](#quick-start) · [Features](#highlights) · [Agents](#built-for-agents) · [Architecture](#architecture) · [Suite](#part-of-unicorn-commander)

</div>

<p align="center">
  <img src="docs/screenshots/dashboard.webp" width="100%" alt="Customer-Ops dashboard with pipeline metrics, attention items, recent activity, and a relationship graph">
</p>

## What is Customer-Ops?

Customer-Ops is the relationship and funnel cockpit for turning leads into customers and keeping the work around each relationship visible. It owns the lifecycle—stage, pipeline, notes, next actions, and optional quote drafts—while resolving contact, invoice, meeting, project, email, and outreach context from the apps that own those records. It is self-hostable, uses Keycloak SSO and Postgres-backed workspace isolation, and gives agents draft and proposal surfaces while workspace roles, PAT scopes, and human confirmation govern writes and outbound work. As part of Unicorn Commander, it uses shared identity and typed federation seams instead of creating duplicate contact or ledger records.

## Highlights

- **A guarded relationship funnel.** Move a relationship from Lead to Prospect to Customer, with one-step qualification rules, lost/reopen state, expected value, priority, owners, and next actions. The pipeline stays legible as work progresses.
- **Customer-360 without a second phonebook.** The relationship record keeps a Contact-Ops reference; customer detail assembles contact, invoice, meeting, project, email, outreach, and conversation panels at read time. Each system remains the source of truth for its own data.
- **A navigable relationship graph.** Customer-Ops projects workspace relationships into FalkorDB with typed people, organizations, deals, interactions, and provenance edges. Incremental post-commit refreshes and an explicit reindex path keep the graph repairable.
- **An idempotent lead front door.** <code>ingest_lead</code> stages an enriched lead, resolves identity through Contact-Ops when available, and can retain a provisional identity for later reconciliation instead of dropping the intake.
- **Quotes and proposals.** The feature-flagged quote workspace supports structured drafts, sections, line items, options, recipients, rendering, version history, and a controlled lifecycle tied to the relationship.
- **Agents that prepare, never silently act.** Relationship agents return assessments, meeting briefs, follow-up drafts, and collections drafts. Agent-generated email can be staged for human approval; agent runs do not auto-send, post invoices, or move stages.
- **Security at the workspace boundary.** Keycloak SSO, membership-aware authorization, Postgres row-level security, scoped Personal Access Tokens, and an append-only audit trail cover both REST and MCP paths.
- **Optional integrations that fail clearly.** Unconfigured or unreachable federation surfaces degrade to a connect state, while <code>GET /api/v1/health/integrations</code> exposes per-seam configuration and probe status.

## Feature tour

### Pipeline

<p align="center">
  <img src="docs/screenshots/pipeline.webp" width="100%" alt="Customer-Ops deal pipeline with Lead, Prospect, and Customer lanes">
</p>

The pipeline board groups relationships by lifecycle stage, expected value, priority, and next action. Drag-and-drop uses the same guarded transition path as the API, so qualification cannot be skipped accidentally.

### Customer-360

<p align="center">
  <img src="docs/screenshots/customer.webp" width="100%" alt="Customer-360 view showing contacts, deals, quotes, and timeline">
</p>

Open one relationship to see its federated contact, local activity timeline, quotes, invoices, email, outreach, meetings, projects, and available agent actions. Local links preserve provenance without copying the sibling systems’ records.

### Relationship graph

<p align="center">
  <img src="docs/screenshots/relationships.webp" width="100%" alt="Interactive Customer-Ops relationship graph showing connected people, organizations, and interactions">
</p>

The graph explorer makes the relationship constellation clickable: inspect a node, expand its neighborhood, and follow typed connections. If FalkorDB is unavailable, the frontend can render a database-derived relationship projection instead.

### Quotes

<p align="center">
  <img src="docs/screenshots/quote.webp" width="100%" alt="Customer-Ops quote workspace for composing a customer proposal">
</p>

Quotes are registered when <code>QUOTES_ENABLED=true</code>. The workspace keeps draft composition and commercial structure in Customer-Ops, renders the document, records versions and events, and routes the controlled send path through Email-Ops.

### Lead intake

<p align="center">
  <img src="docs/screenshots/leads.webp" width="100%" alt="Customer-Ops lead intake dashboard showing staged, resolved, and failed leads">
</p>

The lead intake surface shows what arrived, which identity resolution path succeeded, and what still needs attention. A later reconciliation can promote pending or provisional intakes once the canonical contact source is reachable.

## Built for agents

Customer-Ops exposes a Streamable HTTP MCP server at <code>/api/v1/mcp</code>. Clients authenticate with a session or federation JWT, or with a scoped <code>co_pat_</code> Personal Access Token created from **Settings → API tokens** or <code>POST /api/v1/auth/pats</code>; PAT calls are checked against tool scopes and their workspace binding.

The server registers **24 core tools**, including <code>health</code>, <code>list_my_workspaces</code>, <code>list_customers</code>, <code>get_customer_360</code>, <code>pipeline_board</code>, <code>ingest_lead</code>, <code>lead_intake_stats</code>, <code>resolve_pending_leads</code>, <code>list_customer_invoices</code>, <code>list_customer_email</code>, <code>list_customer_meetings</code>, <code>triage_customer</code>, <code>draft_followup</code>, and <code>draft_collections_nudge</code>. When <code>QUOTES_ENABLED=true</code>, it adds **20 quote tools** for draft composition and quote lifecycle operations.

The REST agent surface contains five draft-only actions: <code>lead-triage</code>, <code>follow-up-draft</code>, <code>collections-nudge</code>, <code>next-best-action</code>, and <code>meeting-prep</code>. The Relations Officer adds advisor/operator chat; operator-mode writes become single-use proposals that a person must confirm. There is no separate A2A agent-card endpoint in this repository—REST and MCP are the supported agent hooks.

<p align="center">
  <img src="docs/brand/relations-officer.jpg" width="220" alt="Illustration of the Customer-Ops Relations Officer">
</p>

Example client configuration for a local self-hosted instance:

~~~json
{
  "mcpServers": {
    "customer-ops": {
      "url": "http://127.0.0.1:3211/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer <co_pat_replace_me>"
      }
    }
  }
}
~~~

Use the smallest PAT scope set the client needs. The plaintext PAT is returned only at creation; replace the placeholder above locally and do not commit it.

## Quick start

### Docker

The self-host stack is the shortest complete path: it bundles PostgreSQL, Keycloak, the Customer-Ops API, and the Next.js cockpit. You need Docker Engine with Compose support for <code>--wait</code>, Git, and Node.js for the bootstrap script.

~~~bash
git clone https://github.com/Unicorn-Commander/Customer-Ops.git
cd Customer-Ops
node deploy/selfhost/bootstrap.cjs
docker compose --env-file deploy/.env -f deploy/docker-compose.selfhost.yml up -d --build --wait --wait-timeout 300
curl -fsS http://127.0.0.1:3211/api/v1/health/live
curl -fsS http://127.0.0.1:3211/api/v1/health/ready
~~~

Open <http://127.0.0.1:3000> and choose **Continue with single sign-on**. The imported local Keycloak realm provides the <code>admin</code> account; read <code>CUSTOMER_OPS_ADMIN_PASSWORD</code> from the generated <code>deploy/.env</code> on your machine. The local stack uses the synthetic <code>admin@example.invalid</code> identity and creates the local workspace membership on first sign-in.

The bootstrap script creates <code>deploy/.env</code> with private file permissions, refuses to overwrite an existing file, and does not print credentials. On a later start, skip the bootstrap step and run the Compose command again. Federation, FalkorDB, inference, and the Microsoft 365 connector remain optional until their environment variables are configured.

### Run from source

Source development still needs a PostgreSQL database and a configured Keycloak SSO client; this repository has no application auth-bypass mode. For a bundled identity provider, use the Docker path above. From the repository root, for an existing development environment:

~~~bash
cd backend
npm ci
cp ../deploy/.env.example .env
# Set DATABASE_URL, ADMIN_DATABASE_URL, JWT_SECRET, and the KEYCLOAK_* values in .env.
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
~~~

In a second terminal:

~~~bash
cd frontend
npm ci
cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://127.0.0.1:3211/api/v1 in .env.local.
npm run dev
~~~

The API serves under <code>/api/v1</code>; the frontend uses the public API URL baked into <code>NEXT_PUBLIC_API_URL</code> at build time.

### Configuration

The canonical template is [deploy/.env.example](deploy/.env.example). It documents the full runtime surface; keep secrets in the environment and never in the README.

| Variable | Meaning |
|---|---|
| <code>NODE_ENV</code>, <code>PORT</code>, <code>API_PREFIX</code> | Runtime mode, API listen port, and global API path prefix |
| <code>DATABASE_URL</code> | Runtime PostgreSQL connection; production uses the row-level-security application role |
| <code>ADMIN_DATABASE_URL</code> | Owner connection used for Prisma migrations |
| <code>POSTGRES_PASSWORD</code>, <code>APP_DB_PASSWORD</code> | Self-host database bootstrap credentials |
| <code>FRONTEND_URL</code>, <code>CORS_ORIGIN</code>, <code>NEXT_PUBLIC_API_URL</code> | Browser URL, allowed browser origin, and frontend API base URL |
| <code>KEYCLOAK_URL</code>, <code>KEYCLOAK_PUBLIC_URL</code>, <code>KEYCLOAK_REALM</code>, <code>KEYCLOAK_CLIENT_ID</code>, <code>KEYCLOAK_CALLBACK_URL</code> | Keycloak server, browser-facing server, realm, client, and OAuth callback |
| <code>KEYCLOAK_CLIENT_SECRET</code>, <code>JWT_SECRET</code> | Private credentials for the Keycloak client and local session signing |
| <code>KEYCLOAK_DB_PASSWORD</code>, <code>KEYCLOAK_ADMIN_PASSWORD</code>, <code>CUSTOMER_OPS_ADMIN_PASSWORD</code> | Self-host Keycloak database, management, and local user credentials |
| <code>CUSTOMER_OPS_TENANCY_ENABLED</code>, <code>DEFAULT_WORKSPACE_ID</code>, <code>CUSTOMER_OPS_ACCESS_LIST</code>, <code>CUSTOMER_OPS_SIGNUP_MODE</code> | Workspace isolation, bootstrap workspace, access policy, and self-serve policy |
| <code>REDIS_URL</code> | Optional shared state and rate-limit store when running more than one backend replica |
| <code>FALKORDB_URL</code> | Optional knowledge-graph store; blank leaves the graph plane dormant |
| <code>AGENT_INFERENCE_BASE_URL</code>, <code>AGENT_INFERENCE_SERVICE_TOKEN</code>, <code>AGENT_INFERENCE_BUNDLED_MODEL</code>, <code>AGENT_INFERENCE_METERED_MODEL</code>, <code>AGENT_INFERENCE_TIMEOUT_MS</code> | Optional agent inference gateway, credential, model lanes, and timeout |
| <code>UC_ENTITLEMENT_MODE</code>, <code>ENTITLEMENTS_ENDPOINT_URL</code> | Entitlement behavior and optional suite entitlement source |
| <code>CONTACT_OPS_*</code>, <code>AO_*</code>, <code>EMAIL_OPS_*</code>, <code>MEETING_OPS_*</code>, <code>PROJECT_OPS_*</code>, <code>OUTREACH_*</code> | Per-seam base URL, auth mode, audience, workspace mapping, credential, scope, and timeout |
| <code>M365_CLIENT_ID</code>, <code>M365_CLIENT_SECRET</code>, <code>M365_TENANT_ID</code>, <code>M365_REDIRECT_URI</code>, <code>M365_SCOPES</code>, <code>M365_TOKEN_ENC_KEY</code> | Optional Microsoft 365 contact connector; blank client configuration keeps it dormant |

## Architecture

~~~mermaid
flowchart LR
  Browser["Browser"] --> UI["Next.js cockpit"]
  UI --> API["NestJS API + MCP"]
  API --> SSO["Keycloak SSO"]
  API --> DB["PostgreSQL + Prisma + RLS"]
  API -. optional shared state .-> Redis["Redis"]
  API -. optional graph .-> Graph["FalkorDB"]
  API -. optional inference .-> AI["Inference gateway"]
  API --> Seam["Typed federation seams"]
  Brigade["Unicorn Brigade token exchange"] -. optional auth .-> Seam
  Seam --> Contact["Contact-Ops"]
  Seam --> Accounting["Accounting-Ops"]
  Seam --> Email["Email-Ops"]
  Seam --> Meeting["Meeting-Ops"]
  Seam --> Project["Project-Ops"]
  Seam --> Outreach["Outreach"]
~~~

The load-bearing components are:

- **Frontend:** Next.js and React cockpit with the dashboard, pipeline, customer-360, lead intake, graph explorer, quote views, settings, and SSO callback.
- **Backend:** NestJS API and MCP server. REST callers and MCP tools share the same customer, lead, quote, graph, federation, audit, and agent services.
- **Data plane:** PostgreSQL via Prisma for relationship state, activity, links, lead intake, quotes, memberships, tokens, and audit events. Workspace-scoped tables are protected by Postgres RLS; the runtime role is deliberately separate from the migration owner.
- **Identity and federation:** Keycloak handles SSO. Configured app-to-app calls use typed MCP clients and can obtain audience- and workspace-bound credentials through Unicorn Brigade.
- **Optional planes:** FalkorDB stores the relationship graph, Redis shares security state and throttling across replicas, the inference gateway powers agent output, and Microsoft Graph powers the opt-in contact connector.

## Part of Unicorn Commander

| App | What it does |
|---|---|
| [Ops-Center](https://github.com/Unicorn-Commander/Ops-Center) | The control plane: tenants, billing, federation, API keys, model routing |
| [Unicorn-Brigade](https://github.com/Unicorn-Commander/Unicorn-Brigade) | The agent layer: agents, tools, memory, orchestration |
| [Unicorn-Stable](https://github.com/Unicorn-Commander/Unicorn-Stable) | Humans and agents in the same room: chat, voice, video |
| [Accounting-Ops](https://github.com/Unicorn-Commander/Accounting-Ops) | Agent-native accounting and books |
| [Contact-Ops](https://github.com/Unicorn-Commander/Contact-Ops) | The shared contact and identity graph |
| **[Customer-Ops](https://github.com/Unicorn-Commander/Customer-Ops)** | **Customers, pipeline, quotes and outreach** |
| [Email-Ops](https://github.com/Unicorn-Commander/Email-Ops) | Agent-drafted email with a human approval inbox |
| [Project-Ops](https://github.com/Unicorn-Commander/Project-Ops) | Projects, tasks, time and invoices |
| [Meeting-Ops](https://github.com/Unicorn-Commander/Meeting-Ops) | Recordings, transcripts, summaries and action items |
| [Knowledge-Ops](https://github.com/Unicorn-Commander/Knowledge-Ops) | The wiki and memory your agents ground on |
| [Security-Ops](https://github.com/Unicorn-Commander/Security-Ops) | Authorized security scanning with engagement and attestation gates |
| [Tax-Planning-Ops](https://github.com/Unicorn-Commander/Tax-Planning-Ops) | Tax plans, scenarios and statutory deadlines |
| [Brand-Ops](https://github.com/Unicorn-Commander/Brand-Ops) | Brand kits, marks, voices and rules |
| [Podcast-Ops](https://github.com/Unicorn-Commander/Podcast-Ops) | Episodes, audio QA and publishing |
| [UUDA](https://github.com/Unicorn-Commander/UUDA) | The device agent for your fleet |
| [fleet-map](https://github.com/Unicorn-Commander/fleet-map) | Fleet inventory and topology map |

Customer-Ops owns the relationship projection and connects to the canonical contact, accounting, email, meeting, project, and outreach surfaces through the optional typed seams above; each connected app remains the source of truth for its own records.

## Development

From the repository root, install dependencies separately for the backend and frontend:

~~~bash
cd backend
npm ci
npm run build
npm test
npm run lint
~~~

~~~bash
cd frontend
npm ci
npm run build
npm run lint
~~~

The backend lint script applies ESLint fixes. RLS integration tests need the test-only database variables documented in [backend/README.md](backend/README.md).

### Further reading

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — cockpit and agent workflows
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — federation, graph, tenancy, and agents
- [docs/PHASE-1-FOUNDATION.md](docs/PHASE-1-FOUNDATION.md) — foundational contracts and surfaces
- [docs/SUITE-IDENTITY.md](docs/SUITE-IDENTITY.md) — identity and workspace contracts
- [docs/runbooks/](docs/runbooks/) — deployment, backup, tenancy, inference, and integrations
- [docs/legal/README.md](docs/legal/README.md) — legal and trust documents
- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — local checks and contribution hygiene

## Security

Please report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not publish exploit details in a public issue before the maintainers have had a chance to investigate.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

---

<div align="center">

Built by [Magic Unicorn](https://magicunicorn.tech) · part of [Unicorn Commander](https://unicorncommander.ai)

</div>

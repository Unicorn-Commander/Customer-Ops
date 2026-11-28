import { MCP_TOOL_NO_SCOPE } from '../auth/pat/pat.constants';

/**
 * The MCP ToolAnnotations subset we emit (mirrors the SDK's ToolAnnotations).
 * Kept inline rather than imported from the SDK because the SDK's `types.js`
 * subpath is ESM-only (no `require` condition) and does not type-resolve under
 * this repo's CommonJS tsconfig; the structure is identical, so the object we
 * build assigns cleanly into the SDK's `config.annotations` field.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * F3-CUO-2a / F3-CUO-3 — write:* tools that are ADDITIVE.
 *
 * RULE (F3-CUO-3): "additive" means the tool adds NEW records and does NOT
 * overwrite or delete existing USER data. Bookkeeping writes do NOT count as
 * overwrites: updatedAt touches, sequence/number counters, and cached
 * projection rows of data held in another app. Status, stage, version,
 * selection and content changes DO count as overwrites.
 *
 * Every name below was read handler-by-handler (one line per tool in REPORT.md):
 *
 *   create_quote          quotes.service.ts create_quote: `tx.quote.create` — a new row
 *   add_quote_section     add_quote_section: `tx.quoteSection.create`
 *   add_quote_line        add_quote_line: `tx.quoteLine.create` (the update_ branch is separate)
 *   add_quote_cost        add_quote_cost: `tx.quoteCost.create`
 *   add_quote_attachment  add_quote_attachment: `tx.quoteAttachment.create`
 *   create_customer_invoice
 *                        customers.service.ts createInvoiceForUser: AO `create_invoice` call
 *                        (new invoice; idempotent on the same ref) + a local link row
 *   add_customer_note     addNoteForUser: appends one activity row
 *
 * Removed in F3-CUO-3 (they DO overwrite existing USER data — status, stage,
 * version, selection changes):
 *   record_quote_acceptance
 *                        quotes-lifecycle.service.ts:892-913 — updates the
 *                        current quoteVersion (acceptedSnapshot / acceptedAt /
 *                        acceptedBy / disposition → 'accepted'), the quote's
 *                        status → 'accepted' (a status change), the selected
 *                        option-group quoteLines (a selection change) and the
 *                        customer's stage → 'CUSTOMER' (a stage change)
 *   record_customer_engagement
 *                        customers.service.ts:1799-1820 — on an advancing
 *                        signal, overwrites the customer's stage and stamps
 *                        lastStageChangeAt (a stage change, not bookkeeping)
 *
 * EVERY other write:* tool is destructive: update_* / set_* / transition_* /
 * mark_* / supersede_* / revoke_* / discard_* / remove_quote_line /
 * record_quote_acceptance / record_customer_engagement /
 * resolve_pending_leads (its provisional-merge path DELETEs the provisional
 * customer row) etc. — each overwrites or removes existing data (one line per
 * tool in REPORT.md).
 */
export const ADDITIVE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_quote',
  'add_quote_section',
  'add_quote_line',
  'add_quote_cost',
  'add_quote_attachment',
  'create_customer_invoice',
  'add_customer_note',
]);

/**
 * F3-CUO-2b — write:* tools that themselves deliver to a party OUTSIDE the
 * customer's workspace (an email to a person, or another app):
 *
 *   send_quote            quotes-lifecycle.service.ts send(): `email.composeEmail`
 *                        (mode='draft' — an Email-Ops agent-inbox message addressed to the
 *                        customer, approved by a human before anything leaves)
 *   send_customer_email   customers.service.ts sendEmailForUser: `emailOps.composeEmail` —
 *                        mode 'send' (default, kills the kill-switch path) or 'draft'
 *   start_customer_campaign
 *                        customers.service.ts startCampaignForUser: `outreach.enrollContact`
 *                        — the Outreach app owns the campaign + every send
 *   create_customer_invoice
 *                        customers.service.ts createInvoiceForUser: `accountingOps.createInvoice`
 *                        — the invoice is created in Accounting-Ops (the ledger SoR)
 *   record_quote_acceptance
 *                        quotes-lifecycle.service.ts recordAcceptance → federateAcceptedQuote:
 *                        `accounting.acceptQuote` + `projects.acceptQuote` (the accepted quote
 *                        fans out to Accounting-Ops + Project-Ops)
 *   ingest_lead           lead-intake.service.ts ingestForUser → resolveOne:
 *                        `contactOps.upsertContact` — identity CENTRALIZES in Contact-Ops
 *                        (the person SoR) before the local LEAD projection is written
 *   resolve_pending_leads
 *                        lead-intake.service.ts resolvePending: Pass A runs
 *                        resolveOne → `contactOps.upsertContact` (line 310) for
 *                        every pending intake, and Pass B upgradeProvisional →
 *                        `contactOps.upsertContact` (line 764) for every
 *                        provisional — it pushes the intake's identity UP into
 *                        Contact-Ops (the person SoR, another app), it does not
 *                        only reconcile local rows (F3-CUO-3b)
 */
export const OPEN_WORLD_TOOLS: ReadonlySet<string> = new Set([
  'send_quote',
  'send_customer_email',
  'start_customer_campaign',
  'create_customer_invoice',
  'record_quote_acceptance',
  'ingest_lead',
  'resolve_pending_leads',
]);

/**
 * F3-CUO-2c / F3-CUO-4 — the run:agents relationship agents. Their handlers
 * (read agent-by-agent, REPORT.md) all log ONE CustomerActivity(AGENT_RUN) row
 * (a DB write) and, for the two drafters with `stage_draft=true`, stage the
 * draft into the Email-Ops agent inbox via
 * `CustomersService.sendEmailForUser` → Email-Ops `composeEmail` (mode='draft',
 * hardcoded — a draft-only write that is STILL a cross-app write: the row is
 * created in ANOTHER app's database, F3-CUO-4). None is pure text, so none is
 * read-only. None overwrites or deletes existing data (append-only rows + the
 * draft staging), so none is destructive. Inference runs through OUR OWN
 * gateway (AgentInferenceClient → AGENT_INFERENCE_BASE_URL /
 * ORG_GATEWAY_BASE_URL, the suite's 4-lane inference — not a third-party LLM).
 *
 *   triage_customer              assessment only — no draft, no stage_draft arg
 *                                — closed-world (F3-CUO-4)
 *   draft_followup               draft + optional Email-Ops agent-inbox staging
 *                                (sendEmailForUser → composeEmail,
 *                                follow-up-drafter.agent.ts:185-202)
 *                                — open-world (F3-CUO-4)
 *   draft_collections_nudge      draft + optional Email-Ops agent-inbox staging
 *                                (sendEmailForUser → composeEmail,
 *                                collections-nudge.agent.ts:177-195)
 *                                — open-world (F3-CUO-4)
 */
export const AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'triage_customer',
  'draft_followup',
  'draft_collections_nudge',
]);

/**
 * F3-CUO-4 — the run:agents tools that stage a draft into Email-Ops' database
 * via `sendEmailForUser` → `composeEmail` (a cross-app write). openWorldHint
 * true. Both stay non-destructive (append-only staging + AGENT_RUN log row).
 */
export const AGENT_OPEN_WORLD_TOOLS: ReadonlySet<string> = new Set([
  'draft_followup',
  'draft_collections_nudge',
]);

/**
 * MCP ToolAnnotations for one tool, derived from the PAT scope map.
 *
 * Web ChatGPT and Claude use these hints to decide which tool calls need a
 * confirmation click before executing; without them every tool looks like a
 * write. The read/write truth already lives in MCP_TOOL_SCOPE_MAP — this pure
 * function projects it onto the MCP annotation schema. McpService wraps
 * server.registerTool once (before any tool is registered, so the quote tools
 * are covered too) and calls it with MCP_TOOL_SCOPE_MAP[name].
 *
 *   - a `read:*` tool            → readOnly, non-destructive, closed-world
 *   - a `write:*` tool           → not readOnly; destructive UNLESS the tool
 *                                  is in ADDITIVE_WRITE_TOOLS (it only adds
 *                                  rows); openWorld when it is in
 *                                  OPEN_WORLD_TOOLS (it delivers outside the
 *                                  workspace)
 *   - a `run:agents` tool        → non-destructive write: the agents log an
 *                                  AGENT_RUN row (and the drafters optionally
 *                                  stage a draft) but never overwrite/delete —
 *                                  see AGENT_WRITE_TOOLS; openWorld when the
 *                                  tool is in AGENT_OPEN_WORLD_TOOLS (F3-CUO-4:
 *                                  it stages a draft into Email-Ops' database
 *                                  via sendEmailForUser → composeEmail)
 *   - a tool in MCP_TOOL_NO_SCOPE (health, list_my_workspaces) → read-only
 *   - anything else (no scope)   → undefined: do not guess. A tool that is
 *                                  neither mapped nor scope-exempt must never
 *                                  be advertised with made-up hints; the
 *                                  spec test fails on it.
 *
 * `existing` (config.annotations, if any) is spread LAST — an author-provided
 * annotation always wins over the scope-derived default. A `title` is never
 * emitted by the scope projection: it would clobber the tool config's top-level
 * `title` (the SDK's ToolAnnotations carries a `title`, and the SDK promotes
 * `config.title` to the registered tool's title, so emitting the same value
 * twice is redundant and a typo here would silently rename the tool).
 *
 * Mirrors the Project-Ops F3 shape (PR MagicUnicorn/Project-Ops#168).
 */
export function mcpAnnotationsFor(
  name: string,
  scope: string | undefined,
  existing?: ToolAnnotations,
): ToolAnnotations | undefined {
  let annotations: ToolAnnotations;
  if (scope?.startsWith('read:') || MCP_TOOL_NO_SCOPE.has(name)) {
    annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  } else if (scope?.startsWith('write:')) {
    annotations = {
      readOnlyHint: false,
      destructiveHint: !ADDITIVE_WRITE_TOOLS.has(name),
      openWorldHint: OPEN_WORLD_TOOLS.has(name),
    };
  } else if (scope === 'run:agents') {
    if (!AGENT_WRITE_TOOLS.has(name)) return undefined; // fail closed: a new agent is audited before it ships
    annotations = {
      readOnlyHint: false,
      destructiveHint: false,
      // F3-CUO-4: the drafters stage the draft into Email-Ops' database
      // (sendEmailForUser → composeEmail) when stage_draft=true — a cross-app
      // write, so open-world. triage_customer stays closed-world.
      openWorldHint: AGENT_OPEN_WORLD_TOOLS.has(name),
    };
  } else {
    return undefined;
  }
  return { ...annotations, ...existing };
}

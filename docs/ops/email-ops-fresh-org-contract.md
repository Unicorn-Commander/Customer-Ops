# Email-Ops contract for a fresh org (AUD-CR-4)

What Customer-Ops sends Email-Ops for a workspace that was just created and
has no `email-ops` row in `federation_workspace_map`, no
`FEDERATION_WORKSPACE_MAP_SEED` entry, and no `EMAIL_OPS_WORKSPACE_OVERRIDE`.

## What Customer-Ops does (proven in this repo)

- The workspace id goes to Email-Ops unchanged (`effectiveWorkspaceId` in
  `backend/src/email-ops/email-ops.client.ts`): the same lowercase uuid in the
  JSON-RPC `workspace_id`, the `X-Workspace-Id` header and the bearer claim.
  For an Ops-Center org this is the org id; for a self-serve workspace it is
  the uuidv7 minted at sign-up.
- `compose_email` is idempotent on `(workspace_id, external_source,
  external_ref)`.
- Test: `backend/src/email-ops/email-ops.fresh-org.spec.ts` (Email-Ops faked
  at `fetch`).

## What Customer-Ops expects of Email-Ops (NOT verified)

Email-Ops is another repo and could not be read from this build (the clone
needs credentials). Whether a deployed Email-Ops accepts a workspace id it has
never seen (auto-knows new orgs) is **unverified**. Customer-Ops does not
assume it does. What the customer sees in each case:

| Email-Ops answer | Customer-Ops class | Customer sees | Staged link |
|---|---|---|---|
| message returned | ok | sent / draft | kept, stamped |
| tool error, JSON-RPC error, HTTP 400/404/409/422 | refused | 422 `email_not_accepted`, plain words, no retry advice | deleted (only if no message) |
| HTTP 401/403 (our credential rejected) | unavailable | 503, retry is safe | kept for the retry |
| transport, timeout, 408/429/5xx, unreadable | unavailable | 503, retry is safe | kept for the retry |

## Open decision (owner)

Confirm in Email-Ops one of:
1. Email-Ops auto-creates or accepts any suite workspace id on first
   `compose_email` (then a fresh org works with no map row), or
2. Email-Ops needs a workspace provisioned first; then Customer-Ops needs a
   provisioning call or a map row at workspace creation, and until then a
   fresh org sees the plain 422 above.

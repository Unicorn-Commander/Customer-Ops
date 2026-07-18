-- ============================================================================
-- Customer-Ops — PAT entitlement snapshot (money / entitlement-enforce fix)
-- ============================================================================
--
-- A PAT (`co_pat_`) carries no live bearer-token claim, so the auth chokepoint
-- previously stamped `__workspaceClaim` + `__ucUid` but NO `__entitlements` —
-- leaving `entitlementsOf(user)` = [] and every gated federation/inference
-- action 403 under UC_ENTITLEMENT_MODE=enforce, even for a paying customer.
--
-- This column snapshots the minting session user's verified entitlement SKUs at
-- create time; the guard stamps them onto request.user.__entitlements so the
-- gates see the paying user's SKUs. The (user, workspace) binding is preserved
-- at each gate by intersecting this snapshot with the acting workspace's
-- server-side entitlements (WorkspaceContextService.effectiveEntitlements), so a
-- snapshot from one org grants nothing in a workspace whose cache lacks the SKU.
--
-- NOT NULL DEFAULT '{}' so existing tokens backfill to "no snapshot" (denied
-- under enforce until re-minted — secure-by-default, never over-grants).

-- AlterTable
ALTER TABLE "personal_access_tokens"
    ADD COLUMN "entitlements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

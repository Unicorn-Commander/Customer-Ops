/**
 * The Project-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService / the customer-360 projects slot) depends ONLY on this port,
 * never on the concrete client — the same federate-don't-fork seam as
 * ContactOpsPort / MeetingOpsPort, giving:
 *
 *   1. Federation is built against the Project-Ops contract but MOCKED in tests
 *      (Project-Ops is not running during verification) — tests provide a fake
 *      ProjectOpsPort.
 *   2. The transport (JSON-RPC MCP today; a different brokered transport later) is
 *      swappable without touching relationship logic.
 *   3. Customer-Ops never becomes a second project tracker: the port only READS a
 *      contact's projects from Project-Ops. Project-Ops owns the lifecycle; there
 *      is NO local project/task/link state.
 *
 * DEGRADE-CLEAN (binding): when PROJECT_OPS_BASE_URL is unset, `isConfigured()` is
 * false; the service renders the projects slot as "connect Project-Ops" and makes
 * no call. Every method is also individually safe to call when unconfigured
 * (returns []), so a missing config can never throw.
 */

import { FederatedProject } from './project-ops.types';
import { SeamHealth } from '../health/seam-health';

/** The per-call federation identity: which workspace and who is acting. Mirrors
 *  the other ops ports so the service builds ONE context object for all seams. */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the wire claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the Project-Ops actor). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token (unused for reads, carried
   *  for parity with the other seams). */
  entitlements: string[];
}

/** How to resolve which projects belong to a customer. Project-Ops matches by
 *  free-text across client + organization name, so we hand it the customer's
 *  federated org name (preferred) and contact display name (fallback). */
export interface ProjectLookup {
  /** The customer contact's current organization name (preferred match key). */
  orgName: string | null;
  /** The customer contact's display name (fallback match key). */
  contactName: string | null;
}

export abstract class ProjectOpsPort {
  /**
   * Probe this seam's transport + auth with a lightweight, side-effect-free MCP
   * `tools/list` and report a SeamHealth (so a silent 401/403 becomes visible via
   * `GET /health/integrations` rather than hiding behind a degrade-clean panel).
   * Never throws — every failure is folded into the returned SeamHealth.
   */
  abstract ping(): Promise<SeamHealth>;

  /**
   * Is a Project-Ops target configured at all (PROJECT_OPS_BASE_URL set)? When
   * false the cockpit shows "connect Project-Ops" and NO federation call is made
   * (degrade-clean). Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Read the projects Project-Ops is delivering for this customer (its native
   * `search_projects`, matched on the customer's org / contact name). Returns []
   * when not configured, when there is no usable match key, or on any
   * transport/application failure (the service decides how to surface that).
   * Never throws — federation is best-effort by design.
   */
  abstract listProjectsForContact(
    ctx: FederationContext,
    lookup: ProjectLookup,
  ): Promise<FederatedProject[]>;
}

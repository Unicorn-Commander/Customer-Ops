/**
 * The Project-Ops federation contract — the shapes Customer-Ops consumes from the
 * project & client-operations app (the delivery-signal source).
 *
 * BINDING PRINCIPLE (the suite "federate, don't fork" rule, mirroring the
 * Meeting-Ops seam): Customer-Ops FEDERATES delivery signal. **Project-Ops** is
 * the system-of-record for every project, task, milestone, and comment.
 * Customer-Ops never records a project, never stores a task, and holds NOTHING
 * locally for Project-Ops — there is no link table; the projects slot on the
 * customer-360 is resolved PURELY at read time over the federation seam (the
 * ProjectOpsPort) and held only for the duration of a request. Read-only signal,
 * zero local persistence — the same shape as the Meeting-Ops seam.
 *
 * Customer-Ops federates the **Project-Ops APP** (by workspace_id), keyed to the
 * the relationship's Customer-Ops / Contact-Ops ids first, with the customer's
 * organization / contact name as a fallback. Project-Ops's `search_projects`
 * tool matches across project title, description, project number, client name
 * and organization name. This file is the APP's `/mcp` read contract, exactly as
 * the Accounting-Ops / Meeting-Ops / Email-Ops seams mirror those apps' tool
 * surfaces.
 */

/** The person a project is assigned to, as Project-Ops resolves them. */
export interface FederatedProjectAssignee {
  /** Display name (first + last, or whatever Project-Ops resolved). */
  displayName: string;
  /** Assignee email, if Project-Ops exposed one (never stored here). */
  email: string | null;
}

export type ProjectMatchSource = 'customerOpsCustomerId' | 'contactOpsContactId' | 'name';

/**
 * A PROJECT as Project-Ops exposes it — the read-time projection the customer-360
 * renders. Project-Ops owns the project + its tasks; this carries only the
 * load-bearing header fields (no task list / no comments). Surfaced on a customer
 * when its client/organization (or contact) name matches the account.
 */
export interface FederatedProject {
  /** Project-Ops project id (the app's; opaque to Customer-Ops). */
  id: string;
  /** Which Customer-Ops lookup returned this project. */
  matchedBy: ProjectMatchSource;
  /** Human project number, e.g. "P-00085". */
  projectNumber: string;
  /** Project title/subject. */
  title: string;
  /** ProjectStatus: NEW | IN_PROGRESS | UNDER_REVIEW | COMPLETED | ARCHIVED | ON_HOLD. */
  status: string;
  /** ProjectPriority: LOW | MEDIUM | HIGH | URGENT (verbatim from Project-Ops). */
  priority: string;
  /** ISO-8601 due date, or null. */
  dueDate: string | null;
  /** The client name on the project (Project-Ops' free-text client), or null. */
  clientName: string | null;
  /** The owning organization's name, or null. */
  organizationName: string | null;
  /** Who the project is assigned to, or null. */
  assignedTo: FederatedProjectAssignee | null;
}

/**
 * The customer-360 "Projects" slot. `configured` drives the "connect Project-Ops"
 * affordance; `federated` records whether a live read was attempted. Read-only —
 * there is no create/link action (Project-Ops owns the lifecycle).
 */
export interface ProjectPanel {
  federated: boolean;
  source: 'project-ops';
  configured: boolean;
  projects: FederatedProject[];
}

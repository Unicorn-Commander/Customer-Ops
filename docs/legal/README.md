# Customer-Ops — Legal & Trust Documents

> **DRAFT — NOT LEGAL ADVICE — REQUIRES REVIEW BY COUNSEL.**
> Every document in this folder is an **engineering-authored draft**, tailored to
> the Customer-Ops architecture (v0.7.0) so that counsel starts from something
> specific rather than generic boilerplate. **None of these is legally effective
> until it has been reviewed and finalized by qualified counsel** and every
> `[PLACEHOLDER]` has been completed. Do not publish, link from the app, or rely
> on any of these as-is.

**Drafted:** 2026-06-06 · **Product version described:** v0.7.0 (relationship cockpit + live cross-app federation)

## The set

| Document | Purpose |
|---|---|
| [terms-of-service.md](./terms-of-service.md) | Master agreement: the Service, accounts/SSO, data ownership (you = controller, we = processor), AI-as-draft, federation/third-party, fees, IP, disclaimers, liability, termination, governing law. |
| [privacy-policy.md](./privacy-policy.md) | GDPR + CCPA/CPRA aware: the two roles (controller of account data / processor of Customer Content), data categories grounded in the actual schema, purposes & legal bases, the real subprocessor list, retention, data-subject rights, international transfer. |
| [data-processing-addendum.md](./data-processing-addendum.md) | Customer-Ops as **processor** of customer contact data: roles, instructions, subprocessors + change notice, SCC/UK-IDTA reference, audit, **deletion/return**, **breach notification**, CCPA service-provider terms. |
| [acceptable-use-policy.md](./acceptable-use-policy.md) | Lawful-basis-to-contact, **CAN-SPAM / CASL / ePrivacy** outreach rules (the Outreach/Email-Ops surfaces), AI draft-and-review, anti-abuse / no-circumventing-tenancy, self-hosting, enforcement. |
| [security-and-trust.md](./security-and-trust.md) | The moat, for prospects/auditors: **RLS tenant isolation** (`ENABLE`+`FORCE`, the 4-role split, the membership gate), SSO, **audience-bound RFC-8693 federation**, self-hostable, encryption, degrade-clean, incident response. **States the honest current-deployment posture** (the tenancy flag/role flip). |

## How these are tailored to the architecture (so counsel knows what's load-bearing)

- **Surface, not engine.** Customer-Ops stores a thin relationship projection and **references**, not copies, of contacts/invoices/mail/meetings. This shrinks the data actually held and shapes the data categories, retention, deletion, and breach blast-radius narrative throughout.
- **The lead-intake buffer** (`lead_intakes`) is called out as the *one* place raw third-party PII (name/email/phone/org) genuinely lands, transiently, until identity is centralized in Contact-Ops — it gets the tightest minimization/retention language.
- **Real subprocessors are named** from the system as built: Keycloak (`uchub`), Brigade (RFC-8693 broker), Contact-Ops, Accounting-Ops, Outreach (Listmonk/Postiz), Email-Ops (Stalwart), Postmark, Meeting-Ops, the ops-center `uchub-litellm` inference gateway, and hosting.
- **AI is draft-and-review:** the agents hand prompts to the gateway (Customer-Ops runs/meters nothing) and outbound drafts are human-approved — reflected in the ToS AI clause, the AUP, and the no-solely-automated-decision statement.
- **Self-hostable** posture is treated as a distinct, stronger-privacy deployment in which most "subprocessors" run on the operator's own infrastructure.

## Required before publication (counsel + Aaron)

1. Confirm the **legal entity name, registered address, entity type, and governing jurisdiction**, and fill every `[PLACEHOLDER]`.
2. Provision and publish the **legal/privacy/security/abuse** contact addresses used in the docs.
3. Decide the **commercial terms** (fees, trials, refunds, SLA, liability cap, arbitration vs. courts).
4. **Disclose the actual AI model provider** the inference gateway routes to (self-hosted vs. a named third party) — it is a material subprocessor fact.
5. Append the **operative SCC / UK-IDTA** text to the DPA (this draft references but does not reproduce them) and confirm the **EU/UK representative** requirement.
6. Confirm the **deployment posture statements** in Security & Trust match the deployment you are launching (the RLS/role/tenancy-flag flip, at-rest encryption, TLS specifics) and close the **secret-rotation** item before public launch.
7. Maintain a **dated, versioned subprocessor list** and a change-notice mechanism (referenced by both the Privacy Policy and the DPA).

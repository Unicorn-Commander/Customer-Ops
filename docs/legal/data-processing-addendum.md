> **DRAFT — NOT LEGAL ADVICE — REQUIRES REVIEW BY COUNSEL**
>
> This Data Processing Addendum ("DPA") is an engineering-authored draft tailored
> to the Customer-Ops architecture. It is **not** a substitute for a DPA prepared
> and negotiated by qualified data-protection counsel, and it does **not** include
> the operative text of the Standard Contractual Clauses (those must be appended
> verbatim from the official EU/UK instruments). Complete every `[PLACEHOLDER]`.

# Customer-Ops — Data Processing Addendum

**Last updated:** 2026-06-06

This DPA forms part of the agreement (the "Agreement") between **[LEGAL ENTITY NAME]** ("Processor," "[SHORT NAME]," "we") and the customer that subscribes to or self-hosts **Customer-Ops** ("Controller," "Customer," "you"), and governs the processing of personal data that we process **on your behalf** in providing the Service.

Where you self-host Customer-Ops on your own infrastructure and we have no access to your data, much of this DPA is satisfied by your own controls; the provisions that bind us apply to any processing **we** actually perform (e.g. suite-managed hosting, support access, or suite-managed subprocessors you enable).

---

## 1. Definitions

Terms such as "personal data," "processing," "controller," "processor," "subprocessor," "data subject," "personal data breach," and "supervisory authority" have the meanings in the **GDPR** / **UK GDPR**; "personal information," "business," "service provider," "sell," and "share" have the meanings in the **CCPA/CPRA**. "**Customer Personal Data**" means personal data within **Customer Content** that we process on your behalf — principally the **leads, contacts, and relationship records** you load or generate in the Service.

## 2. Roles & scope

- **You are the Controller / Business**; **we are the Processor / Service Provider** for Customer Personal Data. You determine the purposes and means; we process only on your **documented instructions** (this DPA, the Agreement, and your configuration/use of the Service).
- We process Customer Personal Data **solely to provide and support the Service** and for no independent purpose. We do **not sell or share** Customer Personal Data and do **not** retain, use, or disclose it outside the direct business relationship or as otherwise permitted by the CCPA/CPRA. We certify we understand and will comply with these restrictions.
- For our role as **controller** of account/usage data, see the Privacy Policy (this DPA does not cover that processing).

## 3. Nature, purpose, duration & data (DPA Annex I summary)

| Item | Detail (Customer-Ops as built) |
|---|---|
| **Subject matter** | Provision of the Customer-Ops relationship/funnel cockpit |
| **Duration** | The term of the Agreement, plus the deletion/return window in §9 |
| **Nature & purpose of processing** | Storing a thin relationship projection (lifecycle stage, pipeline, activity log) keyed to a federated contact reference; staging inbound leads in the lead-intake buffer until identity is centralized in Contact-Ops; orchestrating reads/writes to the federated engines on your instruction; running human-reviewed AI drafting agents |
| **Categories of data subjects** | Your leads, prospects, customers, and contacts; your personnel who use the Service |
| **Categories of personal data** | Contact identifiers (name, email, phone, organization) **in the lead-intake buffer**; relationship/pipeline metadata and free-text notes; references to invoices/messages/meetings; usage/attribution data. **No message bodies, no invoice line detail, no meeting transcripts are stored by Customer-Ops** (those remain in their systems of record). |
| **Special-category data** | **Not intended.** You must not load special-category (GDPR Art. 9) data, PHI, or children's data except as expressly permitted and, for PHI, only under a separately-signed **BAA** and the appropriate isolation tier. |
| **Frequency** | Continuous, for the term |

*(Counsel: render the full Annex I (A: parties; B: description) and Annex II (technical & organizational measures — incorporate the Security & Trust controls) in the final DPA.)*

## 4. Our obligations as Processor

We will: (a) process Customer Personal Data only on your documented instructions, including for transfers, unless required by law (in which case we notify you unless legally prohibited); (b) ensure persons authorized to process it are under confidentiality obligations; (c) implement the **technical and organizational measures** in §7; (d) respect the conditions in §5 for engaging subprocessors; (e) **assist you** (taking into account the nature of processing) in responding to data-subject requests (§6), and with your obligations under GDPR Arts. 32–36 (security, breach notification, DPIAs, prior consultation); (f) **delete or return** Customer Personal Data per §9; and (g) make available information necessary to demonstrate compliance and allow for **audits** per §8.

We will inform you if, in our opinion, an instruction infringes the GDPR/UK GDPR or other applicable law.

## 5. Subprocessors

- You provide **general written authorization** for us to engage subprocessors to provide the Service. We impose data-protection obligations on each subprocessor **no less protective** than this DPA and remain liable for their performance.
- The **current subprocessor list** is below (and mirrors the Privacy Policy). Within a **self-hosted** deployment, several of these run on **your** infrastructure and are not our subprocessors at all.

| Subprocessor / component | Function | Data |
|---|---|---|
| **Keycloak (`uchub`)** | SSO / identity | Identity, auth |
| **Brigade** | Audience-bound federation token broker (RFC 8693) | Token claims only; no content |
| **Contact-Ops** | Canonical contact store the cockpit resolves to | Contact identity |
| **Accounting-Ops** | AR / invoices (referenced) | Billing identity, invoice data |
| **Outreach → Listmonk / Postiz** | Email / social campaigns | Recipient + campaign data |
| **Email-Ops → Stalwart** | Mailbox / threads | Mail contents |
| **Postmark** | Transactional email delivery | Recipient + metadata |
| **Meeting-Ops** | Conversation signal (read federated) | Meeting metadata/summaries |
| **Inference gateway (`uchub-litellm`)** | Routes/meters AI agent requests | Assembled prompt context; **[name the downstream model provider]** |
| **Hosting / infrastructure** | Compute / storage / network | All, at rest/in transit — **[name provider(s) + region(s)]** |

[List any analytics / monitoring / billing (e.g. Lago/Stripe) / CDN subprocessors actually used.]

- **Change notice:** we will give you **[NOTICE PERIOD, e.g. 30 days]** prior notice (via [the subprocessor page / email]) before adding or replacing a subprocessor that processes Customer Personal Data. You may **object** on reasonable data-protection grounds within **[OBJECTION WINDOW]**; if we cannot reasonably accommodate the objection, you may terminate the affected Service per the Agreement.

## 6. Data-subject requests

Taking into account the nature of the processing, we will assist you by appropriate technical and organizational measures, insofar as possible, to fulfill data-subject requests (access, rectification, erasure, restriction, portability, objection). Because Customer-Ops **references** rather than copies most contact data, fulfilling a request usually involves the relevant **system of record** (e.g. erasure of the canonical contact in Contact-Ops) plus removal of the relationship projection and any lead-intake record in Customer-Ops. If a data subject contacts us directly about your data, we will refer them to you and not respond substantively except to acknowledge and redirect (unless legally required or you instruct otherwise).

## 7. Security measures (Annex II — summary)

We maintain technical and organizational measures appropriate to the risk, including: **database-enforced tenant isolation** via PostgreSQL Row-Level Security (`ENABLE` + `FORCE`) with a per-transaction workspace GUC chokepoint and a fail-closed default; a **least-privilege database role split** (a `NOBYPASSRLS` runtime role); an **explicit membership gate** (no workspace access without a membership row); **SSO** via Keycloak with **audience-bound** token verification; **audience- and workspace-bound, least-privilege brokered federation** (RFC 8693) so no app holds a standing credential to another's data; **TLS** in transit; **data minimization** (references not copies; the lead-intake buffer is the one transient raw-PII store); secrets referenced by name only and never logged. The authoritative, current description is **[Security & Trust](./security-and-trust.md)** — *including its honest statement of which controls are live in a given deployment* (e.g. RLS becomes enforcing only when the runtime is the `NOBYPASSRLS` role and the tenancy flag is on). Counsel/Customer should not treat a roadmap control as contractually warranted.

## 8. Audit

We will make available information reasonably necessary to demonstrate compliance with this DPA and, on reasonable prior notice and subject to confidentiality, allow audits/inspections by you or your mandated auditor **[no more than once per 12 months absent a breach or regulator requirement]**, or provide an equivalent third-party report where available. [No SOC 2/ISO report is currently represented; update if/when one exists.]

## 9. Deletion & return

On termination/expiry of the Agreement, or on your written request, we will, at your choice, **delete or return** all Customer Personal Data and delete existing copies, unless retention is required by law. Because the relationship projection and lead-intake buffer are the principal stores in Customer-Ops, deletion targets those tenant-scoped tables (`customers`, `customer_activities`, `customer_*_links`, `lead_intakes`) for the workspace, including **redaction of raw lead-intake payloads**; references resolve to nothing once the underlying system-of-record record is removed. **[State the deletion SLA, e.g. within 30 days, and the backup-expiry tail.]**

## 10. Personal data breach

We will notify you of a personal data breach affecting Customer Personal Data **without undue delay** after becoming aware (target **[e.g. within 72 hours]**), with the information reasonably available to help you meet your GDPR Art. 33/34 and applicable U.S. state breach-notification obligations, and will take reasonable steps to mitigate. Notice will go to **[your designated security/privacy contact]**. (See Security & Trust §10.)

## 11. International transfers

Where we (or a subprocessor) process Customer Personal Data of EEA/UK/Swiss data subjects outside an adequate jurisdiction, the parties incorporate the **EU Standard Contractual Clauses** (Module 2, Controller→Processor; Module 3 where onward transfer to a subprocessor) and, for the UK, the **UK International Data Transfer Addendum**, and for Switzerland the relevant addendum — **as appended to and forming part of this DPA**. *(Counsel: append the operative SCC text and complete the modules, dockets, and Annexes; this draft references them but does not reproduce them.)* The data-importer details, technical measures (Annex II), and subprocessor list (§5) populate the SCC annexes. Self-hosted operators control transfer/residency directly.

## 12. CCPA/CPRA service-provider terms

We act as a **Service Provider**. We will not: (a) sell or share Customer Personal Data; (b) retain, use, or disclose it for any purpose other than performing the Service, or as otherwise permitted by the CCPA; (c) retain, use, or disclose it outside the direct business relationship; or (d) combine it with personal information from other sources except as permitted. We will comply with applicable CCPA obligations and enable you to comply with consumer requests. We certify we understand and will abide by these restrictions.

## 13. Liability, term, order of precedence

This DPA is subject to the limitations of liability in the Agreement. It is effective for the term that we process Customer Personal Data. In case of conflict on data-protection matters, **this DPA prevails** over the Agreement; the operative **SCCs prevail** over this DPA where they conflict.

---

**Signatures / acceptance:** [Specify how the DPA is accepted — e.g. incorporated by reference into the Terms of Service for all customers, or separately executed for negotiated/enterprise/BAA customers.]

[LEGAL ENTITY NAME] · [REGISTERED ADDRESS] · [privacy@DOMAIN]

---

*Companion documents: [Privacy Policy](./privacy-policy.md) · [Terms of Service](./terms-of-service.md) · [Acceptable Use Policy](./acceptable-use-policy.md) · [Security & Trust](./security-and-trust.md).*

> **DRAFT — NOT LEGAL ADVICE — REQUIRES REVIEW BY COUNSEL**
>
> These Terms of Service are an engineering-authored draft tailored to the
> Customer-Ops product. They must be reviewed and finalized by qualified counsel
> before publication or use. Complete every `[PLACEHOLDER]`. Bracketed commercial
> terms (fees, trials, refunds, SLAs, governing law/venue, liability caps,
> arbitration) are business/legal decisions, not engineering ones.

# Customer-Ops — Terms of Service

**Last updated:** 2026-06-06
**Effective date:** [EFFECTIVE DATE]

These Terms of Service ("Terms") are a binding agreement between **[LEGAL ENTITY NAME]** ("[SHORT NAME]," "we," "us," "our"), a [STATE, e.g. South Carolina] [ENTITY TYPE, e.g. C corporation] with its principal place of business at [REGISTERED ADDRESS], and the individual or entity that accesses or uses **Customer-Ops** ("you," "Customer"). By accessing or using the Service, or by clicking to accept, you agree to these Terms. If you accept on behalf of an entity, you represent you are authorized to bind it.

The **[Acceptable Use Policy](./acceptable-use-policy.md)**, **[Privacy Policy](./privacy-policy.md)**, and (for Customer Content) the **[Data Processing Addendum](./data-processing-addendum.md)** are incorporated by reference.

## 1. The Service

Customer-Ops is the **relationship / funnel cockpit** of the Unicorn Commander suite: one surface to run the customer lifecycle — source a lead, work it through outreach, qualify, convert, and retain — by surfacing contacts, invoices, email, campaigns, and meeting signal in a single cockpit.

**Customer-Ops is a surface, not an engine.** It manages the **relationship and lifecycle stage** and **federates** everything else to the suite's systems of record (Contact-Ops for contacts, Accounting-Ops for invoices/AR, Outreach/Email-Ops for messaging, Meeting-Ops for conversation signal, and a control-plane inference gateway for AI). You acknowledge that much functionality depends on those integrations, each of which **degrades cleanly** (shows a "connect [App]" affordance) when not configured.

We may offer the Service as a **suite-managed (hosted)** offering and/or for **self-hosting** on your own infrastructure; some sections apply only to one model and say so.

## 2. Accounts, SSO & access

- Access requires authentication via **single sign-on (Keycloak)**. You are responsible for your identity-provider configuration, your users' credentials, and all activity under your account/workspace.
- Access to any **workspace** requires an explicit **membership**; a valid login grants no workspace access by itself. You are responsible for managing your members and their roles.
- You must provide accurate information and promptly notify us of any unauthorized use at [security@DOMAIN].
- The Service is for **business use** by users who are at least [18 / age of majority]. It is not directed to children.

## 3. Customer Content & data ownership

- "**Customer Content**" means the data you load, ingest, or generate in the Service — principally your **leads, contacts, and relationship records** and the notes/metadata about them. As between the parties, **you own and are responsible for your Customer Content**.
- You grant us a limited, non-exclusive license to **host, process, and transmit** Customer Content **solely to provide the Service** (including routing it to the federated engines and the inference gateway as you direct) and as permitted by the [Privacy Policy](./privacy-policy.md) and [DPA](./data-processing-addendum.md).
- **You are the controller / business; we are the processor / service provider** for Customer Content. You represent you have all rights, consents, and lawful bases to provide it and to use the Service's outreach features to contact the people in it (see the AUP §1–§2).
- You must not load data you are not authorized to process, including **PHI absent a signed BAA** and the appropriate isolation tier, or other regulated/special-category data without authority (see AUP §4, Security & Trust §11).
- Because Customer-Ops **references** rather than copies most data, deletion/retention interacts with the systems of record (see Privacy Policy §7 and DPA §9).

## 4. Acceptable use

You will comply with the **[Acceptable Use Policy](./acceptable-use-policy.md)**, including its email/outreach (CAN-SPAM and related) and anti-abuse provisions. Violations may result in suspension or termination under §10.

## 5. AI features — drafts, not decisions; no professional advice

The Service includes AI agents that produce **drafts and suggestions** via the control-plane inference gateway. **Customer-Ops runs no model and meters no usage** — routing and metering occur at the gateway. AI output:

- is provided **"as is,"** may be **inaccurate or incomplete**, and is **not** legal, financial, tax, medical, or other professional advice;
- is **draft and advisory** and is **subject to your review and approval** before you act on it — e.g. drafted outbound email is **staged for explicit human approval** before any send; and
- does **not** constitute an automated decision producing legal or similarly significant effects about a data subject.

You are responsible for reviewing and for any reliance on AI output. AI features may depend on third-party model providers and on your entitlements; we may change, limit, or discontinue specific models or lanes.

## 6. Federated & third-party services

The Service interoperates with suite apps and third-party services (e.g. Keycloak, Brigade, Contact-Ops, Accounting-Ops, Outreach/Listmonk/Postiz, Email-Ops/Stalwart, Postmark, Meeting-Ops, the inference gateway, and hosting providers). Your use of those services may be subject to **their** terms, and we are **not responsible** for them. Availability or behavior of a federated/third-party service is outside our control; affected features degrade cleanly but may be unavailable. Some cross-app actions (e.g. invoicing, sending) require the relevant **entitlement(s)**.

## 7. Fees, plans & taxes

[COMPLETE: pricing, plans/tiers, seats, metered AI usage, free trial/tier terms, billing cycle, payment processor, auto-renewal, price-change notice, late payment, and **taxes**. If billing/metering is handled by a separate system (e.g. Lago/Stripe), reference it. State the **refund policy** — including that suspension/termination for AUP or other cause is non-refundable except as stated.] Self-hosted licensing terms, if different, are set out in [the applicable order/license].

## 8. Intellectual property

We and our licensors own all rights in the Service, its software, and its trademarks (including "Unicorn Commander," "Customer-Ops," and related marks). We grant you a limited, non-exclusive, non-transferable, revocable right to use the Service per these Terms. [If any component is provided under an open-source or source-available license, state which, and that those license terms govern that component.] You retain rights in your Customer Content. **Feedback** you provide may be used by us without restriction or obligation.

## 9. Warranties & disclaimers

EXCEPT AS EXPRESSLY STATED, THE SERVICE IS PROVIDED **"AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND**, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT AI OUTPUT WILL BE ACCURATE. [Any uptime/SLA commitment is in a separate **Service Level Agreement**, if offered; absent that, no uptime is warranted.] You are responsible for your own compliance (including outreach/CAN-SPAM and data-protection obligations) and for maintaining your own backups of data you cannot afford to lose.

## 10. Suspension & termination

- **By you:** stop using the Service and, for paid plans, cancel per §7.
- **By us:** we may **suspend or terminate** for breach of these Terms or the AUP, non-payment, legal/security risk, or as required by law. Where the risk warrants (active abuse, security threat, legal compulsion) we may act **without prior notice**; otherwise we will use reasonable efforts to notify you.
- **Effect:** access ends; we handle Customer Content per the [Privacy Policy](./privacy-policy.md) and [DPA](./data-processing-addendum.md) (**deletion or return**, subject to legal holds and backup-expiry tails). Sections that by nature survive (IP, disclaimers, limitation of liability, indemnity, governing law, and accrued fees) survive termination.

## 11. Indemnification

You will defend, indemnify, and hold harmless [SHORT NAME] and its affiliates, officers, and personnel from claims, damages, and costs (including reasonable legal fees) arising from (a) your Customer Content; (b) your use of the Service in violation of these Terms, the AUP, or law (including outreach/anti-spam and data-protection violations and lack of a lawful basis or consent); or (c) your infringement of any third-party right. [Counsel: add any mutual/indemnity-from-us provisions, e.g. IP infringement of the Service, as a business decision.]

## 12. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW: NEITHER PARTY IS LIABLE FOR **INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY** DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, OR GOODWILL. OUR **TOTAL AGGREGATE LIABILITY** ARISING OUT OF OR RELATED TO THE SERVICE OR THESE TERMS WILL NOT EXCEED **[THE GREATER OF THE AMOUNTS YOU PAID US IN THE [12] MONTHS BEFORE THE CLAIM, OR US$[AMOUNT]]**. [Carve-outs (e.g. for indemnity, breach of confidentiality, or your payment obligations) per counsel.] Some jurisdictions do not allow certain limitations; some may not apply to you.

## 13. Governing law & disputes

These Terms are governed by the laws of **[STATE/JURISDICTION, e.g. South Carolina, USA]**, without regard to conflict-of-laws rules. [Choose and complete one: exclusive jurisdiction/venue in the courts of [COUNTY/STATE]; **and/or** a binding **arbitration** clause and **class-action waiver** — these are significant decisions for counsel, including consumer-law and international-customer considerations.] The U.N. Convention on Contracts for the International Sale of Goods does not apply.

## 14. Changes to the Service or Terms

We may modify the Service and these Terms. For **material** changes to the Terms we will provide reasonable notice (e.g. by posting the updated "Last updated" date and/or notifying you); continued use after the effective date constitutes acceptance. If you do not agree, stop using the Service. [Conform the change mechanism to your jurisdiction's consumer-contract requirements.]

## 15. Compliance, export & sanctions

You will comply with applicable laws in your use of the Service, including **export-control and economic-sanctions** laws. You represent you are not located in, and will not use the Service from, an embargoed jurisdiction or as a sanctioned/denied party.

## 16. General

These Terms (with the incorporated policies and any order/SLA/BAA) are the entire agreement and supersede prior understandings on their subject. If a provision is unenforceable, the rest remains in effect. No waiver is implied by delay. You may not assign these Terms without our consent; we may assign to an affiliate or successor. Nothing creates an agency, partnership, or joint venture. Notices to us: [legal@DOMAIN]; notices to you: to your account email. [Add a force majeure clause.]

## 17. Contact

[LEGAL ENTITY NAME] · [REGISTERED ADDRESS] · [legal@DOMAIN]

---

*Companion documents: [Privacy Policy](./privacy-policy.md) · [Data Processing Addendum](./data-processing-addendum.md) · [Acceptable Use Policy](./acceptable-use-policy.md) · [Security & Trust](./security-and-trust.md).*

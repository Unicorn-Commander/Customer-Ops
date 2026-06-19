> **DRAFT — NOT LEGAL ADVICE — REQUIRES REVIEW BY COUNSEL**
>
> This Acceptable Use Policy ("AUP") is an engineering-authored draft tailored to
> the Customer-Ops architecture (especially its outreach/email surfaces). It must
> be reviewed and finalized by counsel before publication. Complete every
> `[PLACEHOLDER]`.

# Customer-Ops — Acceptable Use Policy

**Last updated:** 2026-06-06

This AUP governs your use of **Customer-Ops** (the "Service") operated by **[LEGAL ENTITY NAME]** ("[SHORT NAME]," "we"). It is incorporated into the **[Terms of Service](./terms-of-service.md)**. Capitalized terms not defined here have the meaning in the Terms. You are responsible for your users' and your agents' (automated and human) compliance with this AUP. We may update it as the Service evolves.

Customer-Ops is a relationship/funnel cockpit that can **drive outbound communications** (email campaigns via Outreach/Listmonk, social posts via Postiz, and individual email via Email-Ops/Stalwart) and can **ingest third-party contact data** (the lead-intake buffer). Because of that, the rules below about **consent, data provenance, and outreach** are the most important part of this Policy.

---

## 1. You must have a lawful basis to load and contact the people in your data

You represent and warrant, for **all** lead/contact/relationship data you load, ingest (including via the `ingest_lead`/lead-intake pipeline and any connector such as Northwind, an outreach app, or an agent), import, or generate in the Service, that:

1. you have the **right to process** that personal data and a **valid legal basis** under applicable law (e.g. GDPR Art. 6 — consent or legitimate interest; CCPA/CPRA);
2. you have provided any **notices** and obtained any **consents** required to process it and to **contact** the data subject by the channel(s) you use;
3. the data was **lawfully sourced** (no scraped, purchased, stolen, or otherwise unlawfully obtained personal data where prohibited); and
4. you will honor **opt-outs, suppression, and deletion** requests and keep your suppression lists current.

Customer-Ops carries a **consent/source-provenance** field on the relationship projection specifically so your outreach stays compliant — you must populate and respect it. We are your **processor** for this data (see the [DPA](./data-processing-addendum.md)); compliance with the law of the relationship between you and your contacts is **your** responsibility.

## 2. Email & outreach rules (CAN-SPAM, CASL, GDPR/ePrivacy, and platform rules)

When you use the Service to send or schedule **any** outbound message (campaign or individual), you must:

- **Be truthful in headers and subject lines.** No false or misleading "From," "To," routing, or subject information. Identify the message as an ad where required.
- **Identify yourself** and include a **valid physical postal address** of the sender (CAN-SPAM).
- **Provide a working opt-out / unsubscribe** mechanism and **honor opt-outs promptly** (CAN-SPAM requires within 10 business days; honor sooner). Do not charge a fee, require info beyond an email address, or make the recipient take more than a single step to opt out.
- **Obtain prior consent where required** (e.g. CASL in Canada; GDPR/ePrivacy for many EEA/UK recipients; SMS/telephony consent regimes if you use those channels). The lawful basis is **yours** to establish and document.
- **Suppress** unsubscribed, bounced, complained, and do-not-contact recipients, and respect role-account and known-honeypot hygiene.
- **Comply with the sending platforms' own policies** — including **Listmonk**, **Postiz**, the **Stalwart** mail server, and the **Postmark** transactional terms — and with mailbox-provider bulk-sender requirements (authentication, complaint thresholds, one-click unsubscribe).
- **Not send** unsolicited bulk email/"spam," chain letters, pyramid schemes, or messages to harvested/purchased lists where unlawful.

You are solely responsible for the **content, targeting, frequency, deliverability, and legality** of your communications. The Service is a tool; it does not transfer your legal obligations to us.

## 3. AI agents are draft-and-review — you are the sender

Customer-Ops' relationship agents (lead-triage, follow-up drafter, collections nudge) generate **drafts and suggestions** using the control-plane inference gateway. They do **not** autonomously send communications: drafted outbound email is **staged for explicit human approval** (the agent-inbox) before any send. You remain the author and sender of anything you approve and must review AI-generated content for **accuracy, legality, and appropriateness** before acting on it. Do not use the agents to mass-generate deceptive, harassing, or unlawful messages, or to evade the rules in §2.

## 4. Prohibited uses (general)

You must not use the Service to:

- **Break the law** or facilitate illegal activity, or infringe intellectual-property, privacy, publicity, or contractual rights.
- **Upload or process data you are not authorized to process**, including **special-category** data (GDPR Art. 9), **PHI** (absent a signed BAA and the appropriate isolation tier — see Security & Trust §11), payment-card data outside a compliant flow, government IDs, or **children's** data.
- **Harass, defame, threaten, or harm** any person; send malware, phishing, or fraudulent content; or impersonate any person or entity.
- **Attack or abuse the Service or its tenancy**: attempt to access another workspace's data; defeat, probe, or circumvent **Row-Level Security**, the **membership gate**, authentication, audience-binding, rate limits, or entitlement checks; perform unauthorized penetration testing (coordinate via [security@DOMAIN]); or reverse-engineer except as law permits.
- **Abuse the federation/inference seams**: attempt to forge, replay, or escalate federation tokens; address a workspace you are not a member of; or use the inference gateway to exfiltrate data, mine cryptocurrency, or generate disallowed content.
- **Overload or disrupt** the Service (DoS, scraping beyond documented APIs/rate limits, unauthorized automation, or resource abuse).
- **Misuse third-party data through the federation seams** (Contact-Ops, Accounting-Ops, Email-Ops, Outreach, Meeting-Ops) in violation of those systems' terms or the data subject's rights.

## 5. Self-hosting

If you self-host Customer-Ops, **you operate the deployment** and are responsible for securing it, configuring tenant isolation correctly (running the runtime as the `NOBYPASSRLS` role and enabling the tenancy flag for any multi-tenant use), keeping it patched, and complying with this AUP for any third parties whose data you process. The prohibitions on unlawful use and on processing unauthorized data categories still apply.

## 6. Enforcement

We may investigate suspected violations and may **suspend or terminate** access, **remove or disable** offending content/configuration, **throttle** outbound activity, or **notify** affected parties or authorities, as reasonably necessary and consistent with the Terms and applicable law — including, where the risk warrants (e.g. active spam/abuse, a security threat, a credible legal complaint), **without prior notice**. We will use reasonable efforts to notify you where practicable. Repeat or egregious violations may result in permanent termination. Suspension for AUP cause does not entitle you to a refund except as the Terms provide.

## 7. Reporting abuse

Report suspected abuse or AUP violations to **[abuse@DOMAIN]**; report security vulnerabilities to **[security@DOMAIN]** (see Security & Trust §10).

---

*Companion documents: [Terms of Service](./terms-of-service.md) · [Privacy Policy](./privacy-policy.md) · [Data Processing Addendum](./data-processing-addendum.md) · [Security & Trust](./security-and-trust.md).*

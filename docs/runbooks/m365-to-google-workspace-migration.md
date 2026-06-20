# Runbook: Microsoft 365 → Google Workspace email migration (Cloudflare DNS)

Reusable playbook for moving a customer mailbox/domain off Microsoft 365 onto Google Workspace, where the
domain's DNS is on **Cloudflare**. Distilled from a real migration engagement. Adapt zone IDs / domains
per customer.

> **Golden safety rule:** the migration (copying mail) is non-disruptive and can run anytime. Only the **MX
> cutover** reroutes live mail. Stage every other record first and **delete the Microsoft MX LAST** so there's
> never a no-MX gap, and never flip MX until Google is verified and the mailbox is provisioned to receive
> (otherwise inbound **bounces** instead of sitting safely in M365).

## 0. Prerequisites
- Google Workspace **super admin** (runs the migration + DNS-verification + DKIM).
- Microsoft 365 **Global Admin** for the source tenant (authorizes the migration's OAuth connect).
- Access to the domain's **Cloudflare** zone (DNS-only/grey-cloud for all mail records).
- Confirm which tenant owns the domain: `curl -s https://login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration` → issuer contains the tenant id.

## 1. Verify the domain in Google Workspace
Add Google's verification record to Cloudflare. **Prefer the CNAME method** — the TXT token contains
ambiguous characters (`l` vs `I`, `O` vs `0`) that get corrupted when transcribed from a screenshot. The
CNAME (`<random>` → `gv-...dv.googlehosted.com`) is all lowercase+digits. If you must use TXT, copy it with
the console's copy button, never retype.

## 2. Migrate the mailbox — use Google's Data Migration Service (DMS)
**Do NOT try to script IMAP/EWS with a username+password** — Microsoft retired basic auth for
EAS/POP/IMAP/EWS (end of 2022), so it returns `ErrorAccessDenied`. A pre-existing Azure app only works if it
has the `Mail.Read` (or `Mail.ReadWrite`) **application** permission + admin consent, or EWS
`full_access_as_app`; most "send only" apps don't.

DMS sidesteps all of that with admin OAuth:
1. Google Admin → **Menu → Data → Data import & export → Data import**.
2. Source: **Exchange Online** → Import → **Connect**.
3. Sign in as **M365 Global Admin** and consent (covers all tenant mailboxes — no per-user password, app
   password, IMAP, or customer 2FA).
4. Map **Source Exchange Email** → **Target GUser**; pick Email/Calendar/Contacts; set a far-back date range; **Start**.

This is a copy; live mail keeps flowing to M365 until you do step 3 (the cutover). Re-run a **delta** import
after the cutover to catch anything that landed in M365 during DNS propagation.

## 3. DNS cutover (Cloudflare) — the record set
All records DNS-only. Authenticate to the Cloudflare API with the global key
(`X-Auth-Email`/`X-Auth-Key` from `~/.config/cloudflare.env`) or a scoped token.

| Action | Type | Name | Value | Notes |
|--------|------|------|-------|-------|
| ADD | MX | `@` | `smtp.google.com` (priority **1**) | single modern Google MX |
| ADD | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:admin@<domain>; adkim=r; aspf=r` | monitor-only to start |
| ADD | TXT | `google._domainkey` | `v=DKIM1; k=rsa; p=<key>` | from Google admin; see DKIM gotcha |
| ADD | TXT | `@` | `v=spf1 include:_spf.google.com ~all` | the new SPF |
| DELETE | TXT | `@` | old `v=spf1 include:spf.protection.outlook.com -all` | exactly ONE SPF must remain |
| **DELETE (LAST)** | MX | `@` | old `*.mail.protection.outlook.com` (pri 0) | **this is the flip** |
| KEEP | TXT | `@` | `MS=ms...` | M365 verification; leave until decommission |

**Safe execution order:** add Google MX (pri 1) + DMARC + DKIM + new SPF, delete old SPF (add-new-then-
delete-old so SPF is never absent), confirm everything resolves, **then** delete the Microsoft MX. Because the
M365 MX is priority 0 (lower = preferred), mail keeps going to Microsoft until that final delete.

## 4. Verify (always hit Cloudflare's authoritative NS — public resolvers lag)
```bash
NS=$(dig +short NS <domain> | head -1)
dig +short MX <domain> @$NS                      # expect ONLY smtp.google.com after flip
dig +short TXT <domain> @$NS                      # one SPF (google) + MS= ; NO outlook
dig +short TXT _dmarc.<domain> @$NS
dig +short TXT google._domainkey.<domain> @$NS    # DKIM present
```
The Cloudflare **API delete returns success but the authoritative NS lags a few seconds** — poll, don't trust
the first dig. Confirm config truth via `GET /zones/<zone>/dns_records?type=MX` (source of truth).

After DNS is in: Workspace admin clicks **"Start authentication"** for DKIM, then test mail both ways.

## 5. Gotchas (all hit during a real migration)
- **Basic auth is dead** on M365 → scripted IMAP/EWS fails; use DMS or an Azure app with real mail-read perms.
- **DKIM key line-wrap**: the Google DKIM `p=` value often arrives wrapped across lines. Rejoin to ONE string
  with **no space** at the break; Cloudflare auto-splits >255-char TXT — do not split it manually. Sanity-check:
  `base64 -d` the `p=` value → ~294 bytes = valid RSA-2048.
- **Propagation lag** at Cloudflare's edge after API writes/deletes — poll the authoritative NS.
- **Global API key hygiene**: `~/.config/cloudflare.env` holds a full-account global key. Prefer a zone-scoped
  API token per customer.
- **Web ≠ email**: if the customer's website is on a builder (Wix/Duda/Squarespace), you **cannot** point a
  second domain by copying its A records — the builder 404s unconnected hostnames (test:
  `curl -I -H "Host: <yourdomain>" http://<builder-IP>/`). Use a Cloudflare 301 redirect rule, or connect the
  domain inside the builder's dashboard.

## 6. Rollback
The only risky step is the Microsoft MX delete. To roll back the flip, re-add the M365 MX
(`<tenant-host>.mail.protection.outlook.com`, priority 0) — inbound reverts to M365 within the propagation
window. **Record the old record set** (export `GET /zones/<zone>/dns_records` to a safe place) before deleting.

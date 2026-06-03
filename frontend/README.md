# Customer-Ops — Frontend

Next.js 15 (App Router) shell for the Customer-Ops relationship / funnel cockpit.

**Phase 1 scope:** SSO sign-in + an empty authenticated dashboard shell. The CRM
cockpit (contact 360, lead → prospect → customer pipeline, invoicing/outreach
surfaces) is Phase 2.

## Auth flow (suite-canonical SSO)

1. `/auth/login` → links to the backend `GET /api/v1/auth/keycloak`.
2. The backend runs the uchub Keycloak OIDC dance and redirects back to
   `/auth/sso-callback?token=<session-jwt>`.
3. The callback validates the token (`GET /auth/profile`), stores it, and routes
   to `/dashboard`.
4. `/dashboard` is auth-gated (client-side) and lists the caller's workspaces via
   `GET /auth/me/workspaces` (membership-derived) — proving the tenancy wiring.

There is no local password flow: Customer-Ops is SSO-only.

## Develop

```bash
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_API_URL to the backend
npm run dev                  # http://localhost:3000
```

## Build

```bash
npm run build                # standalone output for the Dockerfile
```

`NEXT_PUBLIC_API_URL` is inlined at build time; pass it as a `--build-arg` in CI.

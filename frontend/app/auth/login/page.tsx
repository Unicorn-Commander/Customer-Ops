'use client';

import { ssoLoginUrl } from '@/lib/api';

/**
 * SSO sign-in. Customer-Ops is SSO-only (uchub Keycloak); there is no local
 * password flow. The button navigates to the backend's Keycloak entry point,
 * which runs the OIDC dance and redirects back to /auth/sso-callback with a
 * session token.
 */
export default function LoginPage() {
  return (
    <div className="co-center">
      <div className="co-card">
        <h1 className="co-title">
          Customer<span style={{ color: 'var(--primary)' }}>-Ops</span>
        </h1>
        <p className="co-subtitle">
          The relationship &amp; funnel cockpit. Sign in with your Unicorn Commander
          account to continue.
        </p>
        <a className="co-btn" href={ssoLoginUrl()}>
          Sign in with SSO
        </a>
        <p className="co-muted" style={{ marginTop: 16, textAlign: 'center' }}>
          uchub Keycloak · single sign-on
        </p>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSession, getStoredUser, getToken, CustomerOpsUser } from '@/lib/api';

/**
 * Authenticated dashboard shell. Phase 1 is deliberately empty — it proves the
 * SSO session round-trip and the workspace wiring; the CRM cockpit (contact
 * 360, pipeline, invoicing surface) lands in Phase 2.
 *
 * Auth gate is client-side (the session token lives in localStorage): no token
 * => bounce to login. A server-side gate replaces this once the session moves
 * to an httpOnly cookie (a Phase 2 hardening).
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<CustomerOpsUser | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    setUser(getStoredUser<CustomerOpsUser>());
    setReady(true);
  }, [router]);

  if (!ready) {
    return (
      <div className="co-center">
        <div className="co-spinner" />
      </div>
    );
  }

  const signOut = () => {
    clearSession();
    router.replace('/auth/login');
  };

  return (
    <div className="co-shell">
      <header className="co-topbar">
        <div className="co-brand">
          Customer<span>-Ops</span>
        </div>
        <div className="co-row">
          {user && <span className="co-muted">{user.email}</span>}
          <button className="co-btn co-btn--ghost" style={{ width: 'auto' }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="co-content">{children}</main>
    </div>
  );
}

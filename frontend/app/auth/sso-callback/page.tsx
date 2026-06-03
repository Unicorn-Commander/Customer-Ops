'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiGet, setSession, clearSession, CustomerOpsUser } from '@/lib/api';

function SsoCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setError('No authentication token returned from SSO.');
      return;
    }
    (async () => {
      try {
        // Validate the token by fetching the profile, then persist the session.
        const user = await apiGet<CustomerOpsUser>('/auth/profile', token);
        setSession(token, user);
        router.replace('/dashboard');
      } catch {
        clearSession();
        setError('Could not complete sign-in. Please try again.');
      }
    })();
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="co-card" style={{ textAlign: 'center' }}>
        <p className="co-error">{error}</p>
        <button className="co-btn co-btn--ghost" onClick={() => router.replace('/auth/login')}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <div className="co-spinner" />
      <p className="co-muted" style={{ marginTop: 16 }}>
        Completing sign-in…
      </p>
    </div>
  );
}

export default function SsoCallbackPage() {
  return (
    <div className="co-center">
      <Suspense
        fallback={
          <div style={{ textAlign: 'center' }}>
            <div className="co-spinner" />
            <p className="co-muted" style={{ marginTop: 16 }}>
              Completing sign-in…
            </p>
          </div>
        }
      >
        <SsoCallbackInner />
      </Suspense>
    </div>
  );
}

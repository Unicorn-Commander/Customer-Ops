'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

/**
 * Entry: bounce to the dashboard when a session exists, else to login. Phase 2
 * replaces this with the marketing / funnel landing surface.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/dashboard' : '/auth/login');
  }, [router]);

  return (
    <div className="co-center">
      <div className="co-spinner" />
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Radar } from 'lucide-react';
import { getToken } from '@/lib/api';

/**
 * Entry: bounce to the dashboard when a session exists, else to login. Phase 2
 * replaces this with the marketing / funnel landing surface. Renders the same
 * on-brand spinner as the global loading boundary so the very first paint and
 * the redirect target read as one continuous surface (no legacy-card flash).
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/dashboard' : '/auth/login');
  }, [router]);

  return (
    <div className="co-ambient co-ambient-grid grid min-h-screen place-items-center px-6">
      <span className="relative grid h-14 w-14 place-items-center rounded-[16px] bg-gradient-to-br from-accent to-fuchsia shadow-glow">
        <span aria-hidden className="co-glow absolute -inset-6 h-[120px] w-[120px]" />
        <Radar className="h-7 w-7 text-white" strokeWidth={2.3} />
        <span
          aria-hidden
          className="absolute -inset-1.5 rounded-[18px] border-2 border-accent/30 border-t-accent motion-safe:animate-spin"
        />
      </span>
      <span className="sr-only" role="status">Loading Customer-Ops…</span>
    </div>
  );
}

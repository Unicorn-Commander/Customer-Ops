'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Radar, ShieldCheck, AlertTriangle, ArrowLeft } from 'lucide-react';
import { apiGet, exchangeSsoCode, setSession, clearSession, CustomerOpsUser } from '@/lib/api';

/**
 * SSO return leg. Keycloak hands back here with a single-use `code` query param
 * (NOT the session token — that must never travel in a URL). We POST the code to
 * exchange it for the token, validate the token by fetching the profile, persist
 * the session, and bounce to the cockpit. Presentation matches the cinematic
 * login screen (glass + ambient field) so the sign-in flow reads as one
 * continuous surface — no jump to a legacy card.
 */

/** The shared cinematic shell (ambient field + centered glass card). */
function CallbackShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="co-ambient co-ambient-grid relative grid min-h-screen place-items-center overflow-hidden px-6">
      <div aria-hidden className="co-glow absolute left-[18%] top-[20%] h-72 w-72 opacity-55" />
      <div aria-hidden className="co-glow co-glow-fuchsia absolute bottom-[18%] right-[16%] h-72 w-80 opacity-40" />
      <div className="co-glass co-glass-edge relative w-full max-w-[430px] animate-fade-up p-8 text-center sm:p-10">
        {children}
      </div>
    </div>
  );
}

/** The "completing sign-in" pending state — the brand mark with a spinner ring. */
function CompletingState() {
  return (
    <CallbackShell>
      <div className="relative mx-auto mb-6 w-fit">
        <span aria-hidden className="co-glow absolute -inset-3 h-[88px] w-[88px]" />
        <span className="relative grid h-16 w-16 place-items-center rounded-[18px] bg-gradient-to-br from-accent to-fuchsia shadow-glow">
          <Radar className="h-8 w-8 text-white" strokeWidth={2.2} />
          <span
            aria-hidden
            className="absolute -inset-1.5 rounded-[20px] border-2 border-accent/30 border-t-accent motion-safe:animate-spin"
          />
        </span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-primary">Completing sign-in…</h1>
      <p className="mx-auto mt-2 max-w-[300px] text-sm leading-relaxed text-tertiary" role="status">
        Verifying your session with Unicorn&nbsp;Commander.
      </p>
      <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-muted">
        <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.4} />
        Single sign-on · secured by Unicorn Commander
      </div>
    </CallbackShell>
  );
}

function SsoCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // The SSO code is single-use. React StrictMode double-invokes effects in dev,
  // so without this gate the second pass re-POSTs the now-dead code, 400s, and
  // the catch below calls clearSession() — wiping the session the first pass
  // just set. Redeem exactly once.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const code = searchParams.get('code');
    if (!code) {
      setError('No authentication code returned from SSO.');
      return;
    }
    // Scrub the single-use code from the URL now that we've read it — it must
    // not linger in the address bar, browser history, or Referer headers.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }
    (async () => {
      try {
        // Swap the single-use code for the session token over POST (the token
        // never rides a URL), validate it by fetching the profile, then persist.
        const { access_token } = await exchangeSsoCode(code);
        const user = await apiGet<CustomerOpsUser>('/auth/profile', access_token);
        setSession(access_token, user);
        router.replace('/dashboard');
      } catch {
        clearSession();
        setError('Could not complete sign-in. Please try again.');
      }
    })();
  }, [searchParams, router]);

  if (error) {
    return (
      <CallbackShell>
        <div className="relative mx-auto mb-6 w-fit">
          <span aria-hidden className="co-glow co-glow-fuchsia absolute -inset-3 h-[88px] w-[88px] opacity-70" />
          <span className="relative grid h-16 w-16 place-items-center rounded-[18px] bg-danger-subtle text-danger ring-1 ring-danger/30">
            <AlertTriangle className="h-8 w-8" strokeWidth={2.1} />
          </span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Sign-in didn&rsquo;t complete</h1>
        <p className="mx-auto mt-2 max-w-[320px] text-sm leading-relaxed text-tertiary" role="alert">
          {error}
        </p>
        <button
          type="button"
          onClick={() => router.replace('/auth/login')}
          className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-token bg-accent px-4 py-3 text-sm font-semibold text-accent-contrast shadow-glow transition-[background-color,transform] duration-fast ease-token hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.4} />
          Back to sign in
        </button>
      </CallbackShell>
    );
  }

  return <CompletingState />;
}

export default function SsoCallbackPage() {
  return (
    <Suspense fallback={<CompletingState />}>
      <SsoCallbackInner />
    </Suspense>
  );
}

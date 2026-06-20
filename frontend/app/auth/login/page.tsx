'use client';

import { ShieldCheck, ArrowRight } from 'lucide-react';
import { ssoLoginUrl } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * SSO sign-in. Customer-Ops is SSO-only — no local password. The button hands
 * off to the backend's Keycloak entry point (auth.unicorncommander.ai, realm
 * uchub), which runs the OIDC dance and returns to /auth/sso-callback with a
 * session. The user never sees "Keycloak" — only "Unicorn Commander".
 */
export default function LoginPage() {
  return (
    <div className="co-ambient co-ambient-grid relative grid min-h-screen place-items-center overflow-hidden px-6">
      <div className="absolute right-5 top-5 z-10">
        <ThemeToggle />
      </div>

      {/* ambient blooms */}
      <div aria-hidden className="co-glow absolute left-[18%] top-[20%] h-72 w-72 opacity-60" />
      <div aria-hidden className="co-glow co-glow-fuchsia absolute right-[16%] bottom-[18%] h-72 w-80 opacity-45" />

      <div className="co-glass co-glass-edge relative w-full max-w-[430px] animate-fade-up p-8 text-center sm:p-10">
        {/* brand mark */}
        <div className="relative mx-auto mb-6 w-fit">
          <span aria-hidden className="co-glow absolute -inset-3 h-[88px] w-[88px]" />
          <img
            src="/brand-mark.png"
            alt="Customer-Ops"
            className="relative h-16 w-16 rounded-[18px] shadow-glow"
          />
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="co-wordmark">Customer</span>
          <span className="text-tertiary">-Ops</span>
        </h1>
        <p className="mx-auto mt-2.5 max-w-[320px] text-sm leading-relaxed text-tertiary">
          The relationship &amp; funnel cockpit of the Unicorn&nbsp;Commander suite. Sign in to continue.
        </p>

        <a
          href={ssoLoginUrl()}
          className="mt-7 inline-flex w-full items-center justify-center gap-2.5 rounded-token bg-accent px-4 py-3 text-sm font-semibold text-accent-contrast shadow-glow transition-[background-color,transform] duration-fast ease-token hover:-translate-y-0.5 hover:bg-accent-hover"
        >
          <ShieldCheck className="h-[18px] w-[18px]" strokeWidth={2.4} />
          Continue with Unicorn&nbsp;Commander
          <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
        </a>

        <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          Single sign-on · secured by Unicorn Commander
        </div>
      </div>
    </div>
  );
}

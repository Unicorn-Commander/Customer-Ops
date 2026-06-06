'use client';

import { useEffect } from 'react';

/**
 * Last-resort error boundary. Unlike `app/error.tsx`, this catches errors thrown
 * by the ROOT layout itself, which means our normal layout — and the stylesheets
 * it imports (globals.css / theme.css) — never mounted. So this component renders
 * its OWN <html>/<body> and CANNOT rely on Tailwind or the `--co-*` tokens being
 * present. Everything here is inline-styled with the dark-palette values copied
 * from theme.css so the screen still reads as Customer-Ops even with zero CSS.
 *
 * Intentionally dependency-free (no lucide, no Link) — a crash this deep should
 * pull in nothing that could itself fail. A full-page reload (`reset()` falling
 * back to location.reload) is the only recovery that makes sense here.
 */

// Dark-palette literals mirrored from theme.css (:root[data-theme="dark"]).
const C = {
  base: '#08090e',
  raised: '#0f1119',
  edge: 'rgba(52,58,80,0.65)',
  primary: '#f1f3fa',
  secondary: '#bdc4d6',
  tertiary: '#8c94aa',
  accent: '#8468ff',
  accentHover: '#9a80ff',
  danger: '#f87171',
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Customer-Ops fatal error:', error);
  }, [error]);

  const retry = () => {
    try {
      reset();
    } catch {
      if (typeof window !== 'undefined') window.location.reload();
    }
  };

  return (
    <html lang="en" data-theme="dark">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          backgroundColor: C.base,
          color: C.secondary,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          WebkitFontSmoothing: 'antialiased',
          backgroundImage:
            'radial-gradient(55% 45% at 6% -12%, rgba(132,104,255,0.20), transparent 60%), radial-gradient(75% 65% at 70% 118%, rgba(236,124,255,0.10), transparent 62%)',
        }}
      >
        <div
          role="alert"
          style={{
            width: '100%',
            maxWidth: 440,
            textAlign: 'center',
            backgroundColor: C.raised,
            border: `1px solid ${C.edge}`,
            borderRadius: 22,
            padding: 40,
            boxShadow: '0 24px 60px -16px rgba(0,0,0,0.65)',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              margin: '0 auto 22px',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 16,
              backgroundColor: 'rgba(248,113,113,0.13)',
              color: C.danger,
              fontSize: 28,
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            !
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.primary, letterSpacing: '-0.01em' }}>
            Customer-Ops couldn&rsquo;t start
          </h1>
          <p style={{ margin: '10px auto 0', maxWidth: 340, fontSize: 14, lineHeight: 1.55, color: C.tertiary }}>
            Something failed before the app could load. This is almost always temporary — reloading
            usually clears it.
          </p>
          <button
            type="button"
            onClick={retry}
            style={{
              marginTop: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '12px 20px',
              border: 'none',
              borderRadius: 10,
              backgroundColor: C.accent,
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = C.accentHover)}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = C.accent)}
          >
            Reload Customer-Ops
          </button>
          {error.digest && (
            <p style={{ marginTop: 24, fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: C.tertiary }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

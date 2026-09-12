/**
 * The quiet end of a share link. Deliberately says nothing about whether the
 * token ever existed, was withdrawn, or expired — a share URL is guessable
 * enough that the 404 must not become an oracle.
 */

import { DEFAULT_THEME, themeCss } from '@/lib/quotes/brand-ops/brand-tokens';

const css = `${themeCss(DEFAULT_THEME)}
body{margin:0;background:var(--q-paper)}
.qnf{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--q-paper);color:var(--q-ink);font-family:var(--q-font-body)}
.qnf main{max-width:52ch}
.qnf h1{font-family:var(--q-font-display);font-weight:400;font-size:clamp(30px,6vw,44px);line-height:1.05;margin:0 0 14px;text-wrap:balance}
.qnf p{color:var(--q-muted);font-size:16px;line-height:1.5;margin:0}
.qnf .label{font-family:var(--q-font-mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--q-muted);display:block;margin-bottom:14px}`;

export default function QuoteNotFound() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      {/* This page deliberately loads its own faces: it is the public document
          surface, not the cockpit, and must not inherit the app's typography. */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="qnf">
        <main>
          <span className="label">Quote link</span>
          <h1>This quote link does not resolve.</h1>
          <p>
            It may have been mistyped, withdrawn, or replaced by a newer version. Ask the sender for the current link.
          </p>
        </main>
      </div>
    </>
  );
}

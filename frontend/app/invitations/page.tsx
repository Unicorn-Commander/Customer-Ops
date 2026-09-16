'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiPost, getToken, ssoLoginUrl } from '@/lib/api';

export default function AcceptInvitationPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setSignedIn(Boolean(getToken())); }, []);
  return <main className="mx-auto max-w-xl space-y-5 p-6 text-primary">
    <h1 className="text-2xl font-semibold">Accept a workspace invitation</h1>
    <p>Sign in with the verified email named in your invitation, then paste your private token here. Keep the token out of links and public messages.</p>
    {!signedIn ? <div className="space-y-3"><p>After signing in, return to this page to enter the token.</p><a className="text-accent underline" href={ssoLoginUrl()}>Sign in with Unicorn Commander</a></div> : <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(''); setMessage('');
      try { await apiPost('/workspace-onboarding/invitations/accept', { token: token.trim() }); setToken(''); setMessage('Invitation accepted. Your workspace membership is ready. Product access is managed separately.'); }
      catch (e) { setError(e instanceof Error ? e.message : 'Unable to accept invitation.'); }
      finally { setBusy(false); }
    }}><label className="block">Private invitation token<input className="mt-1 w-full rounded-token border border-subtle bg-surface-overlay p-2" type="password" autoComplete="off" required minLength={43} maxLength={43} value={token} onChange={(e) => setToken(e.target.value)} /></label><button className="rounded-token bg-accent px-3 py-2 text-white disabled:opacity-50" disabled={busy}>Accept invitation</button></form>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <Link className="text-accent underline" href="/dashboard/settings/workspace">Workspace settings</Link>
  </main>;
}

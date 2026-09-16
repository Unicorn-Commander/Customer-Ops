'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiDelete, apiGet, apiPost, type MyWorkspace } from '@/lib/api';

type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };
type CreatedWorkspace = { workspace_id: string; display_name: string; workspace_id_source: string };
const field = 'w-full rounded-token border border-subtle bg-surface-overlay p-2 text-sm text-primary';
const button = 'rounded-token bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50';

/** Owner-only controls; the server independently checks each selected workspace. */
export function OnboardingPanel({ workspaceId }: { workspaceId: string }) {
  const [target, setTarget] = useState(workspaceId);
  const [owned, setOwned] = useState<MyWorkspace[]>([]);
  useEffect(() => { let active = true; apiGet<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces').then((result) => { if (active) setOwned(result.workspaces.filter((w) => w.role.toLowerCase() === 'owner' && w.workspace_id !== workspaceId)); }).catch(() => {}); return () => { active = false; }; }, [workspaceId]);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [rows, setRows] = useState<Invitation[]>([]);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Keep a failed/uncertain request stable on retry; a new payload gets a new key.
  const reservation = useRef<{ name: string; source: string; id: string } | null>(null);
  const path = `/workspace-onboarding/workspaces/${encodeURIComponent(target)}/invitations`;
  useEffect(() => {
    let active = true;
    setToken(''); setRows([]); setError('');
    apiGet<Invitation[]>(path).then((value) => { if (active) setRows(value); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [path]);
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-token-lg border border-subtle bg-surface-raised p-5">
    <h2 className="font-semibold text-primary">Workspace invitations</h2>
    <p className="text-sm text-secondary">Create a token and share it privately with the named person. No email is sent. They must sign in with that verified email and paste the token on the <Link className="text-accent underline" href="/invitations">accept invitation page</Link>.</p>
    <label className="block text-sm">Manage invitations in
      <select aria-label="Invitation workspace" className={field} value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
        <option value={workspaceId}>Current workspace</option>
        {owned.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{w.display_name}</option>)}
        {created && !owned.some((w) => w.workspace_id === created.workspace_id) && <option value={created.workspace_id}>{created.display_name}</option>}
      </select>
    </label>
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act(async () => {
      setToken('');
      const result = await apiPost<{ invitation_token: string }>(path, { email, role, expires_in_hours: 72 });
      setToken(result.invitation_token); setRows(await apiGet<Invitation[]>(path));
    }); }}>
      <label className="block text-sm">Verified sign-in email<input className={field} type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block text-sm">Role<select className={field} value={role} onChange={(e) => setRole(e.target.value)}><option value="VIEWER">Viewer</option><option value="MEMBER">Member</option><option value="MANAGER">Manager</option><option value="ADMIN">Admin</option><option value="OWNER">Owner</option></select></label>
      <p className="text-xs text-secondary">Expires in 72 hours. An owner can manage members and create workspaces.</p>
      <button className={button} disabled={busy}>Create invitation</button>
    </form>
    {token && <div className="space-y-2"><label className="block text-sm">Private token (shown once)<input className={field} readOnly value={token} autoComplete="off" /></label><button className={button} onClick={() => setToken('')}>Hide token</button></div>}
    <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="break-words text-sm"><span>{row.email} · {row.role.toLowerCase()} · {row.status.toLowerCase()} · expires {new Date(row.expiresAt).toLocaleString()}</span>{row.status === 'PENDING' && <button className="ml-2 text-accent underline" disabled={busy} onClick={() => void act(async () => { await apiDelete(`${path}/${encodeURIComponent(row.id)}`); setToken(''); setRows(await apiGet<Invitation[]>(path)); })}>Revoke</button>}</li>)}</ul>
    <details className="border-t border-subtle pt-3"><summary className="cursor-pointer font-medium">Create another workspace</summary>
      <p className="my-2 text-sm text-secondary">Creates an empty workspace with you as owner. Your default workspace stays the same. Product access requires its own entitlement.</p>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void act(async () => {
        const trimmed = name.trim();
        if (!reservation.current || reservation.current.name !== trimmed || reservation.current.source !== workspaceId) reservation.current = { name: trimmed, source: workspaceId, id: crypto.randomUUID() };
        const result = await apiPost<CreatedWorkspace>('/workspace-onboarding/workspaces', { source_workspace_id: workspaceId, display_name: trimmed, request_id: reservation.current.id });
        setCreated(result); setTarget(result.workspace_id);
        setMessage(result.workspace_id_source === 'uc-registry' ? 'Workspace created and registered. Product access is managed separately.' : 'Workspace created locally. Suite registration is not confirmed; product access is managed separately.');
      }); }}><label className="block text-sm">Workspace name<input className={field} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label><button className={button} disabled={busy}>Create empty workspace</button></form>
    </details>
    {message && <p role="status" className="text-sm text-secondary">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}

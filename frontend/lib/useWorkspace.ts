'use client';

import { useEffect, useState } from 'react';
import { resolveWorkspaceId } from './customers';
import { getWorkspace } from './workspace';

/**
 * Resolve the caller's active workspace id once, client-side. Customer-Ops
 * consumes workspace ids from the backend (membership-derived); it never mints
 * one. While tenancy is in its rollout posture the backend resolves to the
 * bootstrap workspace, so this returns that.
 */
export function useWorkspace(enabled = true): {
  workspaceId: string | null;
  canWrite: boolean;
  loading: boolean;
  error: string | null;
} {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setCanWrite(false); setWorkspaceId(null); setLoading(false); return; }
    let cancelled = false;
    resolveWorkspaceId()
      .then((id) => {
        if (cancelled) return;
        if (!id) setError('No workspace membership.');
        setWorkspaceId(id);
        if (id) getWorkspace(id).then((workspace) => {
          if (!cancelled) setCanWrite(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'].includes(workspace.your_role?.toUpperCase() ?? ''));
        }).catch(() => { if (!cancelled) setCanWrite(false); });
      })
      .catch(() => !cancelled && setError('Could not resolve workspace.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { workspaceId, canWrite, loading, error };
}

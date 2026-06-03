'use client';

import { useEffect, useState } from 'react';
import { resolveWorkspaceId } from './customers';

/**
 * Resolve the caller's active workspace id once, client-side. Customer-Ops
 * consumes workspace ids from the backend (membership-derived); it never mints
 * one. While tenancy is in its rollout posture the backend resolves to the
 * bootstrap workspace, so this returns that.
 */
export function useWorkspace(): {
  workspaceId: string | null;
  loading: boolean;
  error: string | null;
} {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveWorkspaceId()
      .then((id) => {
        if (cancelled) return;
        if (!id) setError('No workspace membership.');
        setWorkspaceId(id);
      })
      .catch(() => !cancelled && setError('Could not resolve workspace.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return { workspaceId, loading, error };
}

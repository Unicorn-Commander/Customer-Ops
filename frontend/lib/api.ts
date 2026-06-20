/**
 * Minimal browser API client for Customer-Ops (Phase 1).
 *
 * The auth model mirrors the suite pattern: the backend owns the Keycloak OIDC
 * dance and issues a local session JWT, which the browser stores in
 * localStorage and sends as a Bearer token. This is intentionally tiny — the
 * Phase 2 cockpit replaces it with a typed data layer.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || '/api/v1';

const TOKEN_KEY = 'access_token';
const USER_KEY = 'user';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser<T = unknown>(): T | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

/**
 * Error that carries the HTTP status, so callers can tell an auth failure (401)
 * apart from a genuine connectivity/server problem (5xx, network). Without this
 * a 401 looked identical to "the backend is down".
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A 401 means the session token is missing or expired — NOT that the backend is
 * unreachable. A stale `user` can linger in localStorage after the token dies,
 * so the app still thinks it's signed in and strands the user on a misleading
 * error. Clear the dead session and bounce to SSO sign-in so they can recover.
 */
function handleAuthFailure(): void {
  if (typeof window === 'undefined') return;
  clearSession();
  if (window.location.pathname !== '/auth/login') {
    window.location.assign('/auth/login');
  }
}

/** The backend SSO entry point — redirects the browser to Keycloak. */
export function ssoLoginUrl(): string {
  return `${API_BASE}/auth/keycloak`;
}

/** Authenticated GET against the backend. Throws on non-2xx. */
export async function apiGet<T = unknown>(path: string, token?: string): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    if (res.status === 401) handleAuthFailure();
    throw new ApiError(res.status, `GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Authenticated POST/PATCH against the backend. Throws on non-2xx. */
async function apiSend<T = unknown>(
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const bearer = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message ? ` — ${Array.isArray(j.message) ? j.message.join(', ') : j.message}` : '';
    } catch {
      /* ignore */
    }
    if (res.status === 401) handleAuthFailure();
    throw new ApiError(res.status, `${method} ${path} failed: ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

export function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiSend<T>('POST', path, body);
}

export function apiPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiSend<T>('PATCH', path, body);
}

/**
 * Authenticated DELETE against the backend. Throws on non-2xx.
 *
 * Some DELETE endpoints answer 200 with no body (e.g. idempotent soft-revoke),
 * so we tolerate an empty/non-JSON body and resolve to `undefined` rather than
 * choking on `res.json()`.
 */
export async function apiDelete<T = void>(path: string): Promise<T> {
  const bearer = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message ? ` — ${Array.isArray(j.message) ? j.message.join(', ') : j.message}` : '';
    } catch {
      /* ignore */
    }
    if (res.status === 401) handleAuthFailure();
    throw new ApiError(res.status, `DELETE ${path} failed: ${res.status}${detail}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

export interface CustomerOpsUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
}

export interface MyWorkspace {
  workspace_id: string;
  slug: string;
  display_name: string;
  role: string;
  is_default: boolean;
}

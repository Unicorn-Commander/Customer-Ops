'use client';

import { useEffect } from 'react';
import { getToken } from '@/lib/api';

const hasCallback = (params: URLSearchParams) => params.has('code') && params.has('state');

/**
 * Pattern B landing gate. The page itself is server-rendered marketing content;
 * this guard hands app intent, returning users, and both OIDC response modes to
 * the existing auth flow without changing that flow.
 */
export function LandingGate() {
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));

    if (hasCallback(query) || hasCallback(fragment)) {
      const callback = hasCallback(fragment) ? fragment : query;
      window.location.replace(`/auth/sso-callback?${callback.toString()}`);
      return;
    }

    if (query.has('app')) {
      window.location.replace('/auth/login');
      return;
    }

    let returningUser = Boolean(getToken() || window.localStorage.getItem('user'));
    if (!returningUser) {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index) || '';
        if (key.startsWith('co_') || key.startsWith('co-')) {
          returningUser = true;
          break;
        }
      }
    }

    if (returningUser) {
      window.location.replace(getToken() ? '/dashboard' : '/auth/login');
    }
  }, []);

  return null;
}

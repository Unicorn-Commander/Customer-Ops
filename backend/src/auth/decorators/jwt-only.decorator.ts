import { SetMetadata } from '@nestjs/common';

export const JWT_ONLY_KEY = 'jwtOnly';

/**
 * Mark a route or controller as SESSION-ONLY: the JwtAuthGuard rejects a
 * `co_pat_` Personal Access Token bearer here with a 403. Used on the PAT
 * management routes so a leaked PAT cannot mint or revoke PATs (no
 * self-perpetuation past a revoke) — those actions require the human SSO
 * session. A normal JWT session passes through unchanged.
 */
export const JwtOnly = () => SetMetadata(JWT_ONLY_KEY, true);

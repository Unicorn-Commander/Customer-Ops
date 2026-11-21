import { ConfigService } from '@nestjs/config';

/**
 * HOME-SUMMARY CONTRACT v1 (Kit, FINISHER-77, 11-21; per DESKO-128 (2)).
 *
 * Two env levers, both read per call so a rollout needs no restart:
 *   - HOME_SUMMARY_ENABLED   (default OFF) — off means the route 404s as if it
 *                            did not exist.
 *   - HOME_CALLER_CLIENT_ID  (default 'ops-center-home') — the only `azp` the
 *                            service-account caller may present.
 */

export const DEFAULT_HOME_CALLER_CLIENT_ID = 'ops-center-home';

export function boolEnv(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return fallback;
}

/** HOME_SUMMARY_ENABLED — default OFF. Off => the controller 404s. */
export function homeSummaryEnabled(config: ConfigService): boolean {
  return boolEnv(config.get<string>('HOME_SUMMARY_ENABLED'), false);
}

/** HOME_CALLER_CLIENT_ID — the single accepted service-account `azp`. */
export function homeCallerClientId(config: ConfigService): string {
  const raw = (config.get<string>('HOME_CALLER_CLIENT_ID') ?? '').trim();
  return raw || DEFAULT_HOME_CALLER_CLIENT_ID;
}

/**
 * The app's own public UI base for the href fields (the ring's UI). Prefer the
 * existing FRONTEND_URL (the SPA origin every redirect already uses), then
 * APP_PUBLIC_URL, then a production default. NEVER a localhost URL — a hint that
 * resolves to loopback is dropped so a link can never point at a dev box.
 */
export function appPublicUrl(config: ConfigService): string {
  const candidates = [config.get<string>('FRONTEND_URL'), config.get<string>('APP_PUBLIC_URL')];
  for (const candidate of candidates) {
    const base = (candidate ?? '').trim().replace(/\/$/, '');
    if (!base) continue;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base)) continue;
    return base;
  }
  return 'https://customerops.unicorncommander.ai';
}

/**
 * M365HealthIndicator — the connector's seam row in `GET /health/integrations`.
 *
 * Unlike the six sibling-app seams there is no UC service to `tools/list` against
 * (the target is Microsoft Graph, reached per-user with a delegated token, not a
 * server-to-server seam). So this probe reports CONFIGURATION honestly rather than
 * making a live network call on every health hit:
 *   • M365_CLIENT_ID unset  → configured:false ("Not connected" on the page).
 *   • configured            → ok:true (the app credential is present; per-user
 *                              connect/sync is where a real Graph call happens).
 * Never throws (the aggregate route stays 200).
 */

import { Injectable } from '@nestjs/common';
import { M365Config } from './m365.config';
import { SeamHealth } from '../health/seam-health';

@Injectable()
export class M365HealthIndicator {
  constructor(private readonly config: M365Config) {}

  async ping(): Promise<SeamHealth> {
    const seam = 'm365';
    if (!this.config.isConfigured) {
      return {
        seam,
        configured: false,
        ok: false,
        status: null,
        detail: 'not-configured',
        latencyMs: null,
      };
    }
    // Configured: the client id + secret are present. We don't round-trip to
    // Microsoft here (that's a per-user delegated call), so report ready.
    return { seam, configured: true, ok: true, status: 200, detail: 'ok', latencyMs: null };
  }
}

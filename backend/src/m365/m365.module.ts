import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { LeadIntakeModule } from '../lead-intake/lead-intake.module';
import { M365Config } from './m365.config';
import { TokenCipher } from './crypto/token-cipher';
import { M365ConnectionStore } from './store/m365-connection.store';
import { MsalClientFactory } from './oauth/msal-client.factory';
import { M365StateService } from './oauth/m365-state.service';
import { M365OAuthService } from './oauth/m365-oauth.service';
import { M365OAuthController } from './oauth/m365-oauth.controller';
import { M365GraphClient } from './graph/m365-graph.client';
import { M365SyncService } from './sync/m365-sync.service';
import { M365SyncController } from './sync/m365-sync.controller';
import { M365HealthIndicator } from './m365.health';

/**
 * The Microsoft 365 (Graph) connector — `m365` everywhere (the word `graph` is
 * reserved for the FalkorDB module; the only "graph"-bearing identifier here is
 * the clearly-prefixed M365GraphClient).
 *
 * A signed-in user links their OWN Microsoft 365 account via OAuth (MSAL
 * ConfidentialClientApplication) and pulls their Outlook contacts (v1) INTO
 * Customer-Ops by funneling each through the EXISTING LeadIntakeService — there is
 * NO parallel ingestion path and NO second phonebook. Refresh tokens are stored
 * AES-256-GCM-encrypted (TokenCipher); the OAuth `state` is JWT-signed + single-use.
 *
 * DORMANT by construction: with M365_CLIENT_ID unset every provider constructs
 * inert, the routes return a clean 503 / `{configured:false}`, and nothing in the
 * existing app changes. Depends on WorkspaceModule (resolve the sync target +
 * RLS funnel), AuthModule (JwtAuthGuard + the JwtService the signed state uses),
 * and LeadIntakeModule (the ingest funnel).
 */
@Module({
  imports: [WorkspaceModule, AuthModule, LeadIntakeModule],
  controllers: [M365OAuthController, M365SyncController],
  providers: [
    M365Config,
    TokenCipher,
    M365ConnectionStore,
    MsalClientFactory,
    M365StateService,
    M365OAuthService,
    M365GraphClient,
    M365SyncService,
    M365HealthIndicator,
  ],
  // Exported so HealthModule can register the `m365` seam in /health/integrations.
  exports: [M365HealthIndicator],
})
export class M365Module {}

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { QuotePresentation } from './quote-snapshot';

@Injectable()
export class QuotePresentationService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
    private readonly map: FederationWorkspaceMapService,
    private readonly contacts: ContactOpsPort,
  ) {}
  async letterhead(workspaceId: string) {
    const setting = await this.db.withWorkspace(workspaceId, null, (tx) =>
      tx.workspaceLetterhead.findUnique({ where: { workspaceId } }),
    );
    const unavailable = {
      linked: !!setting,
      letterhead: { legal_name: 'Vendor details unavailable', address_lines: [] as string[] },
      degradations: ['vendor_details_unavailable'],
    };
    const base = this.config.get<string>('ACCOUNTING_OPS_BASE_URL')?.replace(/\/$/, '');
    if (!setting || !base) return unavailable;
    try {
      const ws = this.map.resolveSync(workspaceId, 'accounting-ops') ?? workspaceId;
      const token =
        this.config.get('ACCOUNTING_OPS_AUTH_MODE') === 'brigade-sts'
          ? await this.brigade.exchangedToken({
              audience: 'accounting-ops-app',
              scope: 'accounting:read',
              workspaceId: ws,
            })
          : this.config.get<string>('ACCOUNTING_OPS_SERVICE_TOKEN');
      if (!token) return unavailable;
      const response = await fetch(`${base}/api/workspaces/${encodeURIComponent(ws)}/entities`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!response.ok) return unavailable;
      const entities: any = await response.json();
      const entity = Array.isArray(entities)
        ? entities.find((e) => e.id === setting.accountingEntityId && e.status === 'active')
        : null;
      if (!entity || typeof entity.legal_name !== 'string' || !entity.legal_name.trim())
        return unavailable;
      // The current entity read exposes legal_name, but not registered address/tax id.
      // Do not synthesize or cache missing legal facts (A34).
      return {
        linked: true,
        letterhead: {
          legal_name: entity.legal_name,
          address_lines: [],
          email: setting.quoteEmail,
          website: setting.website,
        },
        degradations: ['registered_address_unavailable', 'tax_id_unavailable'],
      };
    } catch {
      return unavailable;
    }
  }
  async forSend(workspaceId: string, contactId: string): Promise<QuotePresentation> {
    const vendor = await this.letterhead(workspaceId);
    if (!vendor.linked || vendor.degradations.includes('vendor_details_unavailable'))
      throw new ServiceUnavailableException(
        'Link an available Accounting-Ops entity before sending',
      );
    const contact = await this.contacts.getContact({ workspaceId, ucUid: null }, contactId);
    if (!contact) throw new ServiceUnavailableException('Customer contact unavailable');
    return {
      customer: {
        display_name: contact.displayName,
        org_name: contact.currentOrgName,
        attention: null,
      },
      // Legal facts are resolved at render, never copied to our snapshot (A34).
      letterhead: { legal_name: '', address_lines: [] },
    };
  }
}

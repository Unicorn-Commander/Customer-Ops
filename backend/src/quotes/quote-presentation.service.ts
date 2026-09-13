import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { QuotePresentation } from './quote-snapshot';

@Injectable()
export class QuotePresentationService {
  constructor(
    private readonly db: PrismaService,
    private readonly accounting: AccountingOpsPort,
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
    if (!setting) return unavailable;
    try {
      const entity = await this.accounting.getEntity(workspaceId, setting.accountingEntityId);
      if (!entity) return unavailable;
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

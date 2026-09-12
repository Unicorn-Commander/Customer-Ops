/**
 * The Brand-Ops federation PORT (the look of a quote).
 *
 * Abstract class used as a DI token + interface, the same seam shape as
 * ContactOpsPort / AccountingOpsPort. The renderer depends only on this port;
 * tests provide a fake. DEGRADE-CLEAN: when BRAND_OPS_BASE_URL is unset or the
 * call fails, `getBrandTokens` resolves to null and the caller renders the
 * considered default theme — a quote never fails to render because Brand-Ops
 * is away.
 */

import { SeamHealth } from '../health/seam-health';
import { BrandTokens } from './brand-ops.types';

export abstract class BrandOpsPort {
  /** Side-effect-free probe of the transport + auth (MCP `tools/list`). Never throws. */
  abstract ping(): Promise<SeamHealth>;

  /** Is a Brand-Ops target configured at all (BRAND_OPS_BASE_URL set)? */
  abstract isConfigured(): boolean;

  /** `get_brand_tokens(slug)` → tokens, or null when unconfigured / unknown / failed. */
  abstract getBrandTokens(slug: string): Promise<BrandTokens | null>;

  /** `list_brands()` → slugs; [] when unconfigured / failed. */
  abstract listBrands(): Promise<string[]>;
}

import { Module } from '@nestjs/common';
import { BrandOpsPort } from './brand-ops.port';
import { BrandOpsClient } from './brand-ops.client';

/**
 * The Brand-Ops federation seam (the look of a quote). Binds the abstract
 * `BrandOpsPort` to the MCP client; the quotes renderer injects the port and
 * resolves tokens → CSS variables through `brand-tokens.ts`. Tests override the
 * provider with a fake. The ONLY place a real Brand-Ops transport is built.
 */
@Module({
  providers: [{ provide: BrandOpsPort, useClass: BrandOpsClient }],
  exports: [BrandOpsPort],
})
export class BrandOpsModule {}

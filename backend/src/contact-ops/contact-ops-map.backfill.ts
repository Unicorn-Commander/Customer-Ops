/**
 * Management command: write the contact-ops map for EXISTING workspaces from
 * Contact-Ops' org lookup (C4; the backfill itself is Kit's, DESK-189).
 *
 *   node dist/contact-ops/contact-ops-map.backfill.js            # dry run
 *   node dist/contact-ops/contact-ops-map.backfill.js --apply    # write rows
 *
 * Dry run (the default) prints the org id -> tenant id pairs the lookup answers
 * and writes nothing. `--apply` writes each missing row by the provisioning rule
 * (ContactOpsMapProvisioner): only the lookup's tenant for THAT org id, never
 * over an existing row. Safe to run again. Not an HTTP route.
 *
 * Both modes also re-check every EXISTING contact-ops row against the lookup
 * and print it as confirmed / CONFLICT / UNCONFIRMED (GATE-212); nothing is
 * changed. Exit 0 when every existing row is confirmed, 2 when any is not,
 * 1 when the lookup is dormant.
 *
 * Booting the command writes nothing: the federation map's boot seed and
 * refresh timer are off in this context (R3-3).
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import {
  FEDERATION_MAP_OPTIONS,
  FederationMapOptions,
  FederationWorkspaceMapService,
} from '../common/federation/federation-workspace-map.service';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import {
  ContactOpsMapBackfillReport,
  ContactOpsMapProvisioner,
} from './contact-ops-map.provisioner';

export function parseBackfillArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else throw new Error(`Unknown argument ${arg}; the only flag is --apply`);
  }
  return { apply };
}

export function formatBackfill(report: ContactOpsMapBackfillReport): string {
  if (report.dormant) {
    return (
      'Contact-Ops org lookup is DORMANT (CONTACT_OPS_BASE_URL / CONTACT_OPS_LOOKUP_CLIENT_ID / ' +
      'CONTACT_OPS_LOOKUP_CLIENT_SECRET / CONTACT_OPS_LOOKUP_TOKEN_URL not all set); nothing asked, nothing written.'
    );
  }
  const lines = [
    report.apply ? 'APPLY: writing missing contact-ops map rows' : 'DRY RUN: nothing is written',
  ];
  for (const p of report.pairs) lines.push(`${p.orgId} -> ${p.tenantId}`);
  for (const s of report.skipped) lines.push(`${s.orgId} skipped: ${s.reason}`);
  lines.push(
    `${report.pairs.length} pair(s), ${report.skipped.length} skipped, ${report.written} written`,
  );
  lines.push('', 'EXISTING ROWS (re-checked against the lookup; none changed):');
  const counts = { confirmed: 0, conflict: 0, unconfirmed: 0 };
  for (const e of report.existing) {
    counts[e.status] += 1;
    const head = `${e.orgId} -> ${e.rowTenantId}`;
    if (e.status === 'confirmed') lines.push(`${head}: confirmed`);
    else if (e.status === 'conflict') {
      lines.push(`${head}: CONFLICT (lookup answers ${e.lookupTenantId})`);
    } else lines.push(`${head}: UNCONFIRMED (${e.reason})`);
  }
  lines.push(
    `${counts.confirmed} confirmed, ${counts.conflict} conflict, ${counts.unconfirmed} unconfirmed` +
      (counts.conflict + counts.unconfirmed > 0 ? ' - a person must re-verify these rows' : ''),
  );
  return lines.join('\n');
}

/**
 * 1 dormant; 2 when any existing row is conflict or unconfirmed — including a
 * row another writer installed during --apply (R3-6); else 0.
 */
export function backfillExitCode(report: ContactOpsMapBackfillReport): number {
  if (report.dormant) return 1;
  return report.existing.every((e) => e.status === 'confirmed') ? 0 : 2;
}

/**
 * The command's own wiring: NOT ContactOpsMapModule, whose global
 * FederationWorkspaceMapModule runs the FEDERATION_WORKSPACE_MAP_SEED upserts
 * at boot. Here the map service is built with its boot lifecycle off, so
 * nothing is written before (or unless) `--apply` is given (R3-3).
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  providers: [
    { provide: FEDERATION_MAP_OPTIONS, useValue: { bootLifecycle: false } as FederationMapOptions },
    FederationWorkspaceMapService,
    ContactOpsOrgLookupClient,
    ContactOpsMapProvisioner,
  ],
})
export class ContactOpsMapBackfillModule {}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(ContactOpsMapBackfillModule, {
    logger: ['error', 'warn'],
  });
  try {
    const report = await app.get(ContactOpsMapProvisioner).backfill(args);
    console.log(formatBackfill(report));
    process.exitCode = backfillExitCode(report);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

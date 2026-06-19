/**
 * The funnel `Stage` the graph DTOs carry.
 *
 * The frontend cockpit's `Stage` (frontend/lib/customers.ts) is the string union
 * `'LEAD' | 'PROSPECT' | 'CUSTOMER'`. The backend can't import across the
 * frontend project boundary, so we DERIVE the same union from Prisma's
 * `RelationshipStage` enum — the DB schema's source of truth. They are identical
 * today (schema.prisma: LEAD/PROSPECT/CUSTOMER); deriving from Prisma means a
 * schema change surfaces here as a type error instead of a silent contract drift
 * with the frontend.
 */

import { RelationshipStage } from '@prisma/client';

/** `'LEAD' | 'PROSPECT' | 'CUSTOMER'` — matches the frontend `Stage`. */
export type Stage = `${RelationshipStage}`;

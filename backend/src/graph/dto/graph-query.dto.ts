/**
 * Query DTOs for the knowledge-graph read surface (the neighborhood expand).
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted), so
 * an unexpected query param is rejected. `depth`/`limit` are coerced from their
 * string query-string form to integers (class-transformer `@Type(Number)`) and
 * then range-clamped by class-validator. Both carry sane defaults applied in the
 * service when omitted — these bounds are the SAFETY CEILING (a hostile/huge
 * value is rejected with 400), not the default.
 *
 * Why these ceilings: the neighborhood expand runs a variable-length MATCH on a
 * per-workspace graph; depth>3 and limit>200 are pathological for a cockpit
 * expand (huge fan-out, slow query) and have no legitimate UI use, so we fence
 * them at the edge rather than letting them reach Cypher.
 */

import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Defaults applied by the service when the param is omitted (NOT the ceiling). */
export const NEIGHBORHOOD_DEFAULT_DEPTH = 1;
export const NEIGHBORHOOD_MAX_DEPTH = 3;
export const NEIGHBORHOOD_DEFAULT_LIMIT = 50;
export const NEIGHBORHOOD_MAX_LIMIT = 200;

/**
 * `GET …/graph/nodes/:nodeKey/neighborhood?depth=&limit=` — expand the
 * 1..`depth` neighborhood of a node, capped at `limit` nodes.
 */
export class NeighborhoodQueryDto {
  /**
   * Hops to traverse out from the focused node (1..3). Omitted → the service
   * uses NEIGHBORHOOD_DEFAULT_DEPTH (1, immediate neighbors).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NEIGHBORHOOD_MAX_DEPTH)
  depth?: number;

  /**
   * Max nodes to return (1..200). Omitted → the service uses
   * NEIGHBORHOOD_DEFAULT_LIMIT (50).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NEIGHBORHOOD_MAX_LIMIT)
  limit?: number;
}

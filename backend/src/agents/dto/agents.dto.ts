/**
 * Request DTOs for the Customer-Ops relationship AGENT cockpit actions (Phase 5).
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted). The
 * agents are DRAFT-ONLY: these DTOs never carry a "send" toggle. The follow-up
 * drafter's `stageDraft` opts into staging into the Email-Ops AGENT INBOX
 * (mode='draft', a human approves) — it is NOT a send.
 *
 * Every agent action accepts an OPTIONAL `tier` ('bundled' | 'metered') — the
 * SELECTABLE inference-lane override (request beats the per-agent env default
 * beats 'bundled'; see agent-tier.util.ts). It is a hint only; the entitlement
 * gate still downgrades a metered ask to bundled when `ai-metered` is absent.
 * The bodyless actions (triage / collections-nudge / next-best-action /
 * meeting-prep) take the shared `AgentTierDto` so they too can carry `tier`
 * (also acceptable via the `?tier=` query); a missing body is fine (all fields
 * optional). An invalid value passes validation but is ignored by the resolver.
 */

import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { InferenceTier } from '../inference/agent-inference.types';

/** The shared, all-optional body for an agent action — carries only the
 *  SELECTABLE inference-lane override. The bodyless agents bind this. */
export class AgentTierDto {
  /** Override the inference lane for THIS call: 'bundled' (lanes 1-2, in seat
   *  price) or 'metered' (lanes 3-4, frontier; needs ai-metered). Beats the
   *  per-agent env default. Omitted → fall through to the env / 'bundled'. */
  @IsOptional()
  @IsIn(['bundled', 'metered'])
  tier?: InferenceTier;
}

/** Draft a follow-up email for a customer (draft only; optional agent-inbox stage). */
export class DraftFollowUpDto extends AgentTierDto {
  /** The operator's intent/angle (e.g. "nudge for the signed SOW"). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goal?: string;

  /** When true, ALSO stage the draft into the Email-Ops agent inbox for approval
   *  (mode='draft' — NEVER a send). Default false: return the draft to the caller. */
  @IsOptional()
  @IsBoolean()
  stageDraft?: boolean;

  /** Idempotency key for the optional Email-Ops draft staging. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

/** Run the collections nudge (draft only; optional agent-inbox stage). Mirrors
 *  DraftFollowUpDto so both draft-only agents expose the same staging contract. */
export class DraftCollectionsNudgeDto extends AgentTierDto {
  /** When true, ALSO stage the draft into the Email-Ops agent inbox for approval
   *  (mode='draft' — NEVER a send). Default false: return the draft to the caller. */
  @IsOptional()
  @IsBoolean()
  stageDraft?: boolean;

  /** Idempotency key for the optional Email-Ops draft staging. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

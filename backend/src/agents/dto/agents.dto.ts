/**
 * Request DTOs for the Customer-Ops relationship AGENT cockpit actions (Phase 5).
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted). The
 * agents are DRAFT-ONLY: these DTOs never carry a "send" toggle. The follow-up
 * drafter's `stageDraft` opts into staging into the Email-Ops AGENT INBOX
 * (mode='draft', a human approves) — it is NOT a send.
 *
 * triage + collections-nudge take NO request body (the agents read federated
 * signal), so they have no DTO — like the bodyless `reopen` cockpit action.
 */

import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Draft a follow-up email for a customer (draft only; optional agent-inbox stage). */
export class DraftFollowUpDto {
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

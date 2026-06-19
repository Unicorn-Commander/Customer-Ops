/**
 * Request DTOs for the Relations Officer chat orchestrator.
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted), so an
 * unknown field is a 400 and these are the only accepted shapes. The chat history
 * accepts ONLY 'user' / 'assistant' turns — the system turn (persona + grounding)
 * is assembled server-side and is never client-supplied. The mode is constrained
 * to advisor | operator; the action a write proposal carries is decided by the
 * MODEL (not the client) and validated in the service, so no action shape is
 * accepted here.
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { RelationsOfficerMode } from '../relations-officer.types';

/** One client-supplied conversation turn. Only 'user' / 'assistant' roles are
 *  accepted — the system message is server-assembled. */
export class RelationsOfficerMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  content!: string;
}

/** POST /chat — the conversation so far + the mode + the (optional) grounded
 *  customer. */
export class RelationsOfficerChatDto {
  /** The conversation history (user/assistant turns). Capped to keep the prompt
   *  bounded; the service also condenses the grounding context small. */
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RelationsOfficerMessageDto)
  messages!: RelationsOfficerMessageDto[];

  /** advisor = read + recommend only (never proposes a write); operator = MAY
   *  propose exactly one confirm-gated relationship write. */
  @IsIn(['advisor', 'operator'])
  mode!: RelationsOfficerMode;

  /** The relationship to ground on (a condensed customer-360). When absent the
   *  officer grounds on a pipeline summary and cannot propose a write (operator
   *  mode requires a customerId to act). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerId?: string | null;
}

/** POST /confirm-action — confirm or cancel a single-use pending write. */
export class RelationsOfficerConfirmDto {
  @IsString()
  @MaxLength(64)
  actionId!: string;

  @IsIn(['confirm', 'cancel'])
  decision!: 'confirm' | 'cancel';
}

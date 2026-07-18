import { IsBoolean } from 'class-validator';

/**
 * Toggle the workspace-scoped, runtime agent/outbound kill switch (owner-gated).
 * `paused: true` halts agent runs + outbound sends for the workspace at dispatch
 * (takes effect immediately, no restart); `false` resumes them.
 */
export class SetAgentPauseDto {
  @IsBoolean()
  paused!: boolean;
}

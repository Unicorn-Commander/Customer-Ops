import { Module } from '@nestjs/common';
import { ConversationsOpsPort } from './conversations-ops.port';
import { ConversationsOpsClient } from './conversations-ops.client';

/**
 * The Conversations-Ops federation seam — the omni-channel conversation surface's
 * first channel: the worker's device (iMessage + SMS) via the UUDA/UUDC
 * `messages.*` MCP tools.
 *
 * Binds the abstract `ConversationsOpsPort` (what the relationship layer depends
 * on) to the concrete `ConversationsOpsClient` (JSON-RPC MCP to the device agent's
 * messages.list / messages.send). Consumers inject `ConversationsOpsPort`; tests
 * override that provider with a fake — the device bridge is never required to be
 * running (it's the next track). This is the ONLY place a real device transport is
 * constructed; swapping to a control-plane MCP gateway or the Email-Ops Comms
 * engine later is a provider change here, invisible to every consumer — exactly
 * like EmailOpsModule. The device remains the conversation system-of-record; this
 * seam never stores a message body or copies a thread.
 */
@Module({
  providers: [{ provide: ConversationsOpsPort, useClass: ConversationsOpsClient }],
  exports: [ConversationsOpsPort],
})
export class ConversationsOpsModule {}

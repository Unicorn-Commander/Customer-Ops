import { Module } from '@nestjs/common';
import { AgentInferencePort } from './agent-inference.port';
import { AgentInferenceClient } from './agent-inference.client';

/**
 * The Agent-Inference seam (Phase 5) — the 4-lane inference port.
 *
 * Binds the abstract `AgentInferencePort` (what the relationship agents depend on)
 * to the concrete `AgentInferenceClient` (the OpenAI-compatible control-plane
 * gateway: ops-center uchub-litellm routing + metering). Agents inject
 * `AgentInferencePort`; tests override that provider with a fake — the gateway is
 * never required to be running.
 *
 * This is the ONLY place a real inference transport is constructed. Swapping to a
 * Brigade-brokered agent transport later is a provider change here, invisible to
 * every agent. Customer-Ops never runs a model, routes, or meters — the gateway
 * owns the lane → model mapping + the meter (SUITE-ARCHITECTURE-MAP §1 + §8).
 */
@Module({
  providers: [{ provide: AgentInferencePort, useClass: AgentInferenceClient }],
  exports: [AgentInferencePort],
})
export class AgentInferenceModule {}

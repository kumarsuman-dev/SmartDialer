/**
 * Progressive Pacing Engine
 *
 * Core Principle:
 *   1 available agent -> 1 outbound call.
 *   Predictable and deterministic. Agents sit idle if calls fail to connect,
 *   but there is ZERO probability of an abandoned call due to agent shortage.
 *
 * Rule:
 *   targetCalls = max(0, availableAgents - activeRingingCalls)
 */

import { PacingEngine, PacingDecision } from './pacingEngine';
import { Store } from '../storage/store';
import { AgentState } from '../domain/agent';

export class ProgressivePacing implements PacingEngine {
  readonly mode = 'PROGRESSIVE' as const;
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  calculatePacing(campaignId?: string): PacingDecision {
    const metrics = this.store.getMetrics();
    const availableAgents = metrics.availableAgents;
    const activeRinging = this.store.getRingingCallCount();

    // 1:1 ratio minus in-flight ringing calls
    const targetCalls = Math.max(0, availableAgents - activeRinging);

    const reasoning =
      `Progressive Rule (1:1): ${availableAgents} available agents detected. ` +
      `${activeRinging} calls currently in-flight (ringing/initiated). ` +
      `Recommended new calls = max(0, ${availableAgents} - ${activeRinging}) = ${targetCalls}.`;

    return {
      mode: 'PROGRESSIVE',
      targetCalls,
      reasoning,
      factors: {
        availableAgents,
        wrapUpAgents: metrics.wrapUpAgents,
        activeRingingCalls: activeRinging,
        activeConnectedCalls: metrics.connectedCalls,
        estimatedAnswerRate: 1.0, // Progressive dials deterministically regardless of answer rate
        avgTalkTimeSeconds: 0,
        avgRingingTimeSeconds: 0,
      },
    };
  }
}

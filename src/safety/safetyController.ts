/**
 * Safety Controller — The Non-Bypassable Compliance & Risk Guardian
 *
 * Architecture Position:
 *   Campaign > Pacing Engine > SAFETY CONTROLLER > Call Allocator > Telecom Provider
 *
 * In collections, an abandoned connected call (where borrower answers but no agent is available)
 * is a serious regulatory violation (e.g., FTC / TCPA compliance limits abandonment to < 3%).
 *
 * The Safety Controller evaluates any call quota requested by the Pacing Engine and can:
 * 1. APPROVE: Request is safe and within operational envelopes.
 * 2. REDUCE: Trim down the number of calls to prevent overdial risk.
 * 3. REJECT: Deny dialing completely (e.g. circuit breaker tripped, 0 available capacity).
 * 4. FALLBACK_TO_PROGRESSIVE: Force safe 1:1 progressive mode if predictive metrics indicate volatility.
 *
 * GUARANTEE:
 * The predictive algorithm CANNOT turn off or bypass this controller.
 * All outbound dialing requests must pass through `evaluate()`.
 */

import { Store } from '../storage/store';
import { TelecomProvider, ProviderHealth } from '../provider/telecomProvider';

export enum SafetyAction {
  APPROVE = 'APPROVE',
  REDUCE = 'REDUCE',
  REJECT = 'REJECT',
  FALLBACK_TO_PROGRESSIVE = 'FALLBACK_TO_PROGRESSIVE',
}

export interface SafetyEvaluationResult {
  action: SafetyAction;
  approvedCalls: number;
  requestedCalls: number;
  reason: string;
  telemetry: {
    availableAgents: number;
    wrapUpAgents: number;
    activeRingingCalls: number;
    abandonmentRate: number;
    providerFailureRate: number;
    circuitBreakerOpen: boolean;
  };
}

export interface SafetyConfig {
  /** Maximum allowable compliance abandonment rate (default 0.03 = 3%) */
  maxAbandonmentRate: number;
  /** Maximum allowable provider failure rate before dial freeze (default 0.20 = 20%) */
  maxProviderFailureRate: number;
  /** Maximum allowable ratio of in-flight ringing calls to available agents (default 1.5) */
  maxRingingOverhangRatio: number;
  /** Hard cap on multiplier for predictive dialing (default 3.0x available agents) */
  maxDialMultiplier: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxAbandonmentRate: 0.03, // 3% FTC regulatory standard
  maxProviderFailureRate: 0.20,
  maxRingingOverhangRatio: 1.5,
  maxDialMultiplier: 2.5,
};

export class SafetyController {
  private config: SafetyConfig;
  private store: Store;
  private provider: TelecomProvider;

  constructor(store: Store, provider: TelecomProvider, config: Partial<SafetyConfig> = {}) {
    this.store = store;
    this.provider = provider;
    this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
  }

  /**
   * Evaluates a requested call batch from the pacing engine.
   *
   * @param requestedCalls Number of calls the pacing engine proposes to start
   * @param isPredictive Whether the request came from the predictive pacing engine
   * @param estimatedAnswerRate Optional estimated borrower answer rate for dynamic multiplier scaling
   */
  evaluate(
    requestedCalls: number,
    isPredictive: boolean,
    estimatedAnswerRate?: number
  ): SafetyEvaluationResult {
    const metrics = this.store.getMetrics();
    const providerHealth = this.provider.getHealth();
    const abandonmentRate = this.store.getAbandonmentRate();
    const activeRinging = this.store.getRingingCallCount();

    const telemetry = {
      availableAgents: metrics.availableAgents,
      wrapUpAgents: metrics.wrapUpAgents,
      activeRingingCalls: activeRinging,
      abandonmentRate,
      providerFailureRate: providerHealth.failureRate,
      circuitBreakerOpen: providerHealth.circuitBreakerOpen,
    };

    // 1. HARD BLOCK: Zero available or freeing agents
    if (metrics.availableAgents === 0 && metrics.wrapUpAgents === 0) {
      return {
        action: SafetyAction.REJECT,
        approvedCalls: 0,
        requestedCalls,
        reason: 'Zero agent capacity available (0 available, 0 in wrap-up)',
        telemetry,
      };
    }

    // 2. HARD BLOCK: Provider Circuit Breaker or Catastrophic Provider Failure
    if (providerHealth.circuitBreakerOpen || providerHealth.failureRate > this.config.maxProviderFailureRate) {
      return {
        action: SafetyAction.REJECT,
        approvedCalls: 0,
        requestedCalls,
        reason: `Provider degraded/failing (Failure rate: ${(providerHealth.failureRate * 100).toFixed(1)}%, Circuit Breaker: ${providerHealth.circuitBreakerOpen})`,
        telemetry,
      };
    }

    // 3. COMPLIANCE ENFORCEMENT: Abandonment Rate Breach
    // Proactive Fallback Threshold: If abandonment reaches 2.5% (approaching statutory 3.0%),
    // immediately force fallback to Progressive to prevent compliance breach!
    const hardFallbackThreshold = Math.min(0.025, this.config.maxAbandonmentRate * 0.85);
    if (abandonmentRate >= hardFallbackThreshold) {
      const progressiveCap = Math.max(0, metrics.availableAgents - activeRinging);
      return {
        action: SafetyAction.FALLBACK_TO_PROGRESSIVE,
        approvedCalls: Math.min(requestedCalls, progressiveCap),
        requestedCalls,
        reason: `Abandonment rate ${(abandonmentRate * 100).toFixed(2)}% approached regulatory limit of ${(this.config.maxAbandonmentRate * 100).toFixed(1)}%. Proactive Fallback to Progressive enforced.`,
        telemetry,
      };
    }

    // 4. RINGING OVERHANG GUARD:
    // If there are already many calls ringing compared to available agents, do not launch new calls.
    const effectiveAgents = metrics.availableAgents + Math.floor(metrics.wrapUpAgents * 0.5);
    const maxAllowedRinging = Math.ceil(effectiveAgents * this.config.maxRingingOverhangRatio);
    const availableRingingSlots = Math.max(0, maxAllowedRinging - activeRinging);

    if (availableRingingSlots === 0) {
      return {
        action: SafetyAction.REJECT,
        approvedCalls: 0,
        requestedCalls,
        reason: `Ringing overhang limit reached (${activeRinging} ringing for ${effectiveAgents} agents; max allowed ${maxAllowedRinging})`,
        telemetry,
      };
    }

    // 5. PROGRESSIVE MODE ENFORCEMENT (If requested by Progressive engine)
    if (!isPredictive) {
      // 1 available agent -> 1 outbound call. Never exceed available agents.
      const maxProgressive = Math.max(0, metrics.availableAgents - activeRinging);
      if (requestedCalls > maxProgressive) {
        return {
          action: maxProgressive > 0 ? SafetyAction.REDUCE : SafetyAction.REJECT,
          approvedCalls: maxProgressive,
          requestedCalls,
          reason: `Progressive rule capped calls to available agents minus active ringing (${metrics.availableAgents} - ${activeRinging} = ${maxProgressive})`,
          telemetry,
        };
      }

      return {
        action: SafetyAction.APPROVE,
        approvedCalls: requestedCalls,
        requestedCalls,
        reason: `Approved progressive request for ${requestedCalls} calls`,
        telemetry,
      };
    }

    // 6. PREDICTIVE CEILING & CLAMP:
    // In high-answer regimes (>= 60%), binomial variance can cause sudden answer spikes.
    // Dynamically clamp the dial multiplier to 1.15x for high answer rates,
    // and if early abandonment (>= 1.5%) is detected, proactively clamp to 1.0x.
    let effectiveMultiplier = this.config.maxDialMultiplier;
    if (estimatedAnswerRate !== undefined && estimatedAnswerRate >= 0.60) {
      effectiveMultiplier = Math.min(effectiveMultiplier, 1.15);
    }
    if (abandonmentRate >= 0.015) {
      effectiveMultiplier = Math.min(effectiveMultiplier, 1.0);
    }

    const maxSafePredictiveCalls = Math.min(
      availableRingingSlots,
      Math.ceil(metrics.availableAgents * effectiveMultiplier)
    );

    if (requestedCalls > maxSafePredictiveCalls) {
      return {
        action: maxSafePredictiveCalls > 0 ? SafetyAction.REDUCE : SafetyAction.REJECT,
        approvedCalls: maxSafePredictiveCalls,
        requestedCalls,
        reason: `Predictive request (${requestedCalls}) reduced to safe ceiling (${maxSafePredictiveCalls}) based on available agents (${metrics.availableAgents}, multiplier: ${effectiveMultiplier}x) and ringing buffer (${availableRingingSlots})`,
        telemetry,
      };
    }

    // 7. Request is fully approved
    return {
      action: SafetyAction.APPROVE,
      approvedCalls: requestedCalls,
      requestedCalls,
      reason: `Approved predictive request for ${requestedCalls} calls within safe operational envelope`,
      telemetry,
    };
  }

  getConfig(): SafetyConfig {
    return { ...this.config };
  }
}

/**
 * Predictive Pacing Engine
 *
 * Mathematical Foundation:
 *   Let:
 *     A_avail = Number of immediately available agents
 *     A_wrap  = Number of agents currently in wrap-up (expected free in < 10s)
 *     C_conn  = Currently connected calls with Average Handle Time (AHT)
 *     T_ring  = Average call setup / ringing time (e.g. 15s)
 *     p_ans   = Estimated borrower answer rate (0.0 to 1.0)
 *
 *   1. Departure Rate (Little's Law / Poisson service completion):
 *      Agents completing calls during the ringing window:
 *        E_departures = min(C_conn, (C_conn / AHT) * T_ring)
 *
 *   2. Total Expected Agent Capacity at Connect Window:
 *        A_expected = A_avail + A_wrap + E_departures
 *
 *   3. Calls Required to Fill Expected Capacity:
 *        Calls_needed = A_expected / p_ans
 *
 *   4. Calls to Initiate (accounting for already in-flight ringing calls):
 *        Target_calls = max(0, round(Calls_needed - Active_ringing))
 *
 *   5. Provider Health Discount:
 *        Adjusted by (1 - provider_failure_rate)
 *
 * Transparency:
 *   Every single decision produces an explicit mathematical explanation string
 *   answering: "Why did the system decide to make this many calls right now?"
 */

import { PacingEngine, PacingDecision } from './pacingEngine';
import { Store } from '../storage/store';
import { TelecomProvider } from '../provider/telecomProvider';

export interface PredictiveConfig {
  /** Initial prior for answer rate (0.0 - 1.0) */
  initialAnswerRate: number;
  /** Average talk time / handle time in seconds */
  avgTalkTimeSeconds: number;
  /** Average ringing setup time in seconds */
  avgRingingTimeSeconds: number;
  /** Smoothing factor for updating empirical answer rate (alpha) */
  smoothingAlpha: number;
}

export class PredictivePacing implements PacingEngine {
  readonly mode = 'PREDICTIVE' as const;
  private store: Store;
  private provider: TelecomProvider;
  private config: PredictiveConfig;

  // Running adaptive statistics
  private estimatedAnswerRate: number;
  private avgTalkTimeSeconds: number;

  constructor(
    store: Store,
    provider: TelecomProvider,
    config: Partial<PredictiveConfig> = {}
  ) {
    this.store = store;
    this.provider = provider;
    this.config = {
      initialAnswerRate: config.initialAnswerRate ?? 0.5,
      avgTalkTimeSeconds: config.avgTalkTimeSeconds ?? 90,
      avgRingingTimeSeconds: config.avgRingingTimeSeconds ?? 15,
      smoothingAlpha: config.smoothingAlpha ?? 0.15,
    };
    this.estimatedAnswerRate = this.config.initialAnswerRate;
    this.avgTalkTimeSeconds = this.config.avgTalkTimeSeconds;
  }

  /** Update statistical parameters dynamically (e.g., in Scenario D) */
  setParameters(answerRate?: number, talkTimeSeconds?: number): void {
    if (answerRate !== undefined) {
      this.estimatedAnswerRate = Math.max(0.05, Math.min(1.0, answerRate));
    }
    if (talkTimeSeconds !== undefined) {
      this.avgTalkTimeSeconds = Math.max(10, talkTimeSeconds);
    }
  }

  calculatePacing(campaignId?: string): PacingDecision {
    const metrics = this.store.getMetrics();
    const providerHealth = this.provider.getHealth();
    const activeRinging = this.store.getRingingCallCount();

    const A_avail = metrics.availableAgents;
    const A_wrap = metrics.wrapUpAgents;
    const C_conn = metrics.connectedCalls;
    const T_ring = this.config.avgRingingTimeSeconds;
    const AHT = this.avgTalkTimeSeconds;
    const p_ans = Math.max(0.05, this.estimatedAnswerRate); // Avoid division by zero

    // 1. Calculate expected agents becoming free during the ringing setup window
    // (Rate of completion = C_conn / AHT; expected completions in T_ring = (C_conn / AHT) * T_ring)
    const completionRatePerSec = AHT > 0 ? C_conn / AHT : 0;
    const expectedDepartures = Math.min(C_conn, Math.round(completionRatePerSec * T_ring * 10) / 10);

    // 2. Total expected agent capacity when new calls would actually connect
    const A_expected = A_avail + A_wrap + expectedDepartures;

    // 3. Raw calls needed to produce A_expected answered calls
    // In high-answer regimes (>= 60%), apply a 0.90 safety cushion to prevent burst arrival overflow
    const arrivalSafetyFactor = p_ans >= 0.60 ? 0.90 : 1.0;
    const callsNeededRaw = (A_expected / p_ans) * arrivalSafetyFactor;

    // 4. Subtract calls currently in-flight ringing
    const netCallsNeeded = Math.max(0, callsNeededRaw - activeRinging);

    // 5. Apply provider health discount
    const healthDiscount = Math.max(0.1, 1 - providerHealth.failureRate);
    const unconstrainedCalls = Math.round(netCallsNeeded * healthDiscount);

    // Formulate transparent reasoning trace
    const reasoning =
      `Predictive Calculation Trace:\n` +
      `  • Available Agents (A_avail): ${A_avail}\n` +
      `  • Wrap-up Agents (A_wrap): ${A_wrap}\n` +
      `  • Connected Calls (C_conn): ${C_conn} (AHT: ${AHT}s)\n` +
      `  • Ringing Window (T_ring): ${T_ring}s\n` +
      `  • Expected Departures during Ringing: ${expectedDepartures.toFixed(1)} agents\n` +
      `  • Total Expected Ready Capacity: ${A_expected.toFixed(1)} agents\n` +
      `  • Estimated Answer Rate (p_ans): ${(p_ans * 100).toFixed(1)}%\n` +
      `  • Total Outbound Calls Required: (${A_expected.toFixed(1)} / ${p_ans.toFixed(2)}) = ${callsNeededRaw.toFixed(1)}\n` +
      `  • Active In-Flight Ringing: ${activeRinging}\n` +
      `  • Provider Health Factor: ${(healthDiscount * 100).toFixed(0)}% (Failures: ${(providerHealth.failureRate * 100).toFixed(1)}%)\n` +
      `  • Proposed Calls to Initiate: round((${callsNeededRaw.toFixed(1)} - ${activeRinging}) * ${healthDiscount.toFixed(2)}) = ${unconstrainedCalls}`;

    return {
      mode: 'PREDICTIVE',
      targetCalls: unconstrainedCalls,
      reasoning,
      factors: {
        availableAgents: A_avail,
        wrapUpAgents: A_wrap,
        expectedFreeAgentsInRingWindow: expectedDepartures,
        activeRingingCalls: activeRinging,
        activeConnectedCalls: C_conn,
        estimatedAnswerRate: p_ans,
        avgTalkTimeSeconds: AHT,
        avgRingingTimeSeconds: T_ring,
        providerHealthFactor: healthDiscount,
        unconstrainedCalculatedCalls: unconstrainedCalls,
      },
    };
  }
}

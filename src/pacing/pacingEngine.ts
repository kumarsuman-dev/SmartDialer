/**
 * Pacing Engine Interface and Shared Types
 */

export interface PacingDecision {
  /** Mode of the pacing engine */
  mode: 'PROGRESSIVE' | 'PREDICTIVE';
  /** Proposed number of calls to initiate */
  targetCalls: number;
  /** Detailed mathematical and statistical reasoning for the decision */
  reasoning: string;
  /** Numerical factors used in calculation */
  factors: {
    availableAgents: number;
    wrapUpAgents: number;
    expectedFreeAgentsInRingWindow?: number;
    activeRingingCalls: number;
    activeConnectedCalls: number;
    estimatedAnswerRate: number;
    avgTalkTimeSeconds: number;
    avgRingingTimeSeconds: number;
    providerHealthFactor?: number;
    unconstrainedCalculatedCalls?: number;
  };
}

export interface PacingEngine {
  readonly mode: 'PROGRESSIVE' | 'PREDICTIVE';
  /**
   * Evaluates the current system state and recommends how many calls to start.
   */
  calculatePacing(campaignId?: string): PacingDecision;
}

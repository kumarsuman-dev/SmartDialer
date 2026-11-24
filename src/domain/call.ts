/**
 * Call domain model for the SmartDialer system.
 * Represents an outbound call placed to a borrower.
 */

/** All possible states in the call lifecycle */
export enum CallState {
  QUEUED = 'QUEUED',
  RESERVED = 'RESERVED',
  INITIATED = 'INITIATED',
  RINGING = 'RINGING',
  ANSWERED = 'ANSWERED',
  CONNECTED = 'CONNECTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/** Call entity */
export interface Call {
  readonly id: string;
  borrowerId: string;
  agentId: string | null;
  providerId: string;
  campaignId: string;
  state: CallState;
  providerCallId: string | null;
  startTime: number;
  connectTime: number | null;
  endTime: number | null;
  failureReason: string | null;
  /** Optimistic concurrency version counter */
  version: number;
  /**
   * Monotonic event sequence counter.
   * Each telecom event carries a sequence number; we only accept events
   * whose sequence is strictly greater than lastEventSequence.
   * This prevents out-of-order and duplicate event processing.
   */
  lastEventSequence: number;
}

/** Create a new call in QUEUED state */
export function createCall(
  id: string,
  borrowerId: string,
  campaignId: string,
  providerId: string
): Call {
  return {
    id,
    borrowerId,
    agentId: null,
    providerId,
    campaignId,
    state: CallState.QUEUED,
    providerCallId: null,
    startTime: Date.now(),
    connectTime: null,
    endTime: null,
    failureReason: null,
    version: 0,
    lastEventSequence: 0,
  };
}

/**
 * Telecom Provider Interface — abstraction layer between the dialer and telecom APIs.
 *
 * Design Decision: The dialer communicates with telecom providers exclusively
 * through this interface. It knows nothing about provider-specific behavior
 * (latency, reliability, event ordering). This decoupling means:
 * - Swapping providers requires zero dialer code changes
 * - Provider-specific quirks (duplicates, out-of-order events) are
 *   handled uniformly by the call state machine
 * - Testing is trivial with mock providers
 */

/** Events that a telecom provider can emit */
export enum TelecomEventType {
  RINGING = 'RINGING',
  ANSWERED = 'ANSWERED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  BUSY = 'BUSY',
  NO_ANSWER = 'NO_ANSWER',
  TIMEOUT = 'TIMEOUT',
}

/** An event from the telecom provider about a call */
export interface TelecomEvent {
  /** Unique event ID for idempotency */
  eventId: string;
  /** The call ID in our system */
  callId: string;
  /** Provider's internal call reference */
  providerCallId: string;
  /** Type of event */
  type: TelecomEventType;
  /** Monotonic sequence number (assigned by the provider) */
  sequence: number;
  /** Timestamp of the event */
  timestamp: number;
  /** Additional data */
  metadata?: Record<string, unknown>;
}

/** Result of placing a call with a provider */
export interface CallPlacementResult {
  success: boolean;
  providerCallId: string | null;
  error?: string;
}

/** Callback type for receiving telecom events */
export type TelecomEventCallback = (event: TelecomEvent) => void;

/** Provider health metrics */
export interface ProviderHealth {
  /** Provider identifier */
  providerId: string;
  /** Number of calls placed in the last window */
  callsInWindow: number;
  /** Number of failures in the last window */
  failuresInWindow: number;
  /** Current failure rate (0-1) */
  failureRate: number;
  /** Average latency in ms for call placement */
  avgLatencyMs: number;
  /** Whether the circuit breaker is currently open (provider down) */
  circuitBreakerOpen: boolean;
}

/**
 * Abstract telecom provider interface.
 * All providers (real and mock) implement this contract.
 */
export interface TelecomProvider {
  /** Unique provider identifier */
  readonly providerId: string;

  /**
   * Place an outbound call.
   * Returns a CallPlacementResult indicating success/failure.
   * Events about call progress will be delivered via the registered callback.
   */
  placeCall(callId: string, phoneNumber: string): Promise<CallPlacementResult>;

  /**
   * Cancel a call that's in progress (ringing but not yet answered).
   */
  cancelCall(providerCallId: string): Promise<boolean>;

  /**
   * Register a callback to receive telecom events.
   */
  onEvent(callback: TelecomEventCallback): void;

  /**
   * Get current provider health metrics.
   */
  getHealth(): ProviderHealth;

  /**
   * Shut down the provider (cancel pending timers, etc.).
   */
  shutdown(): void;
}

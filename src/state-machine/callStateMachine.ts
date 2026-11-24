/**
 * Call State Machine — validates and enforces legal call state transitions.
 *
 * The call lifecycle:
 *   QUEUED → RESERVED → INITIATED → RINGING → ANSWERED → CONNECTED → COMPLETED
 *                                      ↓          ↓          ↓
 *                                    FAILED     FAILED     FAILED
 *
 * Key invariants:
 * 1. Terminal states (COMPLETED, FAILED, CANCELLED) cannot transition further.
 * 2. Each state has a monotonic rank. We reject events that would move
 *    the call to a state with equal or lower rank (stale/out-of-order events).
 * 3. Duplicate events (same event ID) are idempotently dropped.
 */

import { Call, CallState } from '../domain/call';

/** Map of valid state transitions */
const VALID_TRANSITIONS: ReadonlyMap<CallState, ReadonlySet<CallState>> = new Map<CallState, ReadonlySet<CallState>>([
  [CallState.QUEUED,    new Set<CallState>([CallState.RESERVED, CallState.CANCELLED])],
  [CallState.RESERVED,  new Set<CallState>([CallState.INITIATED, CallState.CANCELLED, CallState.FAILED])],
  [CallState.INITIATED, new Set<CallState>([CallState.RINGING, CallState.ANSWERED, CallState.COMPLETED, CallState.FAILED, CallState.CANCELLED])],
  [CallState.RINGING,   new Set<CallState>([CallState.ANSWERED, CallState.COMPLETED, CallState.FAILED, CallState.CANCELLED])],
  [CallState.ANSWERED,  new Set<CallState>([CallState.CONNECTED, CallState.COMPLETED, CallState.FAILED])],
  [CallState.CONNECTED, new Set<CallState>([CallState.COMPLETED, CallState.FAILED])],
  [CallState.COMPLETED, new Set<CallState>()],  // terminal
  [CallState.FAILED,    new Set<CallState>()],  // terminal
  [CallState.CANCELLED, new Set<CallState>()],  // terminal
]);

/**
 * Monotonic rank for call states.
 * Terminal states share the highest rank so out-of-order events
 * arriving after a terminal state are always rejected.
 */
const STATE_RANK: ReadonlyMap<CallState, number> = new Map<CallState, number>([
  [CallState.QUEUED,    0],
  [CallState.RESERVED,  1],
  [CallState.INITIATED, 2],
  [CallState.RINGING,   3],
  [CallState.ANSWERED,  4],
  [CallState.CONNECTED, 5],
  [CallState.COMPLETED, 6],
  [CallState.FAILED,    6],
  [CallState.CANCELLED, 6],
]);

/** Terminal states from which no further transition is possible */
const TERMINAL_STATES: ReadonlySet<CallState> = new Set<CallState>([
  CallState.COMPLETED,
  CallState.FAILED,
  CallState.CANCELLED,
]);

/** Check if a state transition is valid according to the transition map */
export function canTransitionCall(from: CallState, to: CallState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

/** Check if a call state is terminal */
export function isTerminalCallState(state: CallState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Get the monotonic rank of a call state */
export function getCallStateRank(state: CallState): number {
  return STATE_RANK.get(state) ?? 0;
}

/**
 * Result of a transition attempt.
 * - 'applied': transition was valid and applied.
 * - 'stale': event was out-of-order or duplicate; safely ignored.
 * - 'invalid': transition violates state machine rules.
 */
export type TransitionResult =
  | { status: 'applied'; call: Call }
  | { status: 'stale'; reason: string }
  | { status: 'invalid'; reason: string };

/**
 * Attempt to transition a call to a new state.
 *
 * Uses monotonic rank to handle out-of-order and duplicate events:
 * - If the new state has a rank ≤ the current state rank AND the current
 *   state is terminal, the event is stale.
 * - If the new state has a rank ≤ the current state rank AND the current
 *   state is NOT terminal, check the transition map.
 * - eventSequence (if provided) must be strictly greater than lastEventSequence.
 */
export function transitionCall(
  call: Call,
  newState: CallState,
  eventSequence?: number
): TransitionResult {
  // Check event sequence for deduplication
  if (eventSequence !== undefined && eventSequence <= call.lastEventSequence) {
    return {
      status: 'stale',
      reason: `Event sequence ${eventSequence} ≤ last processed ${call.lastEventSequence} for call ${call.id}`,
    };
  }

  // Terminal state: nothing can follow
  if (isTerminalCallState(call.state)) {
    return {
      status: 'stale',
      reason: `Call ${call.id} is in terminal state ${call.state}; ignoring ${newState}`,
    };
  }

  // Same state: idempotent no-op
  if (call.state === newState) {
    return {
      status: 'stale',
      reason: `Call ${call.id} already in state ${newState}; duplicate event ignored`,
    };
  }

  // Out-of-order: new state has lower rank than current
  const currentRank = getCallStateRank(call.state);
  const newRank = getCallStateRank(newState);
  if (newRank < currentRank) {
    return {
      status: 'stale',
      reason: `Out-of-order event: ${newState} (rank ${newRank}) < current ${call.state} (rank ${currentRank}) for call ${call.id}`,
    };
  }

  // Check explicit transition map for forward transitions
  if (!canTransitionCall(call.state, newState)) {
    // Allow "skip" transitions when rank is higher (e.g., INITIATED -> COMPLETED directly)
    // The telecom provider may skip intermediate states
    if (newRank > currentRank) {
      // Forward skip allowed — provider may omit intermediate events
    } else {
      return {
        status: 'invalid',
        reason: `Invalid call state transition: ${call.state} → ${newState} for call ${call.id}`,
      };
    }
  }

  const now = Date.now();
  const updated: Call = {
    ...call,
    state: newState,
    version: call.version + 1,
    lastEventSequence: eventSequence !== undefined ? eventSequence : call.lastEventSequence,
  };

  // Set connect time when call is answered/connected
  if (
    (newState === CallState.ANSWERED || newState === CallState.CONNECTED) &&
    !call.connectTime
  ) {
    updated.connectTime = now;
  }

  // Set end time for terminal states
  if (isTerminalCallState(newState)) {
    updated.endTime = now;
  }

  return { status: 'applied', call: updated };
}

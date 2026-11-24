/**
 * Agent State Machine — validates and enforces legal state transitions.
 *
 * The agent lifecycle:
 *   OFFLINE → AVAILABLE → RESERVED → DIALING → CONNECTED → WRAP_UP → AVAILABLE
 *                 ↕           ↓                                  ↓
 *              PAUSED    AVAILABLE (on failure)              PAUSED / OFFLINE
 *
 * Key invariant: an agent in RESERVED or DIALING state has been allocated
 * to exactly one worker via an atomic compare-and-swap operation.
 */

import { Agent, AgentState } from '../domain/agent';

/** Map of valid state transitions */
const VALID_TRANSITIONS: ReadonlyMap<AgentState, ReadonlySet<AgentState>> = new Map<AgentState, ReadonlySet<AgentState>>([
  [AgentState.OFFLINE,   new Set<AgentState>([AgentState.AVAILABLE])],
  [AgentState.AVAILABLE, new Set<AgentState>([AgentState.RESERVED, AgentState.PAUSED, AgentState.OFFLINE])],
  [AgentState.RESERVED,  new Set<AgentState>([AgentState.DIALING, AgentState.AVAILABLE, AgentState.PAUSED, AgentState.OFFLINE])],
  [AgentState.DIALING,   new Set<AgentState>([AgentState.CONNECTED, AgentState.AVAILABLE, AgentState.WRAP_UP])],
  [AgentState.CONNECTED, new Set<AgentState>([AgentState.WRAP_UP])],
  [AgentState.WRAP_UP,   new Set<AgentState>([AgentState.AVAILABLE, AgentState.PAUSED, AgentState.OFFLINE])],
  [AgentState.PAUSED,    new Set<AgentState>([AgentState.AVAILABLE, AgentState.OFFLINE])],
]);

/**
 * Rank represents how deep the agent is in the call lifecycle.
 * Used for monotonic ordering of states.
 */
const STATE_RANK: ReadonlyMap<AgentState, number> = new Map<AgentState, number>([
  [AgentState.OFFLINE,   0],
  [AgentState.AVAILABLE, 1],
  [AgentState.PAUSED,    1],
  [AgentState.RESERVED,  2],
  [AgentState.DIALING,   3],
  [AgentState.CONNECTED, 4],
  [AgentState.WRAP_UP,   5],
]);

/** Check if a state transition is valid */
export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

/** Get the rank of an agent state (higher = deeper in call lifecycle) */
export function getAgentStateRank(state: AgentState): number {
  return STATE_RANK.get(state) ?? 0;
}

/**
 * Transition an agent to a new state.
 * Returns a new Agent object with the updated state.
 * Throws if the transition is invalid.
 */
export function transitionAgent(
  agent: Agent,
  newState: AgentState,
  workerId?: string
): Agent {
  if (!canTransitionAgent(agent.state, newState)) {
    throw new Error(
      `Invalid agent state transition: ${agent.state} → ${newState} ` +
      `for agent ${agent.id}`
    );
  }

  const updated: Agent = {
    ...agent,
    state: newState,
    version: agent.version + 1,
    lastStateChange: Date.now(),
  };

  // Clear lock when returning to AVAILABLE, OFFLINE, or PAUSED
  if (
    newState === AgentState.AVAILABLE ||
    newState === AgentState.OFFLINE ||
    newState === AgentState.PAUSED
  ) {
    updated.lockedBy = null;
    updated.leaseExpiresAt = null;
  }

  // Set lock when reserving
  if (newState === AgentState.RESERVED && workerId) {
    updated.lockedBy = workerId;
  }

  return updated;
}

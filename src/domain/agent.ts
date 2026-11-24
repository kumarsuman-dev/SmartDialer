/**
 * Agent domain model for the SmartDialer system.
 * Represents a collections agent who handles outbound calls to borrowers.
 */

/** All possible states in the agent lifecycle */
export enum AgentState {
  OFFLINE = 'OFFLINE',
  AVAILABLE = 'AVAILABLE',
  RESERVED = 'RESERVED',
  DIALING = 'DIALING',
  CONNECTED = 'CONNECTED',
  WRAP_UP = 'WRAP_UP',
  PAUSED = 'PAUSED',
}

/** Agent entity */
export interface Agent {
  readonly id: string;
  readonly name: string;
  state: AgentState;
  campaignId: string | null;
  /** Worker ID that currently holds the reservation lock */
  lockedBy: string | null;
  /** Timestamp when the current lease expires (ms since epoch) */
  leaseExpiresAt: number | null;
  /** Optimistic concurrency version counter */
  version: number;
  /** Timestamp of the last state change */
  lastStateChange: number;
}

/** Create a new agent with default values */
export function createAgent(id: string, name: string, campaignId: string | null = null): Agent {
  return {
    id,
    name,
    state: AgentState.OFFLINE,
    campaignId,
    lockedBy: null,
    leaseExpiresAt: null,
    version: 0,
    lastStateChange: Date.now(),
  };
}

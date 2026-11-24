/**
 * Reconciliation Daemon — Crash Recovery and Stale Lease Sweeper
 *
 * Failure Scenario 1 (from PDF):
 *   Agent reserved > Borrower reserved > Call initiated > Worker crashes
 *   What happens when the system comes back?
 *
 * Solution:
 * 1. Distributed Leases: Every agent/borrower reservation carries a lease expiration timestamp.
 * 2. Active Heartbeat / Sweeper: The Reconciler runs periodically (or on startup).
 * 3. Sweeps for expired leases:
 *    - Agents stuck in RESERVED/DIALING past lease expiry -> reset to AVAILABLE.
 *    - Calls stuck in INITIATED/RESERVED past timeout -> marked FAILED with reason 'WORKER_CRASH_TIMEOUT'.
 *    - Borrowers left orphaned in RESERVED/IN_CALL -> returned to PENDING for retry.
 */

import { Store } from '../storage/store';
import { AgentState } from '../domain/agent';
import { CallState } from '../domain/call';
import { BorrowerStatus } from '../domain/borrower';

export interface ReconciliationReport {
  reclaimedAgents: number;
  timedOutCalls: number;
  reclaimedBorrowers: number;
}

export class Reconciler {
  private store: Store;
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Run a single reconciliation sweep.
   *
   * @param callTimeoutMs Max age for calls stuck in INITIATED/RESERVED before being declared crashed
   */
  reconcile(callTimeoutMs: number = 10_000): ReconciliationReport {
    const now = Date.now();
    let reclaimedAgents = 0;
    let timedOutCalls = 0;
    let reclaimedBorrowers = 0;

    // 1. Reclaim stuck agents whose reservation lease expired
    const staleAgents = this.store.getStaleAgents(now);
    for (const agent of staleAgents) {
      this.store.forceResetAgent(agent.id, AgentState.AVAILABLE);
      reclaimedAgents++;
    }

    // 2. Reclaim stuck calls that were initiated by a crashed worker
    const staleCalls = this.store.getStaleCalls(callTimeoutMs);
    for (const call of staleCalls) {
      // Mark call as failed due to worker crash
      this.store.transitionCallState(
        call.id,
        CallState.FAILED,
        undefined,
        undefined,
        'WORKER_CRASH_TIMEOUT'
      );
      timedOutCalls++;

      // Reclaim associated borrower back to PENDING for retry
      const borrower = this.store.getBorrower(call.borrowerId);
      if (borrower && borrower.status === BorrowerStatus.IN_CALL) {
        if (borrower.attemptCount < borrower.maxAttempts) {
          this.store.updateBorrowerStatus(borrower.id, BorrowerStatus.PENDING);
        } else {
          this.store.updateBorrowerStatus(borrower.id, BorrowerStatus.FAILED);
        }
        reclaimedBorrowers++;
      }

      // If call had an agent pre-assigned, free them
      if (call.agentId) {
        const agent = this.store.getAgent(call.agentId);
        if (agent && (agent.state === AgentState.RESERVED || agent.state === AgentState.DIALING)) {
          this.store.forceResetAgent(call.agentId, AgentState.AVAILABLE);
          reclaimedAgents++;
        }
      }
    }

    return {
      reclaimedAgents,
      timedOutCalls,
      reclaimedBorrowers,
    };
  }

  /** Start automatic periodic reconciliation */
  start(intervalMs: number = 2000, callTimeoutMs: number = 10_000): void {
    this.stop();
    this.intervalTimer = setInterval(() => {
      this.reconcile(callTimeoutMs);
    }, intervalMs);
  }

  /** Stop periodic reconciliation */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

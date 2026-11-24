/**
 * Call Allocator — Allocates borrowers, reserves agents, and dispatches calls
 *
 * Pipeline Stage:
 *   Campaign > Pacing Engine > Safety Controller > CALL ALLOCATOR > Telecom Provider
 *
 * Responsibilities:
 * 1. Takes approved call count from Safety Controller.
 * 2. Selects borrowers to call based on priority queue (CAS reservation).
 * 3. In Progressive Mode: Pre-allocates available agent to call before dialing.
 * 4. In Predictive Mode: Initiates call into queue; allocates agent upon ANSWERED webhook.
 * 5. Handles immediate placement failures (telecom error, network dropout).
 */

import { v4 as uuidv4 } from 'uuid';
import { Store } from '../storage/store';
import { TelecomProvider } from '../provider/telecomProvider';
import { createCall, CallState } from '../domain/call';
import { BorrowerStatus } from '../domain/borrower';
import { AgentState } from '../domain/agent';

export interface AllocationResult {
  dispatchedCalls: number;
  skippedBorrowers: number;
  callIds: string[];
}

export class CallAllocator {
  private store: Store;
  private provider: TelecomProvider;

  constructor(store: Store, provider: TelecomProvider) {
    this.store = store;
    this.provider = provider;
  }

  /**
   * Allocate and dispatch up to `approvedCount` calls.
   *
   * @param approvedCount Number of calls approved by Safety Controller
   * @param workerId ID of the worker executing this dispatch
   * @param campaignId Campaign identifier
   * @param isPredictive Whether operating in predictive mode
   */
  async allocateAndDispatch(
    approvedCount: number,
    workerId: string,
    campaignId: string = 'campaign-main',
    isPredictive: boolean = false
  ): Promise<AllocationResult> {
    let dispatched = 0;
    let skipped = 0;
    const callIds: string[] = [];

    for (let i = 0; i < approvedCount; i++) {
      // 1. In Progressive mode: must acquire an available agent first
      let reservedAgentId: string | null = null;
      if (!isPredictive) {
        const agent = this.store.reserveNextAvailableAgent(workerId, campaignId);
        if (!agent) {
          // No more available agents, stop dispatching progressive calls
          break;
        }
        reservedAgentId = agent.id;
      }

      // 2. Atomically reserve borrower
      const borrower = this.store.reserveNextBorrower(workerId, campaignId);
      if (!borrower) {
        // No pending borrowers left
        if (reservedAgentId) {
          // Release agent back to AVAILABLE
          this.store.forceResetAgent(reservedAgentId, AgentState.AVAILABLE);
        }
        skipped++;
        break;
      }

      // 3. Create call record in RESERVED status
      const callId = `call-${uuidv4().slice(0, 8)}`;
      const call = createCall(callId, borrower.id, campaignId, this.provider.providerId);
      call.state = CallState.RESERVED;
      if (reservedAgentId) {
        call.agentId = reservedAgentId;
        // Move agent from RESERVED to DIALING
        this.store.updateAgentState(reservedAgentId, AgentState.DIALING, undefined, workerId);
      }
      this.store.addCall(call);

      // 4. Update borrower to IN_CALL
      this.store.updateBorrowerStatus(borrower.id, BorrowerStatus.IN_CALL, workerId);

      // 5. Transition call to INITIATED
      this.store.transitionCallState(callId, CallState.INITIATED);

      // 6. Dispatch to Telecom Provider
      try {
        const placement = await this.provider.placeCall(callId, borrower.phone);
        if (placement.success) {
          dispatched++;
          callIds.push(callId);
          // Persist the provider-assigned call ID to the Store (and WAL) so it
          // survives crashes and is available for cancellation / reconciliation.
          if (placement.providerCallId) {
            this.store.setProviderCallId(callId, placement.providerCallId);
          }
        } else {
          // Telecom provider rejected or timed out
          this.handleImmediateCallFailure(callId, borrower.id, reservedAgentId, placement.error || 'PROVIDER_REJECTED');
        }
      } catch (err: any) {
        this.handleImmediateCallFailure(callId, borrower.id, reservedAgentId, err.message || 'DISPATCH_EXCEPTION');
      }
    }

    return { dispatchedCalls: dispatched, skippedBorrowers: skipped, callIds };
  }

  private handleImmediateCallFailure(
    callId: string,
    borrowerId: string,
    agentId: string | null,
    reason: string
  ): void {
    // Fail call
    this.store.transitionCallState(callId, CallState.FAILED, undefined, undefined, reason);

    // Release borrower back to PENDING (for retry) or FAILED
    const borrower = this.store.getBorrower(borrowerId);
    if (borrower && borrower.attemptCount < borrower.maxAttempts) {
      this.store.updateBorrowerStatus(borrowerId, BorrowerStatus.PENDING);
    } else {
      this.store.updateBorrowerStatus(borrowerId, BorrowerStatus.FAILED);
    }

    // Release pre-reserved agent back to AVAILABLE
    if (agentId) {
      this.store.forceResetAgent(agentId, AgentState.AVAILABLE);
    }
  }
}

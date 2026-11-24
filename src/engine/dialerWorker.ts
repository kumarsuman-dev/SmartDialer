/**
 * Dialer Worker — Processes Telecom Events and Manages Live Call Connections
 *
 * Designed for distributed multi-worker operation:
 * - Idempotent event processing via eventId deduplication
 * - Monotonic rank validation rejects out-of-order webhook delivery
 * - Concurrency-safe agent matching on ANSWERED event
 * - Resilient to duplicate ANSWERED, out-of-order COMPLETED, and agent disappearances
 */

import { Store } from '../storage/store';
import { TelecomProvider, TelecomEvent, TelecomEventType } from '../provider/telecomProvider';
import { CallState } from '../domain/call';
import { AgentState } from '../domain/agent';
import { BorrowerStatus } from '../domain/borrower';

export class DialerWorker {
  readonly workerId: string;
  private store: Store;
  private provider: TelecomProvider;
  private wrapUpDurationMs: number;

  constructor(
    workerId: string,
    store: Store,
    provider: TelecomProvider,
    wrapUpDurationMs: number = 200 // scaled for fast simulation
  ) {
    this.workerId = workerId;
    this.store = store;
    this.provider = provider;
    this.wrapUpDurationMs = wrapUpDurationMs;
  }

  /**
   * Process an incoming telecom event from the provider.
   * This handles out-of-order, duplicates, and terminal state transitions cleanly.
   */
  handleTelecomEvent(event: TelecomEvent): void {
    const call = this.store.getCall(event.callId);
    if (!call) {
      return; // Unknown call
    }

    switch (event.type) {
      case TelecomEventType.RINGING:
        this.store.transitionCallState(
          event.callId,
          CallState.RINGING,
          event.sequence,
          event.eventId
        );
        break;

      case TelecomEventType.ANSWERED:
        this.handleCallAnswered(event);
        break;

      case TelecomEventType.COMPLETED:
        this.handleCallCompleted(event);
        break;

      case TelecomEventType.FAILED:
      case TelecomEventType.BUSY:
      case TelecomEventType.NO_ANSWER:
      case TelecomEventType.TIMEOUT:
        this.handleCallFailed(event);
        break;
    }
  }

  private handleCallAnswered(event: TelecomEvent): void {
    // 1. Transition call to ANSWERED (with idempotency and sequence guards)
    const result = this.store.transitionCallState(
      event.callId,
      CallState.ANSWERED,
      event.sequence,
      event.eventId
    );

    if (result.status !== 'applied') {
      // Stale or duplicate ANSWERED event, ignore
      return;
    }

    const call = this.store.getCall(event.callId);
    if (!call) return;

    // 2. Check if agent is already bound (Progressive mode pre-reserves agent)
    if (call.agentId) {
      const agent = this.store.getAgent(call.agentId);
      // Check if agent disappeared during setup (e.g. paused or went offline)
      if (!agent || agent.state === AgentState.OFFLINE || agent.state === AgentState.PAUSED) {
        // Agent disappeared during call setup! Re-route or handle abandonment
        this.rerouteOrAbandon(call);
        return;
      }

      // Transition agent and call to CONNECTED
      this.store.updateAgentState(call.agentId, AgentState.CONNECTED, undefined, this.workerId);
      this.store.transitionCallState(call.id, CallState.CONNECTED);
      return;
    }

    // 3. Predictive Mode: Dynamically allocate an agent now that borrower has answered
    let availableAgent = this.store.reserveNextAvailableAgent(this.workerId, call.campaignId);

    if (!availableAgent) {
      // Compliance Overflow Guard: If no agent is strictly AVAILABLE, pre-empt an agent currently in WRAP_UP!
      // In collections, after-call work is immediately paused to bridge a live borrower, preventing compliance abandonment.
      const wrapUpAgents = this.store.getAgentsByState(AgentState.WRAP_UP);
      for (const wAgent of wrapUpAgents) {
        if (!call.campaignId || !wAgent.campaignId || wAgent.campaignId === call.campaignId) {
          const reset = this.store.forceResetAgent(wAgent.id, AgentState.AVAILABLE);
          if (reset) {
            availableAgent = this.store.reserveAgent(wAgent.id, this.workerId);
            if (availableAgent) break;
          }
        }
      }
    }

    if (availableAgent) {
      // Successfully matched with an available or pre-empted wrap-up agent
      this.store.assignAgentToCall(call.id, availableAgent.id);
      this.store.updateAgentState(availableAgent.id, AgentState.CONNECTED, undefined, this.workerId);
      this.store.transitionCallState(call.id, CallState.CONNECTED);
    } else {
      // COMPLIANCE ISSUE: Abandoned connected call (borrower answered, zero agents available)
      this.store.transitionCallState(
        call.id,
        CallState.FAILED,
        undefined,
        undefined,
        'NO_AGENT_AVAILABLE'
      );
      this.store.updateBorrowerStatus(call.borrowerId, BorrowerStatus.FAILED, this.workerId);
    }
  }

  private rerouteOrAbandon(call: any): void {
    // Try to find another agent who is available
    const backupAgent = this.store.reserveNextAvailableAgent(this.workerId, call.campaignId);
    if (backupAgent) {
      this.store.assignAgentToCall(call.id, backupAgent.id);
      this.store.updateAgentState(backupAgent.id, AgentState.CONNECTED, undefined, this.workerId);
      this.store.transitionCallState(call.id, CallState.CONNECTED);
    } else {
      // No replacement agent found: agent disappeared during setup
      this.store.transitionCallState(
        call.id,
        CallState.FAILED,
        undefined,
        undefined,
        'AGENT_DISAPPEARED_DURING_SETUP'
      );
      this.store.updateBorrowerStatus(call.borrowerId, BorrowerStatus.FAILED, this.workerId);
    }
  }

  private handleCallCompleted(event: TelecomEvent): void {
    const result = this.store.transitionCallState(
      event.callId,
      CallState.COMPLETED,
      event.sequence,
      event.eventId
    );

    if (result.status !== 'applied') {
      return;
    }

    const call = this.store.getCall(event.callId);
    if (!call) return;

    // Release borrower as COMPLETED
    this.store.updateBorrowerStatus(call.borrowerId, BorrowerStatus.COMPLETED, this.workerId);

    // If an agent was connected, put them in WRAP_UP, then return to AVAILABLE
    if (call.agentId) {
      const agentId = call.agentId;
      this.store.updateAgentState(agentId, AgentState.WRAP_UP, undefined, this.workerId);

      // After wrap-up duration, free the agent
      setTimeout(() => {
        const agent = this.store.getAgent(agentId);
        if (agent && agent.state === AgentState.WRAP_UP) {
          this.store.updateAgentState(agentId, AgentState.AVAILABLE, undefined, this.workerId);
        }
      }, this.wrapUpDurationMs);
    }
  }

  private handleCallFailed(event: TelecomEvent): void {
    const reason = event.type.toString();
    const result = this.store.transitionCallState(
      event.callId,
      CallState.FAILED,
      event.sequence,
      event.eventId,
      reason
    );

    if (result.status !== 'applied') {
      return;
    }

    const call = this.store.getCall(event.callId);
    if (!call) return;

    // Release pre-reserved agent back to AVAILABLE
    if (call.agentId) {
      const agent = this.store.getAgent(call.agentId);
      if (agent && (agent.state === AgentState.RESERVED || agent.state === AgentState.DIALING)) {
        this.store.forceResetAgent(call.agentId, AgentState.AVAILABLE);
      }
    }

    // Handle borrower retry logic
    const borrower = this.store.getBorrower(call.borrowerId);
    if (borrower && borrower.attemptCount < borrower.maxAttempts) {
      this.store.updateBorrowerStatus(call.borrowerId, BorrowerStatus.PENDING);
    } else {
      this.store.updateBorrowerStatus(call.borrowerId, BorrowerStatus.FAILED);
    }
  }
}

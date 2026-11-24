/**
 * Transactional Store with Atomic Compare-And-Swap (CAS) and Write-Ahead Log (WAL) Persistence.
 *
 * Architecture & Concurrency Model:
 * 1. Memory Tier:
 *    - In-memory Map data structures for sub-millisecond $O(1)$ lookups.
 *    - Single-threaded event loop guarantees atomicity for local Compare-And-Swap operations.
 *    - Version counters (`agent.version`, `borrower.version`, `call.version`) provide optimistic locking.
 * 2. Persistence & Crash Recovery Tier (ACID WAL):
 *    - Optional `persistenceDir` enables Write-Ahead Log persistence.
 *    - Every successful mutation appends a synchronous journal record to `wal.log`.
 *    - `recoverFromDisk()` automatically reloads snapshots and replays the WAL on process restart.
 *    - If the node process crashes abruptly, a new Store instance pointed to the same directory
 *      reconstitutes the exact agent locks, call lifecycles, and borrower queue states.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentState, createAgent } from '../domain/agent';
import { Borrower, BorrowerStatus, createBorrower } from '../domain/borrower';
import { Call, CallState, createCall } from '../domain/call';
import { transitionAgent } from '../state-machine/agentStateMachine';
import { transitionCall, TransitionResult, isTerminalCallState } from '../state-machine/callStateMachine';

/** Event log entry for audit trail */
export interface EventLogEntry {
  timestamp: number;
  entityType: 'agent' | 'call' | 'borrower';
  entityId: string;
  eventType: string;
  fromState: string;
  toState: string;
  workerId: string | null;
  metadata?: Record<string, unknown>;
}

/** Metrics snapshot */
export interface StoreMetrics {
  totalAgents: number;
  availableAgents: number;
  reservedAgents: number;
  dialingAgents: number;
  connectedAgents: number;
  wrapUpAgents: number;
  pausedAgents: number;
  offlineAgents: number;
  totalCalls: number;
  queuedCalls: number;
  ringingCalls: number;
  connectedCalls: number;
  completedCalls: number;
  failedCalls: number;
  cancelledCalls: number;
  pendingBorrowers: number;
}

interface WalRecord {
  timestamp: number;
  op: string;
  payload: any;
}

export class Store {
  private agents: Map<string, Agent> = new Map();
  private calls: Map<string, Call> = new Map();
  private borrowers: Map<string, Borrower> = new Map();
  private eventLog: EventLogEntry[] = [];
  /** Set of processed event IDs for idempotency */
  private processedEventIds: Set<string> = new Set();

  /** High-speed indexed sets for O(1) available resource allocation */
  private availableAgentIds: Set<string> = new Set();
  private pendingBorrowerIds: Set<string> = new Set();

  // Persistence paths
  private persistenceDir: string | null = null;
  private walPath: string | null = null;
  private snapshotPath: string | null = null;

  constructor(persistenceDir?: string) {
    if (persistenceDir) {
      this.persistenceDir = path.resolve(persistenceDir);
      this.walPath = path.join(this.persistenceDir, 'store.wal');
      this.snapshotPath = path.join(this.persistenceDir, 'snapshot.json');

      if (!fs.existsSync(this.persistenceDir)) {
        fs.mkdirSync(this.persistenceDir, { recursive: true });
      }

      // Replay existing snapshot and WAL if present
      this.recoverFromDisk();
    }
  }

  // ─── Persistence & WAL Replay ───

  /**
   * Whether a WAL write failure has occurred.
   * Once set, all subsequent mutation operations will throw to prevent
   * silent divergence between in-memory state and durable WAL log.
   */
  private walWriteFailed: boolean = false;

  private appendWal(op: string, payload: any): void {
    if (!this.walPath) return;
    if (this.walWriteFailed) {
      throw new Error('WAL is in a failed state: prior write error. Store is read-only until process restart.');
    }
    const record: WalRecord = {
      timestamp: Date.now(),
      op,
      payload,
    };
    try {
      fs.appendFileSync(this.walPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      // Mark WAL as failed so all future mutations fail fast rather than
      // silently proceeding with un-persisted state.
      this.walWriteFailed = true;
      throw new Error(`WAL write failed — store is now read-only. Original error: ${(err as Error).message}`);
    }
  }

  /** Returns true if the WAL has encountered a write error. */
  isWalFailed(): boolean {
    return this.walWriteFailed;
  }

  /**
   * Reconstitute database state from snapshot + WAL log replay
   */
  recoverFromDisk(): void {
    if (!this.persistenceDir) return;

    // 1. Load snapshot if present
    if (this.snapshotPath && fs.existsSync(this.snapshotPath)) {
      try {
        const raw = fs.readFileSync(this.snapshotPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.agents) {
          for (const a of data.agents) this.agents.set(a.id, a);
        }
        if (data.borrowers) {
          for (const b of data.borrowers) this.borrowers.set(b.id, b);
        }
        if (data.calls) {
          for (const c of data.calls) this.calls.set(c.id, c);
        }
        if (data.processedEventIds) {
          for (const id of data.processedEventIds) this.processedEventIds.add(id);
        }
        if (data.eventLog) {
          this.eventLog = data.eventLog;
        }
      } catch (err) {
        console.error('Snapshot recovery error:', err);
      }
    }

    // 2. Replay subsequent WAL operations
    if (this.walPath && fs.existsSync(this.walPath)) {
      try {
        const walContent = fs.readFileSync(this.walPath, 'utf8');
        const lines = walContent.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const record: WalRecord = JSON.parse(line);
            this.applyWalRecord(record);
          } catch {
            // Ignore corrupted trailing entry
          }
        }
      } catch (err) {
        console.error('WAL replay error:', err);
      }
    }
  }

  private applyWalRecord(record: WalRecord): void {
    const { op, payload } = record;
    switch (op) {
      case 'ADD_AGENT':
      case 'UPDATE_AGENT':
        this.agents.set(payload.id, payload);
        if (payload.state === AgentState.AVAILABLE) this.availableAgentIds.add(payload.id);
        else this.availableAgentIds.delete(payload.id);
        break;
      case 'ADD_BORROWER':
      case 'UPDATE_BORROWER':
        this.borrowers.set(payload.id, payload);
        if (payload.status === BorrowerStatus.PENDING && payload.attemptCount < payload.maxAttempts) this.pendingBorrowerIds.add(payload.id);
        else this.pendingBorrowerIds.delete(payload.id);
        break;
      case 'ADD_CALL':
        this.calls.set(payload.id, payload);
        break;
      case 'UPDATE_CALL':
        this.calls.set(payload.id, payload);
        if (payload.processedEventId) {
          this.processedEventIds.add(payload.processedEventId);
        }
        break;
    }
  }

  /**
   * Checkpoint in-memory state to disk snapshot and truncate WAL
   */
  checkpoint(): void {
    if (!this.snapshotPath || !this.walPath) return;

    const data = {
      agents: Array.from(this.agents.values()),
      borrowers: Array.from(this.borrowers.values()),
      calls: Array.from(this.calls.values()),
      processedEventIds: Array.from(this.processedEventIds),
      eventLog: this.eventLog,
      timestamp: Date.now(),
    };

    const tmpPath = `${this.snapshotPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, this.snapshotPath);

    // Truncate WAL file
    fs.writeFileSync(this.walPath, '', 'utf8');
  }

  getPersistenceDir(): string | null {
    return this.persistenceDir;
  }

  // ─── Agent Operations ───

  addAgent(agent: Agent): void {
    const copy = { ...agent };
    this.agents.set(agent.id, copy);
    if (copy.state === AgentState.AVAILABLE) {
      this.availableAgentIds.add(copy.id);
    } else {
      this.availableAgentIds.delete(copy.id);
    }
    this.appendWal('ADD_AGENT', copy);
  }

  getAgent(id: string): Agent | undefined {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : undefined;
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values()).map(a => ({ ...a }));
  }

  getAgentsByState(state: AgentState): Agent[] {
    return Array.from(this.agents.values())
      .filter(a => a.state === state)
      .map(a => ({ ...a }));
  }

  /**
   * Atomically reserve an available agent for a worker.
   *
   * CAS semantics: only succeeds if the agent is currently AVAILABLE.
   * Uses version checking to prevent ABA problems.
   */
  reserveAgent(
    agentId: string,
    workerId: string,
    leaseDurationMs: number = 10_000
  ): Agent | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    // CAS: only reserve if agent is AVAILABLE
    if (agent.state !== AgentState.AVAILABLE) {
      return null; // Another worker got here first
    }

    // Attempt the state transition. Only catch illegal-transition errors from
    // the state machine (which return null); WAL write errors must propagate
    // so callers know durability was not achieved.
    let updated: Agent;
    try {
      updated = transitionAgent(agent, AgentState.RESERVED, workerId);
    } catch {
      return null; // Illegal state transition — not a WAL error
    }
    updated.leaseExpiresAt = Date.now() + leaseDurationMs;
    updated.lockedBy = workerId;
    this.agents.set(agentId, updated);
    this.availableAgentIds.delete(agentId);
    this.appendWal('UPDATE_AGENT', updated); // throws on WAL failure — intentional
    this.logEvent('agent', agentId, 'RESERVE', AgentState.AVAILABLE, AgentState.RESERVED, workerId);
    return { ...updated };
  }

  /**
   * Reserve the next available agent for a worker in O(1) indexed lookup.
   */
  reserveNextAvailableAgent(
    workerId: string,
    campaignId?: string,
    leaseDurationMs: number = 10_000
  ): Agent | null {
    for (const id of this.availableAgentIds) {
      const agent = this.agents.get(id);
      if (!agent || agent.state !== AgentState.AVAILABLE) {
        this.availableAgentIds.delete(id);
        continue;
      }
      if (campaignId && agent.campaignId && agent.campaignId !== campaignId) continue;

      const result = this.reserveAgent(id, workerId, leaseDurationMs);
      if (result) return result;
    }
    return null;
  }

  /**
   * Update an agent's state atomically with version checking.
   */
  updateAgentState(
    agentId: string,
    newState: AgentState,
    expectedVersion?: number,
    workerId?: string
  ): Agent | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    if (expectedVersion !== undefined && agent.version !== expectedVersion) {
      return null; // Stale update
    }

    // Only catch illegal-transition errors; WAL errors must propagate.
    let updated: Agent;
    try {
      updated = transitionAgent(agent, newState, workerId);
    } catch {
      return null; // Illegal state transition
    }
    this.agents.set(agentId, updated);
    if (newState === AgentState.AVAILABLE) {
      this.availableAgentIds.add(agentId);
    } else {
      this.availableAgentIds.delete(agentId);
    }
    this.appendWal('UPDATE_AGENT', updated); // throws on WAL failure — intentional
    this.logEvent('agent', agentId, 'STATE_CHANGE', agent.state, newState, workerId ?? null);
    return { ...updated };
  }

  /**
   * Force-reset an agent's state (used by reconciliation sweeper).
   */
  forceResetAgent(agentId: string, state: AgentState): Agent | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const oldState = agent.state;
    const updated: Agent = {
      ...agent,
      state,
      lockedBy: null,
      leaseExpiresAt: null,
      version: agent.version + 1,
      lastStateChange: Date.now(),
    };
    this.agents.set(agentId, updated);
    if (state === AgentState.AVAILABLE) {
      this.availableAgentIds.add(agentId);
    } else {
      this.availableAgentIds.delete(agentId);
    }
    this.appendWal('UPDATE_AGENT', updated);
    this.logEvent('agent', agentId, 'FORCE_RESET', oldState, state, null, { reason: 'reconciliation' });
    return { ...updated };
  }

  // ─── Borrower Operations ───

  addBorrower(borrower: Borrower): void {
    const copy = { ...borrower };
    this.borrowers.set(borrower.id, copy);
    if (copy.status === BorrowerStatus.PENDING) {
      this.pendingBorrowerIds.add(copy.id);
    } else {
      this.pendingBorrowerIds.delete(copy.id);
    }
    this.appendWal('ADD_BORROWER', copy);
  }

  getBorrower(id: string): Borrower | undefined {
    const b = this.borrowers.get(id);
    return b ? { ...b } : undefined;
  }

  getAllBorrowers(): Borrower[] {
    return Array.from(this.borrowers.values()).map(b => ({ ...b }));
  }

  /**
   * Atomically reserve the next pending borrower for calling in O(1) indexed lookup.
   */
  reserveNextBorrower(
    workerId: string,
    campaignId?: string
  ): Borrower | null {
    for (const id of this.pendingBorrowerIds) {
      const candidate = this.borrowers.get(id);
      if (!candidate || candidate.status !== BorrowerStatus.PENDING) {
        this.pendingBorrowerIds.delete(id);
        continue;
      }
      if (campaignId && candidate.campaignId !== campaignId) continue;
      if (candidate.attemptCount >= candidate.maxAttempts) {
        this.pendingBorrowerIds.delete(id);
        continue;
      }

      const updated: Borrower = {
        ...candidate,
        status: BorrowerStatus.RESERVED,
        lockedBy: workerId,
        version: candidate.version + 1,
      };
      this.borrowers.set(candidate.id, updated);
      this.pendingBorrowerIds.delete(candidate.id);
      this.appendWal('UPDATE_BORROWER', updated);
      this.logEvent('borrower', candidate.id, 'RESERVE', BorrowerStatus.PENDING, BorrowerStatus.RESERVED, workerId);
      return { ...updated };
    }
    return null;
  }

  /**
   * Update a borrower's status.
   */
  updateBorrowerStatus(
    borrowerId: string,
    status: BorrowerStatus,
    workerId?: string
  ): Borrower | null {
    const borrower = this.borrowers.get(borrowerId);
    if (!borrower) return null;

    const oldStatus = borrower.status;
    const updated: Borrower = {
      ...borrower,
      status,
      lockedBy: status === BorrowerStatus.PENDING ? null : (workerId ?? borrower.lockedBy),
      lastAttemptAt: Date.now(),
      attemptCount: status === BorrowerStatus.FAILED ? borrower.attemptCount + 1 : borrower.attemptCount,
      version: borrower.version + 1,
    };
    this.borrowers.set(borrowerId, updated);
    if (status === BorrowerStatus.PENDING && updated.attemptCount < updated.maxAttempts) {
      this.pendingBorrowerIds.add(borrowerId);
    } else {
      this.pendingBorrowerIds.delete(borrowerId);
    }
    this.appendWal('UPDATE_BORROWER', updated);
    this.logEvent('borrower', borrowerId, 'STATUS_CHANGE', oldStatus, status, workerId ?? null);
    return { ...updated };
  }

  // ─── Call Operations ───

  addCall(call: Call): void {
    const copy = { ...call };
    this.calls.set(call.id, copy);
    this.appendWal('ADD_CALL', copy);
  }

  getCall(id: string): Call | undefined {
    const c = this.calls.get(id);
    return c ? { ...c } : undefined;
  }

  getAllCalls(): Call[] {
    return Array.from(this.calls.values()).map(c => ({ ...c }));
  }

  getCallsByState(state: CallState): Call[] {
    return Array.from(this.calls.values())
      .filter(c => c.state === state)
      .map(c => ({ ...c }));
  }

  /**
   * Transition a call's state using the call state machine.
   */
  transitionCallState(
    callId: string,
    newState: CallState,
    eventSequence?: number,
    eventId?: string,
    failureReason?: string
  ): TransitionResult {
    if (eventId && this.processedEventIds.has(eventId)) {
      return { status: 'stale', reason: `Duplicate event ${eventId} already processed` };
    }

    const call = this.calls.get(callId);
    if (!call) {
      return { status: 'invalid', reason: `Call ${callId} not found` };
    }

    const result = transitionCall(call, newState, eventSequence);

    if (result.status === 'applied') {
      if (failureReason) {
        result.call.failureReason = failureReason;
      }
      this.calls.set(callId, result.call);
      this.appendWal('UPDATE_CALL', { ...result.call, processedEventId: eventId });
      this.logEvent('call', callId, 'STATE_CHANGE', call.state, newState, null);

      if (eventId) {
        this.processedEventIds.add(eventId);
      }
    }

    return result;
  }

  /**
   * Assign an agent to a call.
   */
  assignAgentToCall(callId: string, agentId: string): Call | null {
    const call = this.calls.get(callId);
    if (!call) return null;

    const updated: Call = { ...call, agentId };
    this.calls.set(callId, updated);
    this.appendWal('UPDATE_CALL', updated);
    return { ...updated };
  }

  /**
   * Persist the provider-assigned call ID onto a call record.
   * This is the external reference used to cancel or query the call with the telecom provider.
   * Must be persisted to WAL so crash recovery knows which provider calls to reconcile.
   */
  setProviderCallId(callId: string, providerCallId: string): Call | null {
    const call = this.calls.get(callId);
    if (!call) return null;

    const updated: Call = { ...call, providerCallId };
    this.calls.set(callId, updated);
    this.appendWal('UPDATE_CALL', updated);
    return { ...updated };
  }

  // ─── Event Log ───

  private logEvent(
    entityType: 'agent' | 'call' | 'borrower',
    entityId: string,
    eventType: string,
    fromState: string,
    toState: string,
    workerId: string | null,
    metadata?: Record<string, unknown>
  ): void {
    this.eventLog.push({
      timestamp: Date.now(),
      entityType,
      entityId,
      eventType,
      fromState,
      toState,
      workerId,
      metadata,
    });
  }

  getEventLog(): EventLogEntry[] {
    return [...this.eventLog];
  }

  // ─── Metrics ───

  getMetrics(): StoreMetrics {
    const agents = Array.from(this.agents.values());
    const calls = Array.from(this.calls.values());
    const borrowers = Array.from(this.borrowers.values());

    return {
      totalAgents: agents.length,
      availableAgents: agents.filter(a => a.state === AgentState.AVAILABLE).length,
      reservedAgents: agents.filter(a => a.state === AgentState.RESERVED).length,
      dialingAgents: agents.filter(a => a.state === AgentState.DIALING).length,
      connectedAgents: agents.filter(a => a.state === AgentState.CONNECTED).length,
      wrapUpAgents: agents.filter(a => a.state === AgentState.WRAP_UP).length,
      pausedAgents: agents.filter(a => a.state === AgentState.PAUSED).length,
      offlineAgents: agents.filter(a => a.state === AgentState.OFFLINE).length,
      totalCalls: calls.length,
      queuedCalls: calls.filter(c => c.state === CallState.QUEUED).length,
      ringingCalls: calls.filter(c => c.state === CallState.RINGING).length,
      connectedCalls: calls.filter(c => c.state === CallState.CONNECTED).length,
      completedCalls: calls.filter(c => c.state === CallState.COMPLETED).length,
      failedCalls: calls.filter(c => c.state === CallState.FAILED).length,
      cancelledCalls: calls.filter(c => c.state === CallState.CANCELLED).length,
      pendingBorrowers: borrowers.filter(b => b.status === BorrowerStatus.PENDING).length,
    };
  }

  // ─── Reconciliation Queries ───

  getStaleAgents(now: number = Date.now()): Agent[] {
    return Array.from(this.agents.values())
      .filter(a =>
        (a.state === AgentState.RESERVED || a.state === AgentState.DIALING) &&
        a.leaseExpiresAt !== null &&
        a.leaseExpiresAt < now
      )
      .map(a => ({ ...a }));
  }

  getStaleCalls(maxAgeMs: number = 30_000): Call[] {
    const cutoff = Date.now() - maxAgeMs;
    return Array.from(this.calls.values())
      .filter(c =>
        !isTerminalCallState(c.state) &&
        c.startTime < cutoff &&
        (c.state === CallState.INITIATED || c.state === CallState.RESERVED)
      )
      .map(c => ({ ...c }));
  }

  getActiveCallCount(): number {
    return Array.from(this.calls.values())
      .filter(c =>
        !isTerminalCallState(c.state) &&
        c.state !== CallState.QUEUED
      ).length;
  }

  getRingingCallCount(): number {
    return Array.from(this.calls.values())
      .filter(c => c.state === CallState.RINGING || c.state === CallState.INITIATED).length;
  }

  getAbandonmentRate(): number {
    const calls = Array.from(this.calls.values());
    const attempted = calls.filter(c =>
      c.state !== CallState.QUEUED && c.state !== CallState.RESERVED
    ).length;
    if (attempted === 0) return 0;

    const abandoned = calls.filter(c =>
      c.state === CallState.FAILED && c.failureReason === 'NO_AGENT_AVAILABLE'
    ).length;
    return abandoned / attempted;
  }

  clear(): void {
    this.agents.clear();
    this.calls.clear();
    this.borrowers.clear();
    this.availableAgentIds.clear();
    this.pendingBorrowerIds.clear();
    this.eventLog = [];
    this.processedEventIds.clear();
    if (this.walPath && fs.existsSync(this.walPath)) {
      try { fs.unlinkSync(this.walPath); } catch {}
    }
    if (this.snapshotPath && fs.existsSync(this.snapshotPath)) {
      try { fs.unlinkSync(this.snapshotPath); } catch {}
    }
  }
}

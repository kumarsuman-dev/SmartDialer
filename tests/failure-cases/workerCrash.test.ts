import { Store } from '../../src/storage/store';
import { Reconciler } from '../../src/engine/reconciler';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createBorrower, BorrowerStatus } from '../../src/domain/borrower';
import { createCall, CallState } from '../../src/domain/call';

describe('Failure Case 1: Worker Crash During Call Setup', () => {
  let store: Store;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = new Store();
    reconciler = new Reconciler(store);
  });

  it('recovers stuck agents and calls when worker crashes after initiating call', () => {
    // 1. Worker reserves Agent
    const agent = createAgent('agent-1', 'Alice');
    agent.state = AgentState.AVAILABLE;
    store.addAgent(agent);
    // Lease expires 5 seconds ago (simulating crash that happened earlier)
    const reservedAgent = store.reserveAgent('agent-1', 'worker-crashed', 1000);
    expect(reservedAgent?.state).toBe(AgentState.RESERVED);

    // 2. Worker reserves Borrower
    const borrower = createBorrower('borrower-1', 'Bob', '+15551234567', 'campaign-1');
    store.addBorrower(borrower);
    store.updateBorrowerStatus('borrower-1', BorrowerStatus.IN_CALL, 'worker-crashed');

    // 3. Call initiated
    const call = createCall('call-1', 'borrower-1', 'campaign-1', 'provider-a');
    call.agentId = 'agent-1';
    call.state = CallState.INITIATED;
    call.startTime = Date.now() - 15_000; // initiated 15s ago
    store.addCall(call);

    // 4. Worker crashes! No updates received.
    // Expire lease
    const a = store.getAgent('agent-1')!;
    a.leaseExpiresAt = Date.now() - 5000;
    (store as any).agents.set('agent-1', a);

    // System starts back up and Reconciler runs
    const report = reconciler.reconcile(10_000);

    expect(report.reclaimedAgents).toBeGreaterThanOrEqual(1);
    expect(report.timedOutCalls).toBe(1);
    expect(report.reclaimedBorrowers).toBe(1);

    // Agent returned to AVAILABLE
    const recoveredAgent = store.getAgent('agent-1');
    expect(recoveredAgent?.state).toBe(AgentState.AVAILABLE);
    expect(recoveredAgent?.lockedBy).toBeNull();

    // Call marked FAILED with reason WORKER_CRASH_TIMEOUT
    const recoveredCall = store.getCall('call-1');
    expect(recoveredCall?.state).toBe(CallState.FAILED);
    expect(recoveredCall?.failureReason).toBe('WORKER_CRASH_TIMEOUT');

    // Borrower returned to PENDING for retry
    const recoveredBorrower = store.getBorrower('borrower-1');
    expect(recoveredBorrower?.status).toBe(BorrowerStatus.PENDING);
  });
});

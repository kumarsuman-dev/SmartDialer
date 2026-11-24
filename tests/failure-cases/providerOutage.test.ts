import { Store } from '../../src/storage/store';
import { MockProviderB } from '../../src/provider/mockProviderB';
import { SafetyController, SafetyAction } from '../../src/safety/safetyController';
import { CallAllocator } from '../../src/engine/callAllocator';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createBorrower, BorrowerStatus } from '../../src/domain/borrower';
import { createCall, CallState } from '../../src/domain/call';

describe('Failure Case 2: Provider Outage and Gateway Timeouts', () => {
  let store: Store;
  let providerB: MockProviderB;
  let safetyController: SafetyController;
  let callAllocator: CallAllocator;

  beforeEach(() => {
    store = new Store();
    providerB = new MockProviderB({ timeoutRate: 0.0 }); // start clean
    safetyController = new SafetyController(store, providerB, {
      maxProviderFailureRate: 0.20,
    });
    callAllocator = new CallAllocator(store, providerB);
  });

  afterEach(() => {
    providerB.shutdown();
  });

  it('handles provider outage: existing calls untouched, new calls rejected, borrowers retried', async () => {
    // 1. Existing calls already in CONNECTED status
    const existingAgent = createAgent('agent-active', 'Active Agent');
    existingAgent.state = AgentState.CONNECTED;
    store.addAgent(existingAgent);

    const existingCall = createCall('call-connected', 'b-existing', 'camp-1', 'provider-b');
    existingCall.state = CallState.CONNECTED;
    existingCall.agentId = 'agent-active';
    store.addCall(existingCall);

    // 2. Add available agent and pending borrower for new calls
    const availableAgent = createAgent('agent-idle', 'Idle Agent');
    availableAgent.state = AgentState.AVAILABLE;
    store.addAgent(availableAgent);

    const borrower = createBorrower('b-new', 'Charlie', '+15559998888', 'camp-1');
    store.addBorrower(borrower);

    // 3. Provider outage hits!
    providerB.setForcedOutage(true);

    // Try allocating a new call: Call placement fails due to outage
    const allocResult = await callAllocator.allocateAndDispatch(1, 'worker-1', 'camp-1', false);
    expect(allocResult.dispatchedCalls).toBe(0);

    // Check what happens to the borrower: returned to PENDING for retry because attempts < maxAttempts
    const updatedBorrower = store.getBorrower('b-new');
    expect(updatedBorrower?.status).toBe(BorrowerStatus.PENDING);

    // Check what happens to the agent: pre-reserved agent was returned to AVAILABLE
    const idleAgent = store.getAgent('agent-idle');
    expect(idleAgent?.state).toBe(AgentState.AVAILABLE);

    // Check existing connected call: unaffected by the provider outage
    const unchangedCall = store.getCall('call-connected');
    expect(unchangedCall?.state).toBe(CallState.CONNECTED);

    // 4. Check Safety Controller: trips circuit breaker / detects outage, rejects further new calls
    const safetyResult = safetyController.evaluate(5, true);
    expect(safetyResult.action).toBe(SafetyAction.REJECT);
    expect(safetyResult.approvedCalls).toBe(0);
    expect(safetyResult.reason).toContain('Provider degraded/failing');
  });
});

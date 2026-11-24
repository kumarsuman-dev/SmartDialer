import { Store } from '../../src/storage/store';
import { MockProviderA } from '../../src/provider/mockProviderA';
import { DialerWorker } from '../../src/engine/dialerWorker';
import { TelecomEventType, TelecomEvent } from '../../src/provider/telecomProvider';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createBorrower } from '../../src/domain/borrower';
import { createCall, CallState } from '../../src/domain/call';

describe('Failure Case 4: Duplicate Webhook Events', () => {
  let store: Store;
  let provider: MockProviderA;
  let worker: DialerWorker;

  beforeEach(() => {
    store = new Store();
    provider = new MockProviderA();
    worker = new DialerWorker('worker-1', store, provider, 100);
  });

  afterEach(() => {
    provider.shutdown();
  });

  it('safely drops duplicate events without creating duplicate state transitions or allocations', () => {
    // Setup available agent and borrower
    const agent = createAgent('agent-1', 'Alice', 'camp-1');
    agent.state = AgentState.AVAILABLE;
    store.addAgent(agent);

    const borrower = createBorrower('b-1', 'Bob', '+15551112222', 'camp-1');
    store.addBorrower(borrower);

    // Call in INITIATED status
    const call = createCall('call-1', 'b-1', 'camp-1', 'prov-a');
    call.state = CallState.INITIATED;
    store.addCall(call);

    // Provider sends ANSWERED event #1
    const eventAnswered: TelecomEvent = {
      eventId: 'evt-ans-1',
      callId: 'call-1',
      providerCallId: 'prov-call-1',
      type: TelecomEventType.ANSWERED,
      sequence: 1,
      timestamp: Date.now(),
    };

    worker.handleTelecomEvent(eventAnswered);

    const callAfterFirst = store.getCall('call-1');
    expect(callAfterFirst?.state).toBe(CallState.CONNECTED);
    expect(callAfterFirst?.agentId).toBe('agent-1');
    expect(callAfterFirst?.version).toBe(2); // INITIATED -> ANSWERED (v1) -> CONNECTED (v2)

    // Provider sends DUPLICATE ANSWERED event #2 (same eventId and sequence)
    worker.handleTelecomEvent(eventAnswered);

    // Provider sends DUPLICATE ANSWERED event #3 (same eventId and sequence)
    worker.handleTelecomEvent(eventAnswered);

    const callAfterDuplicates = store.getCall('call-1');
    // Version and state MUST NOT change
    expect(callAfterDuplicates?.state).toBe(CallState.CONNECTED);
    expect(callAfterDuplicates?.version).toBe(callAfterFirst?.version);

    // Provider sends COMPLETED event
    const eventCompleted: TelecomEvent = {
      eventId: 'evt-comp-2',
      callId: 'call-1',
      providerCallId: 'prov-call-1',
      type: TelecomEventType.COMPLETED,
      sequence: 2,
      timestamp: Date.now(),
    };

    worker.handleTelecomEvent(eventCompleted);

    const callFinal = store.getCall('call-1');
    expect(callFinal?.state).toBe(CallState.COMPLETED);
  });
});

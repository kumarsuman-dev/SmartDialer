import { Store } from '../../src/storage/store';
import { MockProviderB } from '../../src/provider/mockProviderB';
import { DialerWorker } from '../../src/engine/dialerWorker';
import { TelecomEventType, TelecomEvent } from '../../src/provider/telecomProvider';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createBorrower } from '../../src/domain/borrower';
import { createCall, CallState } from '../../src/domain/call';

describe('Failure Case 5: Out-of-Order Webhook Events', () => {
  let store: Store;
  let provider: MockProviderB;
  let worker: DialerWorker;

  beforeEach(() => {
    store = new Store();
    provider = new MockProviderB();
    worker = new DialerWorker('worker-1', store, provider);
  });

  afterEach(() => {
    provider.shutdown();
  });

  it('handles inverted event delivery (COMPLETED followed by ANSWERED then RINGING) without state corruption', () => {
    const agent = createAgent('agent-1', 'Alice');
    agent.state = AgentState.AVAILABLE;
    store.addAgent(agent);

    const borrower = createBorrower('b-1', 'Bob', '+15551112222', 'camp-1');
    store.addBorrower(borrower);

    // Call in INITIATED status
    const call = createCall('call-1', 'b-1', 'camp-1', 'prov-b');
    call.state = CallState.INITIATED;
    store.addCall(call);

    // Event 1 arrives out of order: COMPLETED (Sequence 3)
    const eventCompleted: TelecomEvent = {
      eventId: 'evt-comp-3',
      callId: 'call-1',
      providerCallId: 'prov-b-call-1',
      type: TelecomEventType.COMPLETED,
      sequence: 3,
      timestamp: Date.now(),
    };

    worker.handleTelecomEvent(eventCompleted);

    const callAfterCompleted = store.getCall('call-1');
    expect(callAfterCompleted?.state).toBe(CallState.COMPLETED);

    // Event 2 arrives late: ANSWERED (Sequence 2)
    const eventAnswered: TelecomEvent = {
      eventId: 'evt-ans-2',
      callId: 'call-1',
      providerCallId: 'prov-b-call-1',
      type: TelecomEventType.ANSWERED,
      sequence: 2,
      timestamp: Date.now() - 500,
    };

    worker.handleTelecomEvent(eventAnswered);

    // Call MUST remain COMPLETED (terminal state cannot regress)
    const callAfterAnswered = store.getCall('call-1');
    expect(callAfterAnswered?.state).toBe(CallState.COMPLETED);

    // Event 3 arrives late: RINGING (Sequence 1)
    const eventRinging: TelecomEvent = {
      eventId: 'evt-ring-1',
      callId: 'call-1',
      providerCallId: 'prov-b-call-1',
      type: TelecomEventType.RINGING,
      sequence: 1,
      timestamp: Date.now() - 1000,
    };

    worker.handleTelecomEvent(eventRinging);

    // Call MUST still remain COMPLETED
    const callFinal = store.getCall('call-1');
    expect(callFinal?.state).toBe(CallState.COMPLETED);
  });
});

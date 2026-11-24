import { Store } from '../../src/storage/store';
import { MockProviderA } from '../../src/provider/mockProviderA';
import { SafetyController, SafetyAction } from '../../src/safety/safetyController';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createCall, CallState } from '../../src/domain/call';

describe('Safety Controller', () => {
  let store: Store;
  let provider: MockProviderA;
  let safetyController: SafetyController;

  beforeEach(() => {
    store = new Store();
    provider = new MockProviderA();
    safetyController = new SafetyController(store, provider, {
      maxAbandonmentRate: 0.03, // 3%
      maxDialMultiplier: 2.0,
    });
  });

  afterEach(() => {
    provider.shutdown();
  });

  it('rejects all calls if 0 agents are available or in wrap-up', () => {
    // No agents added
    const result = safetyController.evaluate(5, true);
    expect(result.action).toBe(SafetyAction.REJECT);
    expect(result.approvedCalls).toBe(0);
    expect(result.reason).toContain('Zero agent capacity available');
  });

  it('approves predictive calls when within safe threshold', () => {
    for (let i = 1; i <= 10; i++) {
      const a = createAgent(`a-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // 10 available agents, maxDialMultiplier = 2.0 => max 20 calls allowed
    const result = safetyController.evaluate(15, true);
    expect(result.action).toBe(SafetyAction.APPROVE);
    expect(result.approvedCalls).toBe(15);
  });

  it('reduces excessive predictive requests to the safe multiplier cap', () => {
    for (let i = 1; i <= 5; i++) {
      const a = createAgent(`a-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // 5 agents, maxMultiplier = 2.0 => max allowed = 10
    // Requesting 25 calls
    const result = safetyController.evaluate(25, true);
    expect(result.action).toBe(SafetyAction.REDUCE);
    expect(result.approvedCalls).toBeLessThanOrEqual(10);
  });

  it('forces FALLBACK_TO_PROGRESSIVE when abandonment rate hits or exceeds 3%', () => {
    for (let i = 1; i <= 10; i++) {
      const a = createAgent(`a-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // Simulate 100 calls with 4 abandoned (4% abandonment rate)
    for (let i = 1; i <= 100; i++) {
      const c = createCall(`c-${i}`, `b-${i}`, 'c-1', 'p-1');
      if (i <= 4) {
        c.state = CallState.FAILED;
        c.failureReason = 'NO_AGENT_AVAILABLE';
      } else {
        c.state = CallState.COMPLETED;
      }
      store.addCall(c);
    }

    expect(store.getAbandonmentRate()).toBeGreaterThanOrEqual(0.03);

    // Requesting 20 calls in predictive mode
    const result = safetyController.evaluate(20, true);
    expect(result.action).toBe(SafetyAction.FALLBACK_TO_PROGRESSIVE);
    // In fallback to progressive mode, approved calls are limited to available agents (10)
    expect(result.approvedCalls).toBeLessThanOrEqual(10);
  });
});

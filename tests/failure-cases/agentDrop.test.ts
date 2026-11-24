import { Store } from '../../src/storage/store';
import { MockProviderA } from '../../src/provider/mockProviderA';
import { SafetyController, SafetyAction } from '../../src/safety/safetyController';
import { PredictivePacing } from '../../src/pacing/predictivePacing';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createCall, CallState } from '../../src/domain/call';

describe('Failure Case 3: Agent Availability Sudden Drop', () => {
  let store: Store;
  let provider: MockProviderA;
  let pacingEngine: PredictivePacing;
  let safetyController: SafetyController;

  beforeEach(() => {
    store = new Store();
    provider = new MockProviderA();
    pacingEngine = new PredictivePacing(store, provider, {
      initialAnswerRate: 0.5,
      avgTalkTimeSeconds: 90,
      avgRingingTimeSeconds: 10,
    });
    safetyController = new SafetyController(store, provider, {
      maxRingingOverhangRatio: 1.5,
      maxDialMultiplier: 2.0,
    });
  });

  afterEach(() => {
    provider.shutdown();
  });

  it('immediately throttles pacing and clamps new dials when 40 of 100 agents disappear', () => {
    // 1. 100 agents available
    for (let i = 1; i <= 100; i++) {
      const a = createAgent(`agent-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // Initial calculation with 100 agents
    let decision = pacingEngine.calculatePacing();
    let safety = safetyController.evaluate(decision.targetCalls, true);
    expect(decision.targetCalls).toBeGreaterThan(100);
    // Under 100 agents, safety action allows high-volume dialing
    expect([SafetyAction.APPROVE, SafetyAction.REDUCE]).toContain(safety.action);
    expect(safety.approvedCalls).toBeGreaterThan(50);

    // 2. 40 agents suddenly disappear (go PAUSED or OFFLINE)
    for (let i = 1; i <= 40; i++) {
      store.forceResetAgent(`agent-${i}`, AgentState.PAUSED);
    }

    expect(store.getAgentsByState(AgentState.AVAILABLE).length).toBe(60);

    // 3. System recalculates on next tick (immediate reaction)
    const newDecision = pacingEngine.calculatePacing();
    expect(newDecision.factors.availableAgents).toBe(60);
    expect(newDecision.targetCalls).toBeLessThan(decision.targetCalls);

    // 4. If in-flight calls are already ringing (e.g. 100 calls ringing from previous batch)
    // For 60 agents, max allowed ringing is 60 * 1.5 = 90 calls.
    for (let i = 1; i <= 100; i++) {
      const c = createCall(`ringing-${i}`, `b-${i}`, 'camp-1', 'prov');
      c.state = CallState.RINGING;
      store.addCall(c);
    }

    // Safety Controller immediately intervenes: ringing overhang limit reached for 60 agents
    const overhangCheck = safetyController.evaluate(newDecision.targetCalls, true);
    expect(overhangCheck.action).toBe(SafetyAction.REJECT);
    expect(overhangCheck.approvedCalls).toBe(0);
    expect(overhangCheck.reason).toContain('Ringing overhang limit reached');
  });
});

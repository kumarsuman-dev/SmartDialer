import { Store } from '../../src/storage/store';
import { MockProviderA } from '../../src/provider/mockProviderA';
import { PredictivePacing } from '../../src/pacing/predictivePacing';
import { ProgressivePacing } from '../../src/pacing/progressivePacing';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createCall, CallState } from '../../src/domain/call';

describe('Pacing Engines', () => {
  let store: Store;
  let provider: MockProviderA;

  beforeEach(() => {
    store = new Store();
    provider = new MockProviderA();
  });

  afterEach(() => {
    provider.shutdown();
  });

  describe('Progressive Pacing', () => {
    it('strictly dials 1 call per available agent minus ringing calls', () => {
      const progressive = new ProgressivePacing(store);

      for (let i = 1; i <= 5; i++) {
        const a = createAgent(`a-${i}`, `Agent ${i}`);
        a.state = AgentState.AVAILABLE;
        store.addAgent(a);
      }

      // 5 available agents, 0 ringing -> target = 5
      let decision = progressive.calculatePacing();
      expect(decision.targetCalls).toBe(5);

      // Add 2 ringing calls
      const c1 = createCall('c-1', 'b-1', 'camp-1', 'prov');
      c1.state = CallState.RINGING;
      store.addCall(c1);

      const c2 = createCall('c-2', 'b-2', 'camp-1', 'prov');
      c2.state = CallState.RINGING;
      store.addCall(c2);

      // 5 agents - 2 ringing -> target = 3
      decision = progressive.calculatePacing();
      expect(decision.targetCalls).toBe(3);
    });
  });

  describe('Predictive Pacing', () => {
    it('proposes higher call volume for low answer rate and outputs clear reasoning trace', () => {
      for (let i = 1; i <= 10; i++) {
        const a = createAgent(`a-${i}`, `Agent ${i}`);
        a.state = AgentState.AVAILABLE;
        store.addAgent(a);
      }

      // Scenario A: 20% answer rate
      const predictiveA = new PredictivePacing(store, provider, {
        initialAnswerRate: 0.20,
        avgTalkTimeSeconds: 120,
        avgRingingTimeSeconds: 15,
      });

      const decisionA = predictiveA.calculatePacing();
      // With 10 available agents and 20% answer rate: 10 / 0.20 = 50 calls needed
      expect(decisionA.targetCalls).toBeGreaterThan(10);
      expect(decisionA.reasoning).toContain('Predictive Calculation Trace');
      expect(decisionA.reasoning).toContain('Estimated Answer Rate (p_ans): 20.0%');

      // Scenario C: 70% answer rate
      const predictiveC = new PredictivePacing(store, provider, {
        initialAnswerRate: 0.70,
        avgTalkTimeSeconds: 180,
        avgRingingTimeSeconds: 15,
      });

      const decisionC = predictiveC.calculatePacing();
      // 10 / 0.70 = ~14 calls needed
      expect(decisionC.targetCalls).toBeLessThan(decisionA.targetCalls);
    });
  });
});

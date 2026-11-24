import { AgentState, createAgent } from '../../src/domain/agent';
import { CallState, createCall } from '../../src/domain/call';
import {
  canTransitionAgent,
  transitionAgent,
  getAgentStateRank,
} from '../../src/state-machine/agentStateMachine';
import {
  canTransitionCall,
  transitionCall,
  isTerminalCallState,
  getCallStateRank,
} from '../../src/state-machine/callStateMachine';

describe('Agent State Machine', () => {
  it('allows valid agent transitions', () => {
    const agent = createAgent('agent-1', 'Alice');
    expect(agent.state).toBe(AgentState.OFFLINE);

    const available = transitionAgent(agent, AgentState.AVAILABLE);
    expect(available.state).toBe(AgentState.AVAILABLE);

    const reserved = transitionAgent(available, AgentState.RESERVED, 'worker-1');
    expect(reserved.state).toBe(AgentState.RESERVED);
    expect(reserved.lockedBy).toBe('worker-1');

    const dialing = transitionAgent(reserved, AgentState.DIALING);
    expect(dialing.state).toBe(AgentState.DIALING);

    const connected = transitionAgent(dialing, AgentState.CONNECTED);
    expect(connected.state).toBe(AgentState.CONNECTED);

    const wrapUp = transitionAgent(connected, AgentState.WRAP_UP);
    expect(wrapUp.state).toBe(AgentState.WRAP_UP);

    const backToAvailable = transitionAgent(wrapUp, AgentState.AVAILABLE);
    expect(backToAvailable.state).toBe(AgentState.AVAILABLE);
    expect(backToAvailable.lockedBy).toBeNull();
  });

  it('rejects invalid agent transitions with an error', () => {
    const agent = createAgent('agent-2', 'Bob');
    agent.state = AgentState.OFFLINE;

    // OFFLINE cannot jump straight to CONNECTED
    expect(() => transitionAgent(agent, AgentState.CONNECTED)).toThrow(/Invalid agent state transition/);
  });
});

describe('Call State Machine', () => {
  it('allows standard forward call progression', () => {
    const call = createCall('call-1', 'b-1', 'c-1', 'prov-a');
    expect(call.state).toBe(CallState.QUEUED);

    const r1 = transitionCall(call, CallState.RESERVED);
    expect(r1.status).toBe('applied');

    const r2 = transitionCall((r1 as any).call, CallState.INITIATED);
    expect(r2.status).toBe('applied');

    const r3 = transitionCall((r2 as any).call, CallState.RINGING);
    expect(r3.status).toBe('applied');

    const r4 = transitionCall((r3 as any).call, CallState.ANSWERED);
    expect(r4.status).toBe('applied');

    const r5 = transitionCall((r4 as any).call, CallState.CONNECTED);
    expect(r5.status).toBe('applied');

    const r6 = transitionCall((r5 as any).call, CallState.COMPLETED);
    expect(r6.status).toBe('applied');
  });

  it('identifies terminal states and blocks transitions out of terminal states', () => {
    expect(isTerminalCallState(CallState.COMPLETED)).toBe(true);
    expect(isTerminalCallState(CallState.FAILED)).toBe(true);
    expect(isTerminalCallState(CallState.CANCELLED)).toBe(true);
    expect(isTerminalCallState(CallState.ANSWERED)).toBe(false);

    const call = createCall('call-2', 'b-2', 'c-1', 'prov-a');
    call.state = CallState.COMPLETED;

    const attempt = transitionCall(call, CallState.ANSWERED);
    expect(attempt.status).toBe('stale');
  });

  it('drops out-of-order stale events where new rank < current rank', () => {
    const call = createCall('call-3', 'b-3', 'c-1', 'prov-a');
    call.state = CallState.CONNECTED; // Rank 5

    // Event arrives for RINGING (Rank 3)
    const result = transitionCall(call, CallState.RINGING);
    expect(result.status).toBe('stale');
  });
});

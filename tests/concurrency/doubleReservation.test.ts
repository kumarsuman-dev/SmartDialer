import { Store } from '../../src/storage/store';
import { createAgent, AgentState } from '../../src/domain/agent';

/**
 * Concurrency Model Clarification
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js is single-threaded. All JavaScript execution is serialized on the
 * event loop. Consequently, concurrent `Promise.resolve().then(...)` tasks
 * are NOT truly parallel — they interleave on the microtask queue, not on
 * separate OS threads. This means:
 *
 *   • WITHIN a single process: The Store's CAS logic (check state →
 *     write state atomically) is guaranteed to be race-free because only
 *     one microtask executes at a time. No mutex or lock is required.
 *
 *   • ACROSS multiple processes: The in-memory Store is NOT shared.
 *     Preventing double-reservation across separate OS processes requires
 *     an external serialization mechanism (e.g., Redis SETNX / Redlock,
 *     PostgreSQL SELECT … FOR UPDATE, or a dedicated lock service).
 *     This prototype documents that requirement clearly in ARCHITECTURE.md.
 *
 * These tests verify intra-process CAS correctness: given 50 concurrent
 * Promise chains racing for 10 agents, exactly 10 succeed — zero duplicates.
 */

describe('Concurrency Protection: Double Reservation Prevention', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it('prevents two workers from reserving the same agent concurrently (CAS)', async () => {
    // 1 agent available
    const agent = createAgent('agent-shared', 'John Doe');
    agent.state = AgentState.AVAILABLE;
    store.addAgent(agent);

    // Two workers simulate concurrent reservation attempts
    const p1 = Promise.resolve().then(() => store.reserveAgent('agent-shared', 'worker-1'));
    const p2 = Promise.resolve().then(() => store.reserveAgent('agent-shared', 'worker-2'));

    const [res1, res2] = await Promise.all([p1, p2]);

    // Exactly one worker must succeed, one must receive null
    const winners = [res1, res2].filter(r => r !== null);
    const losers = [res1, res2].filter(r => r === null);

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    // Verified that the agent is locked by the winning worker
    const currentAgent = store.getAgent('agent-shared');
    expect(currentAgent?.state).toBe(AgentState.RESERVED);
    expect(currentAgent?.lockedBy).toBe(winners[0]?.lockedBy);
  });

  it('ensures under high contention (50 workers racing for 10 agents), exactly 10 succeed', async () => {
    const totalAgents = 10;
    const totalWorkers = 50;

    for (let i = 1; i <= totalAgents; i++) {
      const a = createAgent(`agent-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // 50 workers simultaneously call reserveNextAvailableAgent
    const workerPromises = Array.from({ length: totalWorkers }, (_, i) => {
      const workerId = `contention-worker-${i + 1}`;
      return Promise.resolve().then(() => store.reserveNextAvailableAgent(workerId));
    });

    const results = await Promise.all(workerPromises);
    const successful = results.filter(r => r !== null);
    const failed = results.filter(r => r === null);

    expect(successful.length).toBe(totalAgents);
    expect(failed.length).toBe(totalWorkers - totalAgents);

    // Ensure all successful reservations belong to distinct agents
    const reservedAgentIds = new Set(successful.map(a => a!.id));
    expect(reservedAgentIds.size).toBe(totalAgents);
  });
});

import * as fs from 'fs';
import * as path from 'path';
import { Store } from '../../src/storage/store';
import { createAgent, AgentState } from '../../src/domain/agent';
import { createBorrower, BorrowerStatus } from '../../src/domain/borrower';
import { createCall, CallState } from '../../src/domain/call';

describe('Persistent Storage: Write-Ahead Log (WAL) & Crash Recovery', () => {
  const testDir = path.join(__dirname, '../../data/test-persistence');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('survives process crash and reconstitutes agent locks, borrower status, and calls from WAL', () => {
    // 1. Initial Store instance (simulating primary process).
    // NOTE: Node.js is single-threaded; "process crash" is simulated by dropping
    // the reference and creating a fresh instance reading the same WAL from disk.
    // This correctly covers the SIGKILL scenario because all WAL writes are
    // synchronous (appendFileSync), so data already flushed to disk before "crash".
    let store: Store | null = new Store(testDir);

    const agent1 = createAgent('agent-1', 'Alice', 'camp-1');
    agent1.state = AgentState.AVAILABLE;
    store.addAgent(agent1);

    const borrower1 = createBorrower('b-1', 'Bob', '+15551234567', 'camp-1');
    store.addBorrower(borrower1);

    // Reserve agent and borrower (synchronous WAL writes happen here)
    const reservedAgent = store.reserveAgent('agent-1', 'worker-101');
    expect(reservedAgent?.state).toBe(AgentState.RESERVED);

    store.updateBorrowerStatus('b-1', BorrowerStatus.IN_CALL, 'worker-101');

    // Add initiated call and persist the providerCallId via the Store
    const call1 = createCall('call-1', 'b-1', 'camp-1', 'prov-a');
    call1.agentId = 'agent-1';
    call1.state = CallState.INITIATED;
    store.addCall(call1);
    store.setProviderCallId('call-1', 'ext-prov-ref-999');

    // 2. SIMULATE SUDDEN PROCESS CRASH
    // Drop store reference — all subsequent WAL was written synchronously to disk,
    // so a new Store instance reading the same directory recovers full state.
    store = null;

    // 3. RESTART PROCESS & RECOVER
    const recoveredStore = new Store(testDir);

    // Verify Agent state, worker lock, and version survived
    const recoveredAgent = recoveredStore.getAgent('agent-1');
    expect(recoveredAgent).toBeDefined();
    expect(recoveredAgent?.state).toBe(AgentState.RESERVED);
    expect(recoveredAgent?.lockedBy).toBe('worker-101');
    expect(recoveredAgent?.version).toBe(1);

    // Verify Borrower status survived
    const recoveredBorrower = recoveredStore.getBorrower('b-1');
    expect(recoveredBorrower).toBeDefined();
    expect(recoveredBorrower?.status).toBe(BorrowerStatus.IN_CALL);

    // Verify Call survived — including providerCallId written via setProviderCallId
    const recoveredCall = recoveredStore.getCall('call-1');
    expect(recoveredCall).toBeDefined();
    expect(recoveredCall?.state).toBe(CallState.INITIATED);
    expect(recoveredCall?.agentId).toBe('agent-1');
    expect(recoveredCall?.providerCallId).toBe('ext-prov-ref-999');
  });

  it('creates clean snapshot checkpoint and truncates WAL', () => {
    const store = new Store(testDir);

    for (let i = 1; i <= 5; i++) {
      const a = createAgent(`agent-${i}`, `Agent ${i}`);
      a.state = AgentState.AVAILABLE;
      store.addAgent(a);
    }

    // Checkpoint to snapshot.json
    store.checkpoint();

    const snapshotPath = path.join(testDir, 'snapshot.json');
    const walPath = path.join(testDir, 'store.wal');

    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.readFileSync(walPath, 'utf8')).toBe(''); // WAL truncated

    // New store should load from snapshot
    const newStore = new Store(testDir);
    expect(newStore.getAllAgents().length).toBe(5);
  });

  it('WAL write failure marks store as failed and prevents silent data divergence', () => {
    const store = new Store(testDir);

    const agent = createAgent('agent-wal-fail', 'Eve');
    agent.state = AgentState.AVAILABLE;
    store.addAgent(agent);

    // Simulate WAL becoming unwritable by making the WAL file a directory
    // (any write to it will fail with EISDIR).
    const walPath = path.join(testDir, 'store.wal');
    fs.unlinkSync(walPath);
    fs.mkdirSync(walPath); // Now it's a directory — appendFileSync will throw EISDIR

    // The next mutation must throw rather than silently lose durability
    expect(() => {
      store.reserveAgent('agent-wal-fail', 'worker-wal-test');
    }).toThrow();

    // The store must be marked as permanently failed
    expect(store.isWalFailed()).toBe(true);

    // Subsequent mutations must also fail fast (not silently succeed)
    expect(() => {
      store.updateAgentState('agent-wal-fail', AgentState.AVAILABLE);
    }).toThrow();

    // Clean up: remove the directory we created so afterEach rmSync works
    fs.rmdirSync(walPath);
  });
});

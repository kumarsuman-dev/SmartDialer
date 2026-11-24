/**
 * Dialer Orchestrator — Manages Campaign Pipeline Execution
 *
 * Implements the explicit pipeline required by the PDF:
 *   Campaign > Pacing Engine > Safety Controller > Call Allocator > Telecom Provider
 *
 * Key Capabilities:
 * - Supports both Progressive and Predictive modes dynamically
 * - Ensures Safety Controller CANNOT be turned off
 * - Records all decision traces (utilization, calls initiated, calls connected, safety decisions)
 * - Drives periodic tick execution or single-step ticks
 */

import { Store } from '../storage/store';
import { TelecomProvider } from '../provider/telecomProvider';
import { PacingEngine } from '../pacing/pacingEngine';
import { SafetyController, SafetyEvaluationResult, SafetyAction } from '../safety/safetyController';
import { CallAllocator } from './callAllocator';
import { DialerWorker } from './dialerWorker';
import { Reconciler } from './reconciler';

export interface TickRecord {
  timestamp: number;
  tickNumber: number;
  mode: 'PROGRESSIVE' | 'PREDICTIVE';
  proposedCalls: number;
  pacingReasoning: string;
  safetyAction: SafetyAction;
  approvedCalls: number;
  safetyReason: string;
  dispatchedCalls: number;
  metrics: {
    availableAgents: number;
    connectedAgents: number;
    wrapUpAgents: number;
    totalAgents: number;
    activeRingingCalls: number;
    connectedCalls: number;
    completedCalls: number;
    failedCalls: number;
    abandonmentRate: number;
    agentUtilization: number;
  };
}

export class DialerOrchestrator {
  private store: Store;
  private provider: TelecomProvider;
  private pacingEngine: PacingEngine;
  private safetyController: SafetyController;
  private callAllocator: CallAllocator;
  private workers: DialerWorker[] = [];
  private reconciler: Reconciler;

  private isRunning: boolean = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCounter: number = 0;
  private tickHistory: TickRecord[] = [];

  constructor(
    store: Store,
    provider: TelecomProvider,
    pacingEngine: PacingEngine,
    safetyController: SafetyController,
    workerCount: number = 2
  ) {
    this.store = store;
    this.provider = provider;
    this.pacingEngine = pacingEngine;
    this.safetyController = safetyController;
    this.callAllocator = new CallAllocator(store, provider);
    this.reconciler = new Reconciler(store);

    // Initialize distributed worker pool
    for (let i = 1; i <= workerCount; i++) {
      this.workers.push(new DialerWorker(`worker-${i}`, store, provider));
    }

    // Route provider webhooks to workers (round-robin or shared)
    let workerIdx = 0;
    this.provider.onEvent(event => {
      const worker = this.workers[workerIdx % this.workers.length];
      workerIdx++;
      worker.handleTelecomEvent(event);
    });
  }

  setPacingEngine(engine: PacingEngine): void {
    this.pacingEngine = engine;
  }

  /**
   * Execute a single dialing tick through the pipeline:
   * Campaign > Pacing Engine > Safety Controller > Call Allocator > Telecom Provider
   */
  async tick(campaignId: string = 'campaign-main'): Promise<TickRecord> {
    this.tickCounter++;
    const isPredictive = this.pacingEngine.mode === 'PREDICTIVE';

    // 1. Pacing Engine proposes call quota
    const pacingDecision = this.pacingEngine.calculatePacing(campaignId);

    // 2. Safety Controller evaluates proposal (CANNOT BE BYPASSED)
    const safetyResult = this.safetyController.evaluate(
      pacingDecision.targetCalls,
      isPredictive,
      pacingDecision.factors.estimatedAnswerRate
    );

    // Determine actual calls allowed and dialing mode based on Safety Controller
    let actualCallsToDispatch = safetyResult.approvedCalls;
    let effectivePredictive = isPredictive;

    if (safetyResult.action === SafetyAction.FALLBACK_TO_PROGRESSIVE) {
      // Force progressive behavior
      effectivePredictive = false;
    }

    // 3. Call Allocator dispatches calls to Telecom Provider
    let dispatchedCount = 0;
    if (actualCallsToDispatch > 0) {
      const activeWorker = this.workers[this.tickCounter % this.workers.length];
      const allocResult = await this.callAllocator.allocateAndDispatch(
        actualCallsToDispatch,
        activeWorker.workerId,
        campaignId,
        effectivePredictive
      );
      dispatchedCount = allocResult.dispatchedCalls;
    }

    // 4. Capture telemetry & metrics
    const metrics = this.store.getMetrics();
    const activeWorkingAgents = metrics.connectedAgents + metrics.wrapUpAgents;
    const agentUtilization = metrics.totalAgents > 0 ? (activeWorkingAgents / metrics.totalAgents) * 100 : 0;
    const abandonmentRate = this.store.getAbandonmentRate();

    const record: TickRecord = {
      timestamp: Date.now(),
      tickNumber: this.tickCounter,
      mode: this.pacingEngine.mode,
      proposedCalls: pacingDecision.targetCalls,
      pacingReasoning: pacingDecision.reasoning,
      safetyAction: safetyResult.action,
      approvedCalls: safetyResult.approvedCalls,
      safetyReason: safetyResult.reason,
      dispatchedCalls: dispatchedCount,
      metrics: {
        availableAgents: metrics.availableAgents,
        connectedAgents: metrics.connectedAgents,
        wrapUpAgents: metrics.wrapUpAgents,
        totalAgents: metrics.totalAgents,
        activeRingingCalls: metrics.ringingCalls,
        connectedCalls: metrics.connectedCalls,
        completedCalls: metrics.completedCalls,
        failedCalls: metrics.failedCalls,
        abandonmentRate,
        agentUtilization,
      },
    };

    this.tickHistory.push(record);
    return record;
  }

  /** Start automated dialing loop */
  start(intervalMs: number = 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.reconciler.start(2000, 10000);

    this.tickInterval = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        // Prevent loop termination on tick error
      }
    }, intervalMs);
  }

  /** Stop automated dialing loop */
  stop(): void {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.reconciler.stop();
  }

  getTickHistory(): TickRecord[] {
    return [...this.tickHistory];
  }

  getReconciler(): Reconciler {
    return this.reconciler;
  }

  getStore(): Store {
    return this.store;
  }

  getProvider(): TelecomProvider {
    return this.provider;
  }

  getSafetyController(): SafetyController {
    return this.safetyController;
  }
}

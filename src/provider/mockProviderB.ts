/**
 * Mock Provider B — Slower, Jittery, and Adversarial
 *
 * Characteristics:
 * - High latency: 200ms - 1000ms for call placement
 * - Occasional timeouts: simulated HTTP 504 / gateway timeout
 * - Duplicate events: retransmits the same event (e.g. ANSWERED x 3)
 * - Out-of-order events: delivers COMPLETED before ANSWERED, or ANSWERED before RINGING
 * - Configurable failure injection to simulate sudden provider outages
 */

import { v4 as uuidv4 } from 'uuid';
import {
  TelecomProvider,
  TelecomEvent,
  TelecomEventType,
  TelecomEventCallback,
  CallPlacementResult,
  ProviderHealth,
} from './telecomProvider';

export interface MockProviderBConfig {
  /** Base answer rate (0-1). Default: 0.5 */
  answerRate?: number;
  /** Average talk time in ms. Default: 90000 (90s) */
  avgTalkTimeMs?: number;
  /** Call placement latency range [min, max] ms. Default: [200, 1000] */
  placementLatency?: [number, number];
  /** Ringing duration range [min, max] ms. Default: [4000, 12000] */
  ringingDuration?: [number, number];
  /** Timeout rate on call placement (0-1). Default: 0.10 (10%) */
  timeoutRate?: number;
  /** Probability of sending duplicate events (0-1). Default: 0.25 */
  duplicateEventRate?: number;
  /** Probability of emitting events out of order (0-1). Default: 0.20 */
  outOfOrderRate?: number;
  /** Time scale factor for simulation (default: 0.01 = 100x faster) */
  timeScale?: number;
}

export class MockProviderB implements TelecomProvider {
  readonly providerId = 'provider-b';
  private callbacks: TelecomEventCallback[] = [];
  private activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private sequenceCounters: Map<string, number> = new Map();
  private callHistory: { timestamp: number; success: boolean; latencyMs: number }[] = [];
  private config: Required<MockProviderBConfig>;
  private forcedOutage: boolean = false;

  constructor(config: MockProviderBConfig = {}) {
    this.config = {
      answerRate: config.answerRate ?? 0.5,
      avgTalkTimeMs: config.avgTalkTimeMs ?? 90_000,
      placementLatency: config.placementLatency ?? [200, 1000],
      ringingDuration: config.ringingDuration ?? [4000, 12000],
      timeoutRate: config.timeoutRate ?? 0.10,
      duplicateEventRate: config.duplicateEventRate ?? 0.25,
      outOfOrderRate: config.outOfOrderRate ?? 0.20,
      timeScale: config.timeScale ?? 0.01,
    };
  }

  /** Trigger or recover from complete provider outage (for failure scenario tests) */
  setForcedOutage(outage: boolean): void {
    this.forcedOutage = outage;
  }

  async placeCall(callId: string, phoneNumber: string): Promise<CallPlacementResult> {
    const startTime = Date.now();
    const [minLat, maxLat] = this.config.placementLatency;
    const latency = this.scaled(this.randomBetween(minLat, maxLat));

    // Simulate high network latency / jitter
    await this.delay(latency);

    // If forced outage is active, or random timeout triggers
    if (this.forcedOutage || Math.random() < this.config.timeoutRate) {
      this.recordCall(false, Date.now() - startTime);
      return {
        success: false,
        providerCallId: null,
        error: this.forcedOutage ? 'PROVIDER_OUTAGE_DOWN' : 'GATEWAY_TIMEOUT_504',
      };
    }

    const providerCallId = `pb-${uuidv4().slice(0, 8)}`;
    this.sequenceCounters.set(callId, 0);
    this.recordCall(true, Date.now() - startTime);

    // Run simulated call lifecycle with duplicates & out-of-order events
    this.simulateAdversarialCall(callId, providerCallId);

    return { success: true, providerCallId };
  }

  async cancelCall(providerCallId: string): Promise<boolean> {
    return true;
  }

  onEvent(callback: TelecomEventCallback): void {
    this.callbacks.push(callback);
  }

  getHealth(): ProviderHealth {
    const windowMs = 60_000;
    const cutoff = Date.now() - windowMs;
    const recent = this.callHistory.filter(h => h.timestamp > cutoff);
    const failures = recent.filter(h => !h.success).length;
    const failureRate = recent.length > 0 ? failures / recent.length : 0;

    return {
      providerId: this.providerId,
      callsInWindow: recent.length,
      failuresInWindow: failures,
      failureRate,
      avgLatencyMs: recent.length > 0
        ? recent.reduce((sum, h) => sum + h.latencyMs, 0) / recent.length
        : 0,
      circuitBreakerOpen: this.forcedOutage || failureRate > 0.35,
    };
  }

  shutdown(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  // ─── Adversarial Simulation ───

  private simulateAdversarialCall(callId: string, providerCallId: string): void {
    const answers = Math.random() < this.config.answerRate;
    const isOutOfOrder = Math.random() < this.config.outOfOrderRate;

    const ringingDelay = this.scaled(this.randomBetween(...this.config.ringingDuration));
    const answerDelay = ringingDelay + this.scaled(this.randomBetween(500, 2500));
    const talkVariance = this.config.avgTalkTimeMs * 0.4;
    const talkDuration = this.scaled(this.config.avgTalkTimeMs + (Math.random() - 0.5) * 2 * talkVariance);
    const completedDelay = answerDelay + talkDuration;

    if (answers) {
      if (isOutOfOrder) {
        // Out-of-order scenario: Deliver COMPLETED first, then ANSWERED, then RINGING
        // System must handle this without corrupting terminal state
        const compTimer = setTimeout(() => {
          this.activeTimers.delete(compTimer);
          this.emitWithDuplicates(callId, providerCallId, TelecomEventType.COMPLETED, 3);

          const ansTimer = setTimeout(() => {
            this.activeTimers.delete(ansTimer);
            this.emitWithDuplicates(callId, providerCallId, TelecomEventType.ANSWERED, 2);

            const ringTimer = setTimeout(() => {
              this.activeTimers.delete(ringTimer);
              this.emitWithDuplicates(callId, providerCallId, TelecomEventType.RINGING, 1);
            }, this.scaled(50));
            this.activeTimers.add(ringTimer);
          }, this.scaled(50));
          this.activeTimers.add(ansTimer);
        }, ringingDelay);
        this.activeTimers.add(compTimer);
      } else {
        // Normal order with possible duplicate events
        const ringTimer = setTimeout(() => {
          this.activeTimers.delete(ringTimer);
          this.emitWithDuplicates(callId, providerCallId, TelecomEventType.RINGING, 1);

          const ansTimer = setTimeout(() => {
            this.activeTimers.delete(ansTimer);
            this.emitWithDuplicates(callId, providerCallId, TelecomEventType.ANSWERED, 2);

            const compTimer = setTimeout(() => {
              this.activeTimers.delete(compTimer);
              this.emitWithDuplicates(callId, providerCallId, TelecomEventType.COMPLETED, 3);
            }, talkDuration);
            this.activeTimers.add(compTimer);
          }, this.scaled(this.randomBetween(500, 2000)));
          this.activeTimers.add(ansTimer);
        }, ringingDelay);
        this.activeTimers.add(ringTimer);
      }
    } else {
      // Unanswered call: emits RINGING then TIMEOUT / NO_ANSWER
      const ringTimer = setTimeout(() => {
        this.activeTimers.delete(ringTimer);
        this.emitWithDuplicates(callId, providerCallId, TelecomEventType.RINGING, 1);

        const failTimer = setTimeout(() => {
          this.activeTimers.delete(failTimer);
          const failType = Math.random() < 0.5 ? TelecomEventType.NO_ANSWER : TelecomEventType.TIMEOUT;
          this.emitWithDuplicates(callId, providerCallId, failType, 2);
        }, this.scaled(this.randomBetween(6000, 14000)));
        this.activeTimers.add(failTimer);
      }, ringingDelay);
      this.activeTimers.add(ringTimer);
    }
  }

  private emitWithDuplicates(
    callId: string,
    providerCallId: string,
    type: TelecomEventType,
    explicitSequence?: number
  ): void {
    const seq = explicitSequence ?? ((this.sequenceCounters.get(callId) ?? 0) + 1);
    this.sequenceCounters.set(callId, seq);

    const eventId = `${providerCallId}-${type}-${seq}`;
    const baseEvent: TelecomEvent = {
      eventId,
      callId,
      providerCallId,
      type,
      sequence: seq,
      timestamp: Date.now(),
    };

    // Emit initial event
    this.broadcast(baseEvent);

    // Adversarial: with probability duplicateEventRate, emit the SAME event again 1-3 times
    if (Math.random() < this.config.duplicateEventRate) {
      const duplicateCount = Math.floor(Math.random() * 3) + 1;
      for (let i = 0; i < duplicateCount; i++) {
        const dupTimer = setTimeout(() => {
          this.activeTimers.delete(dupTimer);
          this.broadcast(baseEvent); // Identical eventId and sequence
        }, this.scaled(this.randomBetween(20, 150)));
        this.activeTimers.add(dupTimer);
      }
    }
  }

  private broadcast(event: TelecomEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch (err) {
        // Ignore consumer errors
      }
    }
  }

  private recordCall(success: boolean, latencyMs: number): void {
    this.callHistory.push({ timestamp: Date.now(), success, latencyMs });
    if (this.callHistory.length > 1000) {
      this.callHistory = this.callHistory.slice(-500);
    }
  }

  private scaled(ms: number): number {
    return Math.max(1, Math.round(ms * this.config.timeScale));
  }

  private randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.activeTimers.delete(timer);
        resolve();
      }, ms);
      this.activeTimers.add(timer);
    });
  }
}

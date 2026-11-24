/**
 * Mock Provider A — Fast & Reliable
 *
 * Characteristics:
 * - Low latency: 20-80ms for call placement
 * - Low failure rate: ~2%
 * - Events arrive in correct order
 * - No duplicate events
 * - Simulates realistic call flow: RINGING → ANSWERED → COMPLETED
 *   or RINGING → FAILED/NO_ANSWER
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

export interface MockProviderAConfig {
  /** Base answer rate (0-1). Default: depends on scenario */
  answerRate?: number;
  /** Average talk time in ms. Default: 90000 (90s) */
  avgTalkTimeMs?: number;
  /** Call placement latency range [min, max] ms. Default: [20, 80] */
  placementLatency?: [number, number];
  /** Ringing duration range [min, max] ms. Default: [3000, 8000] */
  ringingDuration?: [number, number];
  /** Failure rate for call placement (0-1). Default: 0.02 */
  failureRate?: number;
  /** Time scale factor for simulation (1 = real-time, 0.01 = 100x faster) */
  timeScale?: number;
}

export class MockProviderA implements TelecomProvider {
  readonly providerId = 'provider-a';
  private callbacks: TelecomEventCallback[] = [];
  private activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private sequenceCounters: Map<string, number> = new Map();
  private callHistory: { timestamp: number; success: boolean; latencyMs: number }[] = [];
  private config: Required<MockProviderAConfig>;

  constructor(config: MockProviderAConfig = {}) {
    this.config = {
      answerRate: config.answerRate ?? 0.5,
      avgTalkTimeMs: config.avgTalkTimeMs ?? 90_000,
      placementLatency: config.placementLatency ?? [20, 80],
      ringingDuration: config.ringingDuration ?? [3000, 8000],
      failureRate: config.failureRate ?? 0.02,
      timeScale: config.timeScale ?? 0.01,
    };
  }

  async placeCall(callId: string, phoneNumber: string): Promise<CallPlacementResult> {
    const startTime = Date.now();
    const [minLatency, maxLatency] = this.config.placementLatency;
    const latency = this.scaled(this.randomBetween(minLatency, maxLatency));

    // Simulate network latency
    await this.delay(latency);

    // Random failure on call placement
    if (Math.random() < this.config.failureRate) {
      this.recordCall(false, Date.now() - startTime);
      return { success: false, providerCallId: null, error: 'PROVIDER_ERROR' };
    }

    const providerCallId = `pa-${uuidv4().slice(0, 8)}`;
    this.sequenceCounters.set(callId, 0);
    this.recordCall(true, Date.now() - startTime);

    // Start the call simulation in background
    this.simulateCall(callId, providerCallId);

    return { success: true, providerCallId };
  }

  async cancelCall(providerCallId: string): Promise<boolean> {
    // In a real provider, this would send a SIP BYE or API call
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

    return {
      providerId: this.providerId,
      callsInWindow: recent.length,
      failuresInWindow: failures,
      failureRate: recent.length > 0 ? failures / recent.length : 0,
      avgLatencyMs: recent.length > 0
        ? recent.reduce((sum, h) => sum + h.latencyMs, 0) / recent.length
        : 0,
      circuitBreakerOpen: false,
    };
  }

  shutdown(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  /** Update answer rate dynamically (for Scenario D) */
  setAnswerRate(rate: number): void {
    this.config.answerRate = Math.max(0, Math.min(1, rate));
  }

  setAvgTalkTime(ms: number): void {
    this.config.avgTalkTimeMs = ms;
  }

  // ─── Internal ───

  private simulateCall(callId: string, providerCallId: string): void {
    const ringingDelay = this.scaled(
      this.randomBetween(...this.config.ringingDuration)
    );

    // Emit RINGING after a short delay
    const ringingTimer = setTimeout(() => {
      this.activeTimers.delete(ringingTimer);
      this.emit(callId, providerCallId, TelecomEventType.RINGING);

      // Determine if the borrower answers
      if (Math.random() < this.config.answerRate) {
        // Borrower answers
        const answerDelay = this.scaled(this.randomBetween(500, 2000));
        const answerTimer = setTimeout(() => {
          this.activeTimers.delete(answerTimer);
          this.emit(callId, providerCallId, TelecomEventType.ANSWERED);

          // Call duration then COMPLETED
          const talkVariance = this.config.avgTalkTimeMs * 0.3;
          const talkTime = this.scaled(
            this.config.avgTalkTimeMs + (Math.random() - 0.5) * 2 * talkVariance
          );
          const completedTimer = setTimeout(() => {
            this.activeTimers.delete(completedTimer);
            this.emit(callId, providerCallId, TelecomEventType.COMPLETED);
          }, talkTime);
          this.activeTimers.add(completedTimer);
        }, answerDelay);
        this.activeTimers.add(answerTimer);
      } else {
        // Borrower doesn't answer — ring for a while then NO_ANSWER/FAILED
        const noAnswerDelay = this.scaled(this.randomBetween(8000, 15000));
        const failTimer = setTimeout(() => {
          this.activeTimers.delete(failTimer);
          const eventType = Math.random() < 0.3
            ? TelecomEventType.BUSY
            : TelecomEventType.NO_ANSWER;
          this.emit(callId, providerCallId, eventType);
        }, noAnswerDelay);
        this.activeTimers.add(failTimer);
      }
    }, ringingDelay);
    this.activeTimers.add(ringingTimer);
  }

  private emit(callId: string, providerCallId: string, type: TelecomEventType): void {
    const seq = (this.sequenceCounters.get(callId) ?? 0) + 1;
    this.sequenceCounters.set(callId, seq);

    const event: TelecomEvent = {
      eventId: `${providerCallId}-${type}-${seq}`,
      callId,
      providerCallId,
      type,
      sequence: seq,
      timestamp: Date.now(),
    };

    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch (err) {
        // Don't let callback errors crash the provider
      }
    }
  }

  private recordCall(success: boolean, latencyMs: number): void {
    this.callHistory.push({ timestamp: Date.now(), success, latencyMs });
    // Keep only recent history
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

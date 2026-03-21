/**
 * MarketEventBus — Event-driven market event detection and dispatch
 *
 * Detects price spikes, volume surges, OI shifts, and funding anomalies
 * from market snapshot comparisons. Supports typed listeners, priority levels,
 * cooldown-based deduplication, and bounded event history.
 */

import type { MarketSnapshot } from './types.js';

// ─── Event Types ────────────────────────────────────────────────────────────

export enum MarketEventType {
  /** Price moved > threshold between ticks */
  PRICE_SPIKE = 'PRICE_SPIKE',
  /** Volume exceeds 2x rolling average */
  VOLUME_SURGE = 'VOLUME_SURGE',
  /** OI long/short ratio shifted significantly */
  OI_SHIFT = 'OI_SHIFT',
  /** Funding rate exceeds anomaly threshold */
  FUNDING_ANOMALY = 'FUNDING_ANOMALY',
}

export enum EventPriority {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
}

// ─── Event Interfaces ───────────────────────────────────────────────────────

export interface MarketEvent {
  /** Unique event ID */
  id: string;
  /** Which market triggered this */
  market: string;
  /** Event classification */
  type: MarketEventType;
  /** Priority level */
  priority: EventPriority;
  /** Magnitude of the change (absolute, normalized) */
  magnitude: number;
  /** When the event was detected */
  timestamp: number;
  /** Snapshot at the time of detection */
  snapshot: MarketSnapshot;
  /** Human-readable description */
  description: string;
}

export type MarketEventListener = (event: MarketEvent) => void;

// ─── Threshold Configuration ────────────────────────────────────────────────

export interface EventThresholds {
  /** Price change % to trigger PRICE_SPIKE (default 0.5%) */
  priceSpikePct: number;
  /** Volume multiplier over rolling average for VOLUME_SURGE (default 2.0) */
  volumeSurgeMultiplier: number;
  /** OI ratio change % to trigger OI_SHIFT (default 5%) */
  oiShiftPct: number;
  /** Funding rate threshold for FUNDING_ANOMALY in decimal (default 0.0001 = 0.01%) */
  fundingAnomalyRate: number;
  /** Cooldown per market+type in ms to deduplicate (default 60_000) */
  cooldownMs: number;
  /** Rolling volume window size for average calculation */
  volumeWindowSize: number;
}

const DEFAULT_THRESHOLDS: EventThresholds = {
  priceSpikePct: 0.5,
  volumeSurgeMultiplier: 2.0,
  oiShiftPct: 5.0,
  fundingAnomalyRate: 0.0001,
  cooldownMs: 60_000,
  volumeWindowSize: 20,
};

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HISTORY = 500;

// ─── MarketEventBus ─────────────────────────────────────────────────────────

export class MarketEventBus {
  private readonly listeners: Map<MarketEventType, Set<MarketEventListener>> = new Map();
  private readonly globalListeners: Set<MarketEventListener> = new Set();
  private readonly history: MarketEvent[] = [];
  private readonly cooldowns: Map<string, number> = new Map();
  private readonly volumeHistory: Map<string, number[]> = new Map();
  private readonly thresholds: EventThresholds;
  private eventCounter = 0;

  constructor(thresholds?: Partial<EventThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

    // Initialize listener sets for each event type
    for (const type of Object.values(MarketEventType)) {
      this.listeners.set(type, new Set());
    }
  }

  // ─── Subscribe / Unsubscribe ────────────────────────────────────────────

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function for convenience.
   */
  subscribe(type: MarketEventType, listener: MarketEventListener): () => void {
    const set = this.listeners.get(type);
    if (set) {
      set.add(listener);
    }
    return () => this.unsubscribe(type, listener);
  }

  /** Unsubscribe a listener from a specific event type. */
  unsubscribe(type: MarketEventType, listener: MarketEventListener): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
    }
  }

  /**
   * Subscribe to ALL event types.
   * Returns an unsubscribe function.
   */
  subscribeAll(listener: MarketEventListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /** Unsubscribe a global listener. */
  unsubscribeAll(listener: MarketEventListener): void {
    this.globalListeners.delete(listener);
  }

  // ─── Emit ───────────────────────────────────────────────────────────────

  /** Emit an event to all matching listeners. Returns true if emitted (not deduped). */
  emit(event: Omit<MarketEvent, 'id'>): boolean {
    const cooldownKey = `${event.market}:${event.type}`;
    const now = Date.now();
    const lastEmit = this.cooldowns.get(cooldownKey);

    // Deduplicate within cooldown window
    if (lastEmit !== undefined && now - lastEmit < this.thresholds.cooldownMs) {
      return false;
    }

    const fullEvent: MarketEvent = {
      ...event,
      id: this.generateId(),
    };

    // Record cooldown
    this.cooldowns.set(cooldownKey, now);

    // Add to history (bounded)
    this.history.push(fullEvent);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }

    // Dispatch to type-specific listeners
    const typeListeners = this.listeners.get(fullEvent.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(fullEvent);
        } catch {
          // Listener errors must not crash the bus
        }
      }
    }

    // Dispatch to global listeners
    for (const listener of this.globalListeners) {
      try {
        listener(fullEvent);
      } catch {
        // Listener errors must not crash the bus
      }
    }

    return true;
  }

  // ─── Detection Engine ───────────────────────────────────────────────────

  /**
   * Compare current snapshots against previous snapshots and emit events
   * for any detected anomalies. Returns the list of events emitted.
   */
  detectAll(
    snapshots: MarketSnapshot[],
    prevSnapshots: MarketSnapshot[],
  ): MarketEvent[] {
    const prevMap = new Map<string, MarketSnapshot>();
    for (const snap of prevSnapshots) {
      prevMap.set(snap.market, snap);
    }

    const emitted: MarketEvent[] = [];

    for (const snap of snapshots) {
      const prev = prevMap.get(snap.market);
      if (!prev) continue;

      // Update volume history for rolling average
      this.recordVolume(snap.market, snap.volume24h);

      // PRICE_SPIKE detection
      const priceEvent = this.detectPriceSpike(snap, prev);
      if (priceEvent) {
        if (this.emit(priceEvent)) {
          emitted.push({ ...priceEvent, id: this.lastEventId() });
        }
      }

      // VOLUME_SURGE detection
      const volumeEvent = this.detectVolumeSurge(snap);
      if (volumeEvent) {
        if (this.emit(volumeEvent)) {
          emitted.push({ ...volumeEvent, id: this.lastEventId() });
        }
      }

      // OI_SHIFT detection
      const oiEvent = this.detectOiShift(snap, prev);
      if (oiEvent) {
        if (this.emit(oiEvent)) {
          emitted.push({ ...oiEvent, id: this.lastEventId() });
        }
      }

      // FUNDING_ANOMALY detection
      const fundingEvent = this.detectFundingAnomaly(snap);
      if (fundingEvent) {
        if (this.emit(fundingEvent)) {
          emitted.push({ ...fundingEvent, id: this.lastEventId() });
        }
      }
    }

    return emitted;
  }

  // ─── Individual Detectors ───────────────────────────────────────────────

  private detectPriceSpike(
    snap: MarketSnapshot,
    prev: MarketSnapshot,
  ): Omit<MarketEvent, 'id'> | null {
    if (!Number.isFinite(snap.price) || !Number.isFinite(prev.price) || prev.price === 0) {
      return null;
    }

    const changePct = Math.abs((snap.price - prev.price) / prev.price) * 100;

    if (changePct <= this.thresholds.priceSpikePct) {
      return null;
    }

    const priority = changePct > this.thresholds.priceSpikePct * 4
      ? EventPriority.CRITICAL
      : changePct > this.thresholds.priceSpikePct * 2
        ? EventPriority.HIGH
        : EventPriority.NORMAL;

    const direction = snap.price > prev.price ? 'up' : 'down';

    return {
      market: snap.market,
      type: MarketEventType.PRICE_SPIKE,
      priority,
      magnitude: changePct,
      timestamp: snap.timestamp,
      snapshot: snap,
      description: `${snap.market} price spike ${direction} ${changePct.toFixed(2)}% ($${prev.price.toFixed(2)} -> $${snap.price.toFixed(2)})`,
    };
  }

  private detectVolumeSurge(snap: MarketSnapshot): Omit<MarketEvent, 'id'> | null {
    if (!Number.isFinite(snap.volume24h) || snap.volume24h <= 0) {
      return null;
    }

    const avg = this.getRollingVolumeAverage(snap.market);
    if (avg <= 0) {
      return null;
    }

    const multiplier = snap.volume24h / avg;

    if (multiplier <= this.thresholds.volumeSurgeMultiplier) {
      return null;
    }

    const priority = multiplier > this.thresholds.volumeSurgeMultiplier * 3
      ? EventPriority.CRITICAL
      : multiplier > this.thresholds.volumeSurgeMultiplier * 2
        ? EventPriority.HIGH
        : EventPriority.NORMAL;

    return {
      market: snap.market,
      type: MarketEventType.VOLUME_SURGE,
      priority,
      magnitude: multiplier,
      timestamp: snap.timestamp,
      snapshot: snap,
      description: `${snap.market} volume surge ${multiplier.toFixed(1)}x rolling average ($${(snap.volume24h / 1e6).toFixed(1)}M vs avg $${(avg / 1e6).toFixed(1)}M)`,
    };
  }

  private detectOiShift(
    snap: MarketSnapshot,
    prev: MarketSnapshot,
  ): Omit<MarketEvent, 'id'> | null {
    if (!Number.isFinite(snap.oiRatio) || !Number.isFinite(prev.oiRatio) || prev.oiRatio === 0) {
      return null;
    }

    const changePct = Math.abs(snap.oiRatio - prev.oiRatio) * 100;

    if (changePct <= this.thresholds.oiShiftPct) {
      return null;
    }

    const direction = snap.oiRatio > prev.oiRatio ? 'long-heavy' : 'short-heavy';

    const priority = changePct > this.thresholds.oiShiftPct * 3
      ? EventPriority.CRITICAL
      : changePct > this.thresholds.oiShiftPct * 1.5
        ? EventPriority.HIGH
        : EventPriority.NORMAL;

    return {
      market: snap.market,
      type: MarketEventType.OI_SHIFT,
      priority,
      magnitude: changePct,
      timestamp: snap.timestamp,
      snapshot: snap,
      description: `${snap.market} OI shift ${direction} by ${changePct.toFixed(1)}% (ratio ${prev.oiRatio.toFixed(3)} -> ${snap.oiRatio.toFixed(3)})`,
    };
  }

  private detectFundingAnomaly(snap: MarketSnapshot): Omit<MarketEvent, 'id'> | null {
    if (snap.fundingRate === undefined || !Number.isFinite(snap.fundingRate)) {
      return null;
    }

    const absRate = Math.abs(snap.fundingRate);

    if (absRate <= this.thresholds.fundingAnomalyRate) {
      return null;
    }

    const direction = snap.fundingRate > 0 ? 'longs pay' : 'shorts pay';

    const priority = absRate > this.thresholds.fundingAnomalyRate * 5
      ? EventPriority.CRITICAL
      : absRate > this.thresholds.fundingAnomalyRate * 2
        ? EventPriority.HIGH
        : EventPriority.NORMAL;

    return {
      market: snap.market,
      type: MarketEventType.FUNDING_ANOMALY,
      priority,
      magnitude: absRate,
      timestamp: snap.timestamp,
      snapshot: snap,
      description: `${snap.market} funding anomaly: ${(snap.fundingRate * 100).toFixed(4)}% (${direction})`,
    };
  }

  // ─── Volume Rolling Average ─────────────────────────────────────────────

  private recordVolume(market: string, volume: number): void {
    if (!Number.isFinite(volume) || volume <= 0) return;

    let history = this.volumeHistory.get(market);
    if (!history) {
      history = [];
      this.volumeHistory.set(market, history);
    }

    history.push(volume);

    // Bound the rolling window
    if (history.length > this.thresholds.volumeWindowSize) {
      history.splice(0, history.length - this.thresholds.volumeWindowSize);
    }
  }

  private getRollingVolumeAverage(market: string): number {
    const history = this.volumeHistory.get(market);
    if (!history || history.length < 2) return 0;

    // Exclude the latest entry (current tick) from the average
    let sum = 0;
    for (let i = 0; i < history.length - 1; i++) {
      sum += history[i];
    }
    return sum / (history.length - 1);
  }

  // ─── History & Analytics ────────────────────────────────────────────────

  /** Get full event history (most recent last). */
  getHistory(): readonly MarketEvent[] {
    return this.history;
  }

  /** Get events filtered by type. */
  getHistoryByType(type: MarketEventType): MarketEvent[] {
    return this.history.filter((e) => e.type === type);
  }

  /** Get events filtered by market. */
  getHistoryByMarket(market: string): MarketEvent[] {
    return this.history.filter((e) => e.market === market);
  }

  /** Get events filtered by priority. */
  getHistoryByPriority(priority: EventPriority): MarketEvent[] {
    return this.history.filter((e) => e.priority === priority);
  }

  /** Get events within a time range. */
  getHistoryInRange(startMs: number, endMs: number): MarketEvent[] {
    return this.history.filter((e) => e.timestamp >= startMs && e.timestamp <= endMs);
  }

  /** Count events by type (for analytics). */
  getEventCounts(): Record<MarketEventType, number> {
    const counts = {} as Record<MarketEventType, number>;
    for (const type of Object.values(MarketEventType)) {
      counts[type] = 0;
    }
    for (const event of this.history) {
      counts[event.type]++;
    }
    return counts;
  }

  /** Get current thresholds (read-only copy). */
  getThresholds(): Readonly<EventThresholds> {
    return { ...this.thresholds };
  }

  /** Update thresholds at runtime. */
  updateThresholds(partial: Partial<EventThresholds>): void {
    Object.assign(this.thresholds, partial);
  }

  /** Clear all event history and cooldowns. */
  clear(): void {
    this.history.length = 0;
    this.cooldowns.clear();
    this.volumeHistory.clear();
    this.eventCounter = 0;
  }

  /** Get listener count for diagnostics. */
  getListenerCount(): { typed: number; global: number } {
    let typed = 0;
    for (const set of this.listeners.values()) {
      typed += set.size;
    }
    return { typed, global: this.globalListeners.size };
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  private generateId(): string {
    this.eventCounter++;
    return `evt_${Date.now()}_${this.eventCounter}`;
  }

  private lastEventId(): string {
    return this.history.length > 0
      ? this.history[this.history.length - 1].id
      : '';
  }
}

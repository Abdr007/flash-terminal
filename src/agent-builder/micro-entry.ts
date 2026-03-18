/**
 * Micro-Entry Logic — Precision entry timing.
 *
 * Instead of entering immediately on signal, wait for optimal micro-conditions:
 * 1. Pullback entry: price retraces toward better entry
 * 2. Momentum burst: price accelerates in signal direction
 * 3. Avoid local extremes: don't buy at tick high, don't sell at tick low
 *
 * Uses price history from the last N ticks to detect micro-patterns.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type EntryQuality = 'excellent' | 'good' | 'fair' | 'poor';

export interface MicroEntryCheck {
  quality: EntryQuality;
  /** Score 0-1 */
  score: number;
  /** Should we enter now? */
  enterNow: boolean;
  reason: string;
}

// ─── Micro-Entry Analyzer ────────────────────────────────────────────────────

export class MicroEntryAnalyzer {
  private priceHistory: Map<string, number[]> = new Map();
  private readonly windowSize = 10; // Last 10 ticks (~100s at 10s polling)

  /**
   * Record price tick.
   */
  record(market: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const h = this.priceHistory.get(market) ?? [];
    h.push(price);
    if (h.length > this.windowSize) h.shift();
    this.priceHistory.set(market, h);
  }

  /**
   * Check if current price is good for entry.
   */
  check(market: string, side: 'long' | 'short', currentPrice: number): MicroEntryCheck {
    const prices = this.priceHistory.get(market);
    if (!prices || prices.length < 3) {
      return { quality: 'fair', score: 0.5, enterNow: true, reason: 'Insufficient history' };
    }

    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const range = high - low;

    // If range is zero (flat), entry is fine
    if (range <= 0) {
      return { quality: 'fair', score: 0.5, enterNow: true, reason: 'Flat range' };
    }

    const positionInRange = (currentPrice - low) / range; // 0 = at low, 1 = at high

    // Calculate momentum (last 3 ticks direction)
    const recent3 = prices.slice(-3);
    const momentum = recent3.length >= 3 ? (recent3[2] - recent3[0]) / recent3[0] * 100 : 0;

    if (side === 'long') {
      // For longs: best entry is on a pullback (price near range low)
      if (positionInRange <= 0.3 && momentum <= 0) {
        // Pullback entry — price pulled back and near low
        return { quality: 'excellent', score: 0.9, enterNow: true, reason: 'Pullback to support' };
      }
      if (positionInRange <= 0.5) {
        return { quality: 'good', score: 0.7, enterNow: true, reason: 'Lower half of range' };
      }
      if (positionInRange >= 0.9) {
        // At tick high — worst long entry
        return { quality: 'poor', score: 0.2, enterNow: false, reason: 'At local high — wait for pullback' };
      }
      if (momentum > 0.3) {
        // Strong upward momentum — momentum burst entry
        return { quality: 'good', score: 0.65, enterNow: true, reason: 'Momentum burst up' };
      }
      return { quality: 'fair', score: 0.5, enterNow: true, reason: 'Mid-range' };
    } else {
      // For shorts: best entry is on a bounce (price near range high)
      if (positionInRange >= 0.7 && momentum >= 0) {
        return { quality: 'excellent', score: 0.9, enterNow: true, reason: 'Bounce at resistance' };
      }
      if (positionInRange >= 0.5) {
        return { quality: 'good', score: 0.7, enterNow: true, reason: 'Upper half of range' };
      }
      if (positionInRange <= 0.1) {
        return { quality: 'poor', score: 0.2, enterNow: false, reason: 'At local low — wait for bounce' };
      }
      if (momentum < -0.3) {
        return { quality: 'good', score: 0.65, enterNow: true, reason: 'Momentum burst down' };
      }
      return { quality: 'fair', score: 0.5, enterNow: true, reason: 'Mid-range' };
    }
  }

  reset(): void {
    this.priceHistory.clear();
  }
}

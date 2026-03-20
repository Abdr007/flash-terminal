/**
 * Counterfactual Tracker — Learn from roads not taken.
 *
 * For every skipped trade opportunity, record what WOULD have happened.
 * Compare actual decisions vs alternatives to improve future filtering.
 *
 * This is how the best quant systems improve — they don't just learn
 * from trades taken, they learn from trades NOT taken.
 */

import type { MarketSnapshot } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CounterfactualRecord {
  market: string;
  side: 'long' | 'short';
  entryPrice: number;
  score: number;
  reason: string;
  strategy: string;
  timestamp: number;
  /** Filled in later when we check outcome */
  outcomePrice?: number;
  outcomePnlPct?: number;
  wouldHaveWon?: boolean;
}

export interface CounterfactualInsight {
  /** Trades we skipped that would have won */
  missedWins: number;
  /** Trades we skipped that would have lost */
  correctSkips: number;
  /** Skip accuracy: correctSkips / total */
  skipAccuracy: number;
  /** Average missed profit % */
  avgMissedProfitPct: number;
  /** Average avoided loss % */
  avgAvoidedLossPct: number;
  /** Filters that rejected the most winners (need loosening) */
  overFilteredReasons: Array<{ reason: string; missedWins: number }>;
  /** Filters that correctly rejected the most losers (working well) */
  effectiveFilters: Array<{ reason: string; correctSkips: number }>;
}

// ─── Counterfactual Tracker ──────────────────────────────────────────────────

export class CounterfactualTracker {
  private records: CounterfactualRecord[] = [];
  private readonly maxRecords = 200;
  private readonly evaluateAfterTicks = 5; // Check outcome after 5 ticks (~50s)
  /** Half-life for counterfactual insights in ms (2 hours) */
  private readonly insightHalfLifeMs = 7_200_000;

  /**
   * Record a skipped trade opportunity.
   */
  recordSkip(
    market: string,
    side: 'long' | 'short',
    entryPrice: number,
    score: number,
    reason: string,
    strategy: string,
  ): void {
    this.records.push({
      market, side, entryPrice, score, reason, strategy, timestamp: Date.now(),
    });
    if (this.records.length > this.maxRecords) this.records.shift();
  }

  /**
   * Evaluate skipped trades against current prices.
   * Call every tick with current market snapshots.
   */
  evaluate(snapshots: MarketSnapshot[]): void {
    const now = Date.now();
    const priceMap = new Map(snapshots.map((s) => [s.market, s.price]));

    for (const record of this.records) {
      if (record.outcomePrice !== undefined) continue; // Already evaluated
      if (now - record.timestamp < this.evaluateAfterTicks * 10_000) continue; // Too soon

      const currentPrice = priceMap.get(record.market);
      if (!currentPrice || !Number.isFinite(currentPrice)) continue;

      record.outcomePrice = currentPrice;
      const priceDiff = currentPrice - record.entryPrice;
      const pnlPct = record.side === 'long'
        ? (priceDiff / record.entryPrice) * 100
        : (-priceDiff / record.entryPrice) * 100;

      record.outcomePnlPct = pnlPct;
      // Consider it a "win" if it moved >0.3% in favor (accounting for fees)
      record.wouldHaveWon = pnlPct > 0.3;
    }
  }

  /**
   * Analyze all evaluated records and produce insights.
   */
  getInsights(): CounterfactualInsight {
    const evaluated = this.records.filter((r) => r.wouldHaveWon !== undefined);
    if (evaluated.length === 0) {
      return {
        missedWins: 0, correctSkips: 0, skipAccuracy: 1,
        avgMissedProfitPct: 0, avgAvoidedLossPct: 0,
        overFilteredReasons: [], effectiveFilters: [],
      };
    }

    const missedWins = evaluated.filter((r) => r.wouldHaveWon === true);
    const correctSkips = evaluated.filter((r) => r.wouldHaveWon === false);

    const skipAccuracy = evaluated.length > 0 ? correctSkips.length / evaluated.length : 1;

    const avgMissedProfitPct = missedWins.length > 0
      ? missedWins.reduce((s, r) => s + (r.outcomePnlPct ?? 0), 0) / missedWins.length : 0;

    const avgAvoidedLossPct = correctSkips.length > 0
      ? Math.abs(correctSkips.reduce((s, r) => s + (r.outcomePnlPct ?? 0), 0) / correctSkips.length) : 0;

    // Analyze which rejection reasons missed the most winners
    const reasonMissed = new Map<string, number>();
    const reasonCorrect = new Map<string, number>();
    for (const r of missedWins) {
      reasonMissed.set(r.reason, (reasonMissed.get(r.reason) ?? 0) + 1);
    }
    for (const r of correctSkips) {
      reasonCorrect.set(r.reason, (reasonCorrect.get(r.reason) ?? 0) + 1);
    }

    const overFilteredReasons = Array.from(reasonMissed.entries())
      .map(([reason, count]) => ({ reason, missedWins: count }))
      .sort((a, b) => b.missedWins - a.missedWins)
      .slice(0, 5);

    const effectiveFilters = Array.from(reasonCorrect.entries())
      .map(([reason, count]) => ({ reason, correctSkips: count }))
      .sort((a, b) => b.correctSkips - a.correctSkips)
      .slice(0, 5);

    return {
      missedWins: missedWins.length,
      correctSkips: correctSkips.length,
      skipAccuracy,
      avgMissedProfitPct,
      avgAvoidedLossPct,
      overFilteredReasons,
      effectiveFilters,
    };
  }

  /**
   * Should the system loosen a specific filter?
   * Returns true if that filter is rejecting too many winners.
   * Applies exponential decay — old insights carry less weight.
   */
  isOverFiltering(reason: string, threshold = 0.6): boolean {
    const now = Date.now();
    const evaluated = this.records.filter((r) => r.reason === reason && r.wouldHaveWon !== undefined);
    if (evaluated.length < 10) return false; // Require 10 samples (not 5) to prevent overfitting

    // Weighted count with exponential decay
    let weightedMissed = 0;
    let weightedTotal = 0;
    for (const r of evaluated) {
      const age = now - r.timestamp;
      const weight = Math.pow(0.5, age / this.insightHalfLifeMs); // Half-life decay
      weightedTotal += weight;
      if (r.wouldHaveWon === true) weightedMissed += weight;
    }

    return weightedTotal > 0 && (weightedMissed / weightedTotal) > threshold;
  }

  reset(): void {
    this.records = [];
  }
}

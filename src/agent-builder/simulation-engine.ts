/**
 * Simulation Engine — Learn from parallel simulated trades.
 *
 * Runs "shadow" trades alongside real ones:
 * - Every scored opportunity gets a simulated outcome
 * - Compare simulated vs actual to improve faster
 * - Learn without risking capital
 *
 * This 10x's the learning speed — every tick teaches something,
 * even when no real trade is executed.
 */

import type { MarketSnapshot } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SimulatedTrade {
  market: string;
  side: 'long' | 'short';
  entryPrice: number;
  score: number;
  strategy: string;
  regime: string;
  confidence: number;
  timestamp: number;
  /** Resolved after N ticks */
  exitPrice?: number;
  pnlPct?: number;
  resolved?: boolean;
}

export interface SimulationInsight {
  totalSimulated: number;
  resolved: number;
  simWins: number;
  simLosses: number;
  simWinRate: number;
  avgSimPnlPct: number;
  /** Best simulated strategy */
  bestStrategy: { name: string; winRate: number; avgPnl: number } | null;
  /** Score threshold that maximizes simulated returns */
  optimalThreshold: number;
}

// ─── Simulation Engine ───────────────────────────────────────────────────────

export class SimulationEngine {
  private trades: SimulatedTrade[] = [];
  private readonly maxTrades = 300;
  private readonly resolveAfterTicks = 8; // ~80s at 10s polling

  /**
   * Record a simulated trade from a scored opportunity.
   * Called for EVERY opportunity that passes the ensemble, even if not executed.
   */
  simulate(
    market: string,
    side: 'long' | 'short',
    entryPrice: number,
    score: number,
    strategy: string,
    regime: string,
    confidence: number,
  ): void {
    this.trades.push({
      market, side, entryPrice, score, strategy, regime, confidence, timestamp: Date.now(),
    });
    if (this.trades.length > this.maxTrades) this.trades.shift();
  }

  /**
   * Resolve simulated trades against current prices.
   * Call every tick.
   */
  resolve(snapshots: MarketSnapshot[]): void {
    const now = Date.now();
    const priceMap = new Map(snapshots.map((s) => [s.market, s.price]));

    for (const trade of this.trades) {
      if (trade.resolved) continue;
      if (now - trade.timestamp < this.resolveAfterTicks * 10_000) continue;

      const currentPrice = priceMap.get(trade.market);
      if (!currentPrice || !Number.isFinite(currentPrice)) continue;

      trade.exitPrice = currentPrice;
      const diff = currentPrice - trade.entryPrice;
      trade.pnlPct = trade.side === 'long'
        ? (diff / trade.entryPrice) * 100
        : (-diff / trade.entryPrice) * 100;
      trade.resolved = true;
    }
  }

  /**
   * Get insights from simulation results.
   * Includes the optimal score threshold that would have maximized returns.
   */
  getInsights(): SimulationInsight {
    const resolved = this.trades.filter((t) => t.resolved);
    if (resolved.length === 0) {
      return {
        totalSimulated: this.trades.length, resolved: 0,
        simWins: 0, simLosses: 0, simWinRate: 0, avgSimPnlPct: 0,
        bestStrategy: null, optimalThreshold: 65,
      };
    }

    const wins = resolved.filter((t) => (t.pnlPct ?? 0) > 0.3); // Win = >0.3% after costs
    const losses = resolved.filter((t) => (t.pnlPct ?? 0) <= 0);
    const avgPnl = resolved.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / resolved.length;

    // Find best strategy
    const stratPerf = new Map<string, { wins: number; total: number; pnlSum: number }>();
    for (const t of resolved) {
      const sp = stratPerf.get(t.strategy) ?? { wins: 0, total: 0, pnlSum: 0 };
      sp.total++;
      if ((t.pnlPct ?? 0) > 0.3) sp.wins++;
      sp.pnlSum += t.pnlPct ?? 0;
      stratPerf.set(t.strategy, sp);
    }

    let bestStrategy: SimulationInsight['bestStrategy'] = null;
    for (const [name, sp] of stratPerf) {
      if (sp.total < 3) continue;
      const wr = sp.wins / sp.total;
      const avg = sp.pnlSum / sp.total;
      if (!bestStrategy || avg > bestStrategy.avgPnl) {
        bestStrategy = { name, winRate: wr, avgPnl: avg };
      }
    }

    // Find optimal score threshold (backtest different thresholds)
    let bestThreshold = 65;
    let bestThresholdReturn = -Infinity;
    for (let threshold = 40; threshold <= 85; threshold += 5) {
      const aboveThreshold = resolved.filter((t) => t.score >= threshold);
      if (aboveThreshold.length < 3) continue;
      const avgReturn = aboveThreshold.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / aboveThreshold.length;
      if (avgReturn > bestThresholdReturn) {
        bestThresholdReturn = avgReturn;
        bestThreshold = threshold;
      }
    }

    return {
      totalSimulated: this.trades.length,
      resolved: resolved.length,
      simWins: wins.length,
      simLosses: losses.length,
      simWinRate: resolved.length > 0 ? wins.length / resolved.length : 0,
      avgSimPnlPct: avgPnl,
      bestStrategy,
      optimalThreshold: bestThreshold,
    };
  }

  reset(): void {
    this.trades = [];
  }
}

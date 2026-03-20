/**
 * Expectancy Engine — Only take statistically favorable trades.
 *
 * EV = (winRate × avgWin) - ((1 - winRate) × avgLoss)
 *
 * If EV ≤ 0, the trade is rejected regardless of signal strength.
 * This is the single most important filter for long-term profitability.
 *
 * Also tracks per-strategy and per-signal performance for adaptive weighting.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StrategyStats {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  ev: number;
  profitFactor: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  disabled: boolean;
  disabledReason?: string;
  /** Performance weight 0-2 (1.0 = baseline) */
  weight: number;
  /** Recent PnL values for rolling window */
  recentPnl: number[];
}

export interface EVDecision {
  allowed: boolean;
  ev: number;
  reason: string;
  strategyWeight: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLLING_WINDOW = 20;
const MIN_TRADES_FOR_EV = 8;
const MIN_CONFIDENCE_NO_HISTORY = 0.75;
const DISABLE_CONSECUTIVE_LOSSES = 5;
const DISABLE_WIN_RATE = 0.35;
const RE_ENABLE_COOLDOWN_TRADES = 3; // Trades by other strategies before re-check

// ─── Expectancy Engine ───────────────────────────────────────────────────────

export class ExpectancyEngine {
  private strategies: Map<string, StrategyStats> = new Map();
  private globalTrades = 0;

  /**
   * Check if a trade should be taken based on expected value.
   */
  checkEV(strategyName: string, confidence: number): EVDecision {
    const stats = this.strategies.get(strategyName);

    // No history — allow only high-confidence trades
    if (!stats || stats.trades < MIN_TRADES_FOR_EV) {
      if (confidence >= MIN_CONFIDENCE_NO_HISTORY) {
        return { allowed: true, ev: 0, reason: `No EV history (${stats?.trades ?? 0}/${MIN_TRADES_FOR_EV} trades) — allowing high-conf ${(confidence * 100).toFixed(0)}%`, strategyWeight: 1.0 };
      }
      return { allowed: false, ev: 0, reason: `No EV history + low confidence ${(confidence * 100).toFixed(0)}% < ${(MIN_CONFIDENCE_NO_HISTORY * 100).toFixed(0)}%`, strategyWeight: 0.5 };
    }

    // Strategy disabled
    if (stats.disabled) {
      return { allowed: false, ev: stats.ev, reason: `Strategy disabled: ${stats.disabledReason}`, strategyWeight: 0 };
    }

    // EV check
    if (stats.ev <= 0) {
      return { allowed: false, ev: stats.ev, reason: `Negative EV: ${stats.ev.toFixed(2)} (WR=${(stats.winRate * 100).toFixed(0)}% avgW=${stats.avgWin.toFixed(2)} avgL=${stats.avgLoss.toFixed(2)})`, strategyWeight: 0.3 };
    }

    return { allowed: true, ev: stats.ev, reason: `EV=${stats.ev.toFixed(2)} WR=${(stats.winRate * 100).toFixed(0)}%`, strategyWeight: stats.weight };
  }

  /**
   * Record a trade outcome and update all stats.
   */
  recordTrade(strategyName: string, pnl: number): void {
    const stats = this.getOrCreate(strategyName);
    this.globalTrades++;

    stats.trades++;
    stats.recentPnl.push(pnl);
    if (stats.recentPnl.length > ROLLING_WINDOW) stats.recentPnl.shift();

    if (pnl > 0) {
      stats.wins++;
      stats.consecutiveLosses = 0;
    } else {
      stats.losses++;
      stats.consecutiveLosses++;
      stats.maxConsecutiveLosses = Math.max(stats.maxConsecutiveLosses, stats.consecutiveLosses);
    }

    // Recompute rolling stats
    this.recomputeStats(stats);

    // Auto-disable check
    if (stats.trades >= MIN_TRADES_FOR_EV) {
      if (stats.consecutiveLosses >= DISABLE_CONSECUTIVE_LOSSES) {
        stats.disabled = true;
        stats.disabledReason = `${stats.consecutiveLosses} consecutive losses`;
      } else if (stats.winRate < DISABLE_WIN_RATE) {
        stats.disabled = true;
        stats.disabledReason = `Win rate ${(stats.winRate * 100).toFixed(0)}% below ${(DISABLE_WIN_RATE * 100).toFixed(0)}%`;
      }
    }

    // Re-enable check (after other strategies have traded)
    if (stats.disabled && this.globalTrades % RE_ENABLE_COOLDOWN_TRADES === 0) {
      // Recheck with recent window only
      const recentWins = stats.recentPnl.filter((p) => p > 0).length;
      const recentWR = stats.recentPnl.length > 0 ? recentWins / stats.recentPnl.length : 0;
      if (recentWR >= 0.45 && stats.consecutiveLosses < 3) {
        stats.disabled = false;
        stats.disabledReason = undefined;
      }
    }
  }

  /**
   * Get system-wide EV across all strategies.
   */
  getSystemEV(): number {
    let totalEV = 0;
    let count = 0;
    for (const stats of this.strategies.values()) {
      if (stats.trades >= MIN_TRADES_FOR_EV) {
        totalEV += stats.ev;
        count++;
      }
    }
    return count > 0 ? totalEV / count : 0;
  }

  /**
   * Get all strategy stats for reporting.
   */
  getAllStats(): StrategyStats[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get performance weight for ensemble voting.
   */
  getWeight(strategyName: string): number {
    return this.strategies.get(strategyName)?.weight ?? 1.0;
  }

  // ─── Serialization ──────────────────────────────────────────────────

  serialize(): { strategies: StrategyStats[]; globalTrades: number } {
    return {
      strategies: Array.from(this.strategies.values()).map(s => ({ ...s, recentPnl: [...s.recentPnl] })),
      globalTrades: this.globalTrades,
    };
  }

  restore(data: { strategies: StrategyStats[]; globalTrades: number }): void {
    if (!data || !Array.isArray(data.strategies)) return;
    this.strategies.clear();
    for (const s of data.strategies) {
      if (s.name && typeof s.trades === 'number') {
        this.strategies.set(s.name, {
          ...s,
          recentPnl: Array.isArray(s.recentPnl) ? s.recentPnl.filter(Number.isFinite).slice(-ROLLING_WINDOW) : [],
        });
      }
    }
    if (Number.isFinite(data.globalTrades)) this.globalTrades = data.globalTrades;
  }

  reset(): void {
    this.strategies.clear();
    this.globalTrades = 0;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private getOrCreate(name: string): StrategyStats {
    let stats = this.strategies.get(name);
    if (!stats) {
      stats = {
        name, trades: 0, wins: 0, losses: 0,
        winRate: 0.5, avgWin: 0, avgLoss: 0, ev: 0, profitFactor: 0,
        consecutiveLosses: 0, maxConsecutiveLosses: 0,
        disabled: false, weight: 1.0, recentPnl: [],
      };
      this.strategies.set(name, stats);
    }
    return stats;
  }

  private recomputeStats(stats: StrategyStats): void {
    const pnls = stats.recentPnl;
    if (pnls.length === 0) return;

    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);

    stats.winRate = wins.length / pnls.length;
    stats.avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    stats.avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

    // EV = (winRate × avgWin) - ((1 - winRate) × avgLoss)
    stats.ev = (stats.winRate * stats.avgWin) - ((1 - stats.winRate) * stats.avgLoss);

    // Profit factor
    const grossProfit = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    stats.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;

    // Performance weight: scale 0.3 to 2.0 based on EV and win rate
    if (stats.trades >= MIN_TRADES_FOR_EV) {
      const evNorm = Math.max(0, Math.min(1, (stats.ev + 5) / 10)); // Normalize EV to 0-1
      const wrNorm = stats.winRate;
      stats.weight = Math.max(0.3, Math.min(2.0, 0.3 + (evNorm * 0.85 + wrNorm * 0.85)));
    }
  }
}

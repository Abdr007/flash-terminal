/**
 * Time Intelligence — Track performance by time period.
 *
 * Markets behave differently at different times. Asian session is different
 * from US session. Weekend is different from weekday.
 *
 * Track win rate by hour and day, reduce or halt trading during
 * historically poor-performing periods.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TimePerformance {
  hour: number;
  trades: number;
  wins: number;
  winRate: number;
  avgPnl: number;
}

export interface TimeCheck {
  allowed: boolean;
  sizeMultiplier: number;
  reason: string;
}

// ─── Time Intelligence ───────────────────────────────────────────────────────

export class TimeIntelligence {
  /** Performance by hour (0-23 UTC) */
  private hourlyPerf: Map<number, { trades: number; wins: number; totalPnl: number }> = new Map();
  private readonly minTradesForJudgment = 5;

  /**
   * Record a trade outcome with its hour.
   */
  record(pnl: number): void {
    const hour = new Date().getUTCHours();
    const perf = this.hourlyPerf.get(hour) ?? { trades: 0, wins: 0, totalPnl: 0 };
    perf.trades++;
    if (pnl > 0) perf.wins++;
    perf.totalPnl += pnl;
    this.hourlyPerf.set(hour, perf);
  }

  /**
   * Check if current time period is favorable for trading.
   */
  check(): TimeCheck {
    const hour = new Date().getUTCHours();
    const perf = this.hourlyPerf.get(hour);

    if (!perf || perf.trades < this.minTradesForJudgment) {
      return { allowed: true, sizeMultiplier: 1.0, reason: `Hour ${hour} UTC: no data yet` };
    }

    const winRate = perf.wins / perf.trades;
    const avgPnl = perf.totalPnl / perf.trades;

    // Strong performer — trade normally or boost
    if (winRate >= 0.6 && avgPnl > 0) {
      return { allowed: true, sizeMultiplier: 1.1, reason: `Hour ${hour}: strong (WR=${(winRate * 100).toFixed(0)}%)` };
    }

    // Weak performer — reduce size
    if (winRate < 0.35 || avgPnl < -1) {
      return { allowed: true, sizeMultiplier: 0.5, reason: `Hour ${hour}: weak (WR=${(winRate * 100).toFixed(0)}%) — half size` };
    }

    // Very poor — halt trading this hour
    if (winRate < 0.25 && perf.trades >= 8) {
      return { allowed: false, sizeMultiplier: 0, reason: `Hour ${hour}: historically bad (WR=${(winRate * 100).toFixed(0)}%) — skipping` };
    }

    return { allowed: true, sizeMultiplier: 1.0, reason: `Hour ${hour}: neutral` };
  }

  /**
   * Get performance summary by hour.
   */
  getSummary(): TimePerformance[] {
    const result: TimePerformance[] = [];
    for (const [hour, perf] of this.hourlyPerf) {
      result.push({
        hour,
        trades: perf.trades,
        wins: perf.wins,
        winRate: perf.trades > 0 ? perf.wins / perf.trades : 0,
        avgPnl: perf.trades > 0 ? perf.totalPnl / perf.trades : 0,
      });
    }
    return result.sort((a, b) => a.hour - b.hour);
  }

  // ─── Serialization ──────────────────────────────────────────────────

  serialize(): Array<{ hour: number; trades: number; wins: number; totalPnl: number }> {
    const result: Array<{ hour: number; trades: number; wins: number; totalPnl: number }> = [];
    for (const [hour, perf] of this.hourlyPerf) {
      result.push({ hour, trades: perf.trades, wins: perf.wins, totalPnl: perf.totalPnl });
    }
    return result;
  }

  restore(data: Array<{ hour: number; trades: number; wins: number; totalPnl: number }>): void {
    if (!Array.isArray(data)) return;
    this.hourlyPerf.clear();
    for (const item of data) {
      if (typeof item.hour === 'number' && item.hour >= 0 && item.hour <= 23 &&
          Number.isFinite(item.trades) && Number.isFinite(item.wins) && Number.isFinite(item.totalPnl)) {
        this.hourlyPerf.set(item.hour, { trades: item.trades, wins: item.wins, totalPnl: item.totalPnl });
      }
    }
  }

  reset(): void {
    this.hourlyPerf.clear();
  }
}

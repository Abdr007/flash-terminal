/**
 * Trade Journal — Records every decision for post-trade analysis.
 *
 * Tracks:
 * - Every trade entry/exit with full context
 * - PnL and fee accounting
 * - Strategy signal correctness
 * - Aggregate statistics
 */

import type { JournalEntry, JournalStats, TradeDecision, DecisionAction } from './types.js';

export class TradeJournal {
  private entries: JournalEntry[] = [];
  private nextId = 1;

  // ─── Recording ─────────────────────────────────────────────────────

  /**
   * Record a trade decision (open, close, skip, hold).
   */
  record(
    decision: TradeDecision,
    result?: { entryPrice?: number; exitPrice?: number; pnl?: number; pnlPercent?: number; fees?: number; error?: string },
  ): JournalEntry {
    const entry: JournalEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      action: decision.action,
      market: decision.market,
      side: decision.side,
      leverage: decision.leverage,
      collateral: decision.collateral,
      entryPrice: result?.entryPrice,
      exitPrice: result?.exitPrice,
      pnl: result?.pnl,
      pnlPercent: result?.pnlPercent,
      fees: result?.fees,
      strategy: decision.strategy,
      confidence: decision.confidence,
      signals: decision.signals,
      reasoning: decision.reasoning,
      error: result?.error,
    };

    // Determine outcome for closed trades
    if (result?.pnl !== undefined) {
      if (result.pnl > 0.01) entry.outcome = 'win';
      else if (result.pnl < -0.01) entry.outcome = 'loss';
      else entry.outcome = 'breakeven';
    } else if (decision.action === ('open' as DecisionAction)) {
      entry.outcome = 'pending';
    }

    this.entries.push(entry);
    return entry;
  }

  /**
   * Update a pending entry when the trade is closed.
   */
  closeEntry(
    id: number,
    result: { exitPrice: number; pnl: number; pnlPercent?: number; fees?: number; durationMs?: number },
  ): JournalEntry | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;

    entry.exitPrice = result.exitPrice;
    entry.pnl = result.pnl;
    entry.pnlPercent = result.pnlPercent;
    entry.fees = result.fees;
    entry.durationMs = result.durationMs;

    if (result.pnl > 0.01) entry.outcome = 'win';
    else if (result.pnl < -0.01) entry.outcome = 'loss';
    else entry.outcome = 'breakeven';

    return entry;
  }

  /**
   * Mark whether the strategy signal was correct in hindsight.
   */
  markSignalCorrectness(id: number, correct: boolean): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) entry.signalCorrect = correct;
  }

  // ─── Queries ───────────────────────────────────────────────────────

  /** Get all entries. */
  getEntries(): readonly JournalEntry[] {
    return this.entries;
  }

  /** Get recent N entries. */
  getRecent(n: number): JournalEntry[] {
    return this.entries.slice(-n);
  }

  /** Get entries for a specific market. */
  getByMarket(market: string): JournalEntry[] {
    return this.entries.filter((e) => e.market.toUpperCase() === market.toUpperCase());
  }

  /** Get entries for a specific strategy. */
  getByStrategy(strategy: string): JournalEntry[] {
    return this.entries.filter((e) => e.strategy === strategy);
  }

  /** Get pending (open) entries. */
  getPending(): JournalEntry[] {
    return this.entries.filter((e) => e.outcome === 'pending');
  }

  // ─── Statistics ────────────────────────────────────────────────────

  /** Calculate aggregate statistics from journal entries. */
  getStats(): JournalStats {
    const trades = this.entries.filter((e) => e.outcome && e.outcome !== 'pending');
    const wins = trades.filter((e) => e.outcome === 'win');
    const losses = trades.filter((e) => e.outcome === 'loss');
    const breakeven = trades.filter((e) => e.outcome === 'breakeven');

    const totalPnl = trades.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
    const totalFees = trades.reduce((sum, e) => sum + (e.fees ?? 0), 0);
    const winPnls = wins.map((e) => e.pnl ?? 0);
    const lossPnls = losses.map((e) => e.pnl ?? 0);

    const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0;

    const grossProfit = winPnls.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const withSignal = trades.filter((e) => e.signalCorrect !== undefined);
    const correctSignals = withSignal.filter((e) => e.signalCorrect === true);
    const signalAccuracy = withSignal.length > 0 ? correctSignals.length / withSignal.length : 0;

    const avgConfidence = trades.length > 0
      ? trades.reduce((sum, e) => sum + e.confidence, 0) / trades.length
      : 0;

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      totalPnl,
      totalFees,
      avgWin,
      avgLoss,
      profitFactor,
      avgConfidence,
      signalAccuracy,
      bestTrade: winPnls.length > 0 ? Math.max(...winPnls) : 0,
      worstTrade: lossPnls.length > 0 ? Math.min(...lossPnls) : 0,
    };
  }

  /** Format stats as a human-readable summary. */
  formatStats(): string {
    const s = this.getStats();
    const lines = [
      `Trades: ${s.totalTrades} (${s.wins}W / ${s.losses}L / ${s.breakeven}BE)`,
      `Win Rate: ${(s.winRate * 100).toFixed(1)}%`,
      `Total PnL: $${s.totalPnl.toFixed(2)}`,
      `Avg Win: $${s.avgWin.toFixed(2)} | Avg Loss: $${s.avgLoss.toFixed(2)}`,
      `Profit Factor: ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`,
      `Signal Accuracy: ${(s.signalAccuracy * 100).toFixed(0)}%`,
      `Best: $${s.bestTrade.toFixed(2)} | Worst: $${s.worstTrade.toFixed(2)}`,
    ];
    return lines.join('\n');
  }

  /** Reset journal. */
  clear(): void {
    this.entries = [];
    this.nextId = 1;
  }
}

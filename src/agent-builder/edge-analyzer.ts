/**
 * Edge Analyzer — Statistical validation of trading edge.
 *
 * Answers: "Does this system produce consistent positive expectancy?"
 *
 * Analyses:
 *   1. Core edge metrics (EV, Sharpe, drawdown, avg R)
 *   2. Exit efficiency (MFE analysis — are we cutting profits too early?)
 *   3. Regime breakdown (where does edge come from?)
 *   4. Strategy contribution (which strategies are profitable?)
 *   5. Correlation impact (are guards helping or hurting?)
 *   6. Learning stability (is the policy converging?)
 *   7. Final verdict (pass/fail with specific reasons)
 */

import type { JournalEntry, JournalStats } from './types.js';
import type { SimulationInsight } from './simulation-engine.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EdgeReport {
  /** Minimum 100 trades for statistical validity */
  sufficientData: boolean;
  tradeCount: number;

  // Core edge
  ev: number;                    // Expected value per trade ($)
  evPerDollarRisk: number;       // EV / average risk
  sharpe: number;
  maxDrawdownPct: number;
  avgRMultiple: number;          // Average PnL / average loss (reward-to-risk)
  winRate: number;
  profitFactor: number;

  // Exit efficiency
  exitEfficiency: ExitEfficiencyReport;

  // Regime breakdown
  regimeBreakdown: RegimeBreakdownReport;

  // Strategy contribution
  strategyContribution: StrategyContributionReport;

  // Correlation impact
  correlationImpact: CorrelationImpactReport;

  // Learning stability
  learningStability: LearningStabilityReport;

  // Final verdict
  verdict: EdgeVerdict;
}

export interface ExitEfficiencyReport {
  /** Average % of max favorable excursion captured */
  avgMfeCaptured: number;
  /** Trades where we exited before reaching 50% of MFE */
  earlyExitCount: number;
  earlyExitPct: number;
  /** Trades held to worse than -50% of adverse excursion */
  lateExitCount: number;
  lateExitPct: number;
  /** Average hold time for winners vs losers (ticks) */
  avgWinHoldTime: number;
  avgLossHoldTime: number;
}

export interface RegimeBreakdownReport {
  regimes: Array<{
    regime: string;
    tradeCount: number;
    winRate: number;
    ev: number;
    avgPnl: number;
    profitable: boolean;
  }>;
}

export interface StrategyContributionReport {
  strategies: Array<{
    name: string;
    tradeCount: number;
    winRate: number;
    ev: number;
    avgR: number;
    /** Whether this strategy should be disabled */
    shouldDisable: boolean;
    reason: string;
  }>;
}

export interface CorrelationImpactReport {
  /** Trades that had size reduced due to correlation */
  reducedCount: number;
  /** Estimated PnL impact of size reductions */
  estimatedPnlImpact: number;
}

export interface LearningStabilityReport {
  /** Whether Q-values are converging (recent updates getting smaller) */
  converging: boolean;
  /** Current exploration rate */
  explorationRate: number;
  /** Policy size (number of states visited) */
  policySize: number;
  /** Whether policy is oscillating (flipping between actions) */
  oscillating: boolean;
}

export interface EdgeVerdict {
  /** Overall pass/fail */
  hasEdge: boolean;
  /** Confidence in verdict (0-1) */
  confidence: number;
  /** Specific reasons */
  reasons: string[];
  /** Recommended actions */
  actions: string[];
}

// ─── Edge Analyzer ───────────────────────────────────────────────────────────

export class EdgeAnalyzer {
  /**
   * Run full edge analysis on closed trades.
   */
  analyze(
    entries: readonly JournalEntry[],
    stats: JournalStats,
    policyMetrics?: { sharpe: number; explorationRate: number; policySize: number; degrading: boolean },
    _simInsights?: SimulationInsight,
  ): EdgeReport {
    const closedTrades = entries.filter((e) => e.outcome && e.outcome !== 'pending' && e.pnl !== undefined);
    const sufficientData = closedTrades.length >= 100;

    // Core edge metrics
    const pnls = closedTrades.map((e) => e.pnl ?? 0);
    const ev = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const avgCollateral = closedTrades.reduce((s, e) => s + (e.collateral ?? 0), 0) / Math.max(1, closedTrades.length);
    const evPerDollarRisk = avgCollateral > 0 ? ev / avgCollateral : 0;
    const sharpe = this.computeSharpe(pnls);
    const maxDrawdownPct = this.computeMaxDrawdown(pnls);
    const avgR = this.computeAvgR(closedTrades);

    return {
      sufficientData,
      tradeCount: closedTrades.length,
      ev,
      evPerDollarRisk,
      sharpe,
      maxDrawdownPct,
      avgRMultiple: avgR,
      winRate: stats.winRate,
      profitFactor: stats.profitFactor,

      exitEfficiency: this.analyzeExitEfficiency(closedTrades),
      regimeBreakdown: this.analyzeRegimes(closedTrades),
      strategyContribution: this.analyzeStrategies(closedTrades),
      correlationImpact: this.analyzeCorrelationImpact(closedTrades),
      learningStability: this.analyzeLearning(policyMetrics),
      verdict: this.computeVerdict(closedTrades, stats, sharpe, maxDrawdownPct, ev, policyMetrics),
    };
  }

  /**
   * Format edge report as readable text.
   */
  formatReport(report: EdgeReport): string {
    const lines: string[] = [];
    const v = report.verdict;
    const verdictIcon = v.hasEdge ? '✓' : '✗';

    lines.push('═══ EDGE VALIDATION REPORT ═══');
    lines.push('');

    // Data sufficiency
    if (!report.sufficientData) {
      lines.push(`⚠ INSUFFICIENT DATA: ${report.tradeCount} trades (need ≥100 for statistical validity)`);
      lines.push('');
    }

    // Core edge
    lines.push('── Core Edge ──');
    lines.push(`Trades:        ${report.tradeCount}`);
    lines.push(`EV/trade:      $${report.ev.toFixed(2)}`);
    lines.push(`EV/$ risk:     ${(report.evPerDollarRisk * 100).toFixed(2)}%`);
    lines.push(`Sharpe:        ${report.sharpe.toFixed(2)}`);
    lines.push(`Win Rate:      ${(report.winRate * 100).toFixed(1)}%`);
    lines.push(`Profit Factor: ${report.profitFactor === Infinity ? '∞' : report.profitFactor.toFixed(2)}`);
    lines.push(`Avg R:         ${report.avgRMultiple.toFixed(2)}`);
    lines.push(`Max Drawdown:  ${(report.maxDrawdownPct * 100).toFixed(1)}%`);
    lines.push('');

    // Exit efficiency
    const exit = report.exitEfficiency;
    lines.push('── Exit Efficiency ──');
    lines.push(`MFE Captured:  ${(exit.avgMfeCaptured * 100).toFixed(0)}%`);
    lines.push(`Early Exits:   ${exit.earlyExitCount} (${(exit.earlyExitPct * 100).toFixed(0)}%)`);
    lines.push(`Late Exits:    ${exit.lateExitCount} (${(exit.lateExitPct * 100).toFixed(0)}%)`);
    lines.push(`Avg Win Hold:  ${exit.avgWinHoldTime.toFixed(0)} ticks`);
    lines.push(`Avg Loss Hold: ${exit.avgLossHoldTime.toFixed(0)} ticks`);
    if (exit.avgLossHoldTime > exit.avgWinHoldTime * 1.5) {
      lines.push(`⚠ Holding losers ${(exit.avgLossHoldTime / Math.max(1, exit.avgWinHoldTime)).toFixed(1)}x longer than winners`);
    }
    lines.push('');

    // Regime breakdown
    lines.push('── Regime Performance ──');
    for (const r of report.regimeBreakdown.regimes) {
      const icon = r.profitable ? '+' : '-';
      lines.push(`${icon} ${r.regime.padEnd(12)} ${r.tradeCount} trades  WR=${(r.winRate * 100).toFixed(0)}%  EV=$${r.ev.toFixed(2)}`);
    }
    lines.push('');

    // Strategy contribution
    lines.push('── Strategy Contribution ──');
    for (const s of report.strategyContribution.strategies) {
      const icon = s.shouldDisable ? '✗' : '✓';
      lines.push(`${icon} ${s.name.padEnd(20)} ${s.tradeCount} trades  WR=${(s.winRate * 100).toFixed(0)}%  EV=$${s.ev.toFixed(2)}  R=${s.avgR.toFixed(2)}`);
      if (s.shouldDisable) lines.push(`  → ${s.reason}`);
    }
    lines.push('');

    // Learning
    const learn = report.learningStability;
    lines.push('── Learning Stability ──');
    lines.push(`Converging:    ${learn.converging ? 'Yes' : 'No'}`);
    lines.push(`Exploration:   ${(learn.explorationRate * 100).toFixed(1)}%`);
    lines.push(`Policy States: ${learn.policySize}`);
    lines.push(`Oscillating:   ${learn.oscillating ? '⚠ Yes' : 'No'}`);
    lines.push('');

    // Verdict
    lines.push('══ VERDICT ══');
    lines.push(`${verdictIcon} ${v.hasEdge ? 'SYSTEM HAS EDGE' : 'NO EDGE DETECTED'} (confidence: ${(v.confidence * 100).toFixed(0)}%)`);
    for (const reason of v.reasons) {
      lines.push(`  ${reason}`);
    }
    if (v.actions.length > 0) {
      lines.push('');
      lines.push('Recommended actions:');
      for (const action of v.actions) {
        lines.push(`  → ${action}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Analysis Methods ──────────────────────────────────────────────

  private analyzeExitEfficiency(trades: JournalEntry[]): ExitEfficiencyReport {
    // MFE analysis: compare actual exit vs max favorable movement
    // Since we don't track MFE directly, we approximate from PnL distribution
    const wins = trades.filter((e) => (e.pnl ?? 0) > 0);
    const losses = trades.filter((e) => (e.pnl ?? 0) < 0);

    // Estimate MFE from win distribution — trades with high pnlPercent captured more of the move
    const winPcts = wins.map((e) => e.pnlPercent ?? 0).filter((p) => Number.isFinite(p));
    const lossPcts = losses.map((e) => Math.abs(e.pnlPercent ?? 0)).filter((p) => Number.isFinite(p));

    // Early exits: wins where pnlPercent < 1% (likely exited before full move)
    const earlyExits = wins.filter((e) => (e.pnlPercent ?? 0) > 0 && (e.pnlPercent ?? 0) < 1);
    // Late exits: losses where pnlPercent worse than -5%
    const lateExits = losses.filter((e) => (e.pnlPercent ?? 0) < -5);

    // Hold time approximation from durationMs if available
    const winDurations = wins.map((e) => e.durationMs ?? 0).filter((d) => d > 0);
    const lossDurations = losses.map((e) => e.durationMs ?? 0).filter((d) => d > 0);

    // Approximate MFE captured: ratio of avg win pct to (avg win + avg loss pct)
    const avgWinPct = winPcts.length > 0 ? winPcts.reduce((a, b) => a + b, 0) / winPcts.length : 0;
    const avgLossPct = lossPcts.length > 0 ? lossPcts.reduce((a, b) => a + b, 0) / lossPcts.length : 0;
    const mfeCaptured = (avgWinPct + avgLossPct) > 0 ? avgWinPct / (avgWinPct + avgLossPct) : 0.5;

    return {
      avgMfeCaptured: mfeCaptured,
      earlyExitCount: earlyExits.length,
      earlyExitPct: wins.length > 0 ? earlyExits.length / wins.length : 0,
      lateExitCount: lateExits.length,
      lateExitPct: losses.length > 0 ? lateExits.length / losses.length : 0,
      avgWinHoldTime: winDurations.length > 0 ? winDurations.reduce((a, b) => a + b, 0) / winDurations.length / 10_000 : 0,
      avgLossHoldTime: lossDurations.length > 0 ? lossDurations.reduce((a, b) => a + b, 0) / lossDurations.length / 10_000 : 0,
    };
  }

  private analyzeRegimes(trades: JournalEntry[]): RegimeBreakdownReport {
    // Extract regime from reasoning field (format: "...| REGIME_NAME | ...")
    const regimeMap = new Map<string, JournalEntry[]>();

    for (const t of trades) {
      // Parse regime from reasoning string
      const regimeMatch = t.reasoning.match(/\b(TRENDING_UP|TRENDING_DOWN|RANGING|HIGH_VOLATILITY|COMPRESSION|BULL|BEAR|RISK_OFF|CHAOTIC|NEUTRAL)\b/);
      const regime = regimeMatch ? regimeMatch[1] : 'UNKNOWN';
      const list = regimeMap.get(regime) ?? [];
      list.push(t);
      regimeMap.set(regime, list);
    }

    const regimes: RegimeBreakdownReport['regimes'] = [];
    for (const [regime, entries] of regimeMap) {
      const wins = entries.filter((e) => (e.pnl ?? 0) > 0);
      const pnls = entries.map((e) => e.pnl ?? 0);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const winRate = entries.length > 0 ? wins.length / entries.length : 0;
      const ev = entries.length > 0 ? totalPnl / entries.length : 0;

      regimes.push({
        regime,
        tradeCount: entries.length,
        winRate,
        ev,
        avgPnl: ev,
        profitable: totalPnl > 0,
      });
    }

    regimes.sort((a, b) => b.ev - a.ev);
    return { regimes };
  }

  private analyzeStrategies(trades: JournalEntry[]): StrategyContributionReport {
    const stratMap = new Map<string, JournalEntry[]>();
    for (const t of trades) {
      const strat = t.strategy || 'unknown';
      const list = stratMap.get(strat) ?? [];
      list.push(t);
      stratMap.set(strat, list);
    }

    const strategies: StrategyContributionReport['strategies'] = [];
    for (const [name, entries] of stratMap) {
      const wins = entries.filter((e) => (e.pnl ?? 0) > 0);
      const pnls = entries.map((e) => e.pnl ?? 0);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const winRate = entries.length > 0 ? wins.length / entries.length : 0;
      const ev = entries.length > 0 ? totalPnl / entries.length : 0;

      const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + (e.pnl ?? 0), 0) / wins.length : 0;
      const losses = entries.filter((e) => (e.pnl ?? 0) < 0);
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, e) => s + (e.pnl ?? 0), 0) / losses.length) : 1;
      const avgR = avgLoss > 0 ? avgWin / avgLoss : 0;

      // Disable criteria: ≥10 trades AND (EV < 0 OR win rate < 30%)
      const shouldDisable = entries.length >= 10 && (ev < 0 || winRate < 0.30);
      const reason = shouldDisable
        ? ev < 0 ? `Negative EV ($${ev.toFixed(2)}) over ${entries.length} trades` : `Win rate ${(winRate * 100).toFixed(0)}% too low`
        : '';

      strategies.push({ name, tradeCount: entries.length, winRate, ev, avgR, shouldDisable, reason });
    }

    strategies.sort((a, b) => b.ev - a.ev);
    return { strategies };
  }

  private analyzeCorrelationImpact(trades: JournalEntry[]): CorrelationImpactReport {
    // Check reasoning field for correlation mentions
    const reduced = trades.filter((t) => t.reasoning.includes('correlation') || t.reasoning.includes('cluster'));
    const pnlImpact = reduced.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { reducedCount: reduced.length, estimatedPnlImpact: pnlImpact };
  }

  private analyzeLearning(metrics?: { sharpe: number; explorationRate: number; policySize: number; degrading: boolean }): LearningStabilityReport {
    if (!metrics) {
      return { converging: false, explorationRate: 0.1, policySize: 0, oscillating: false };
    }
    return {
      converging: metrics.explorationRate < 0.05 && metrics.policySize > 10,
      explorationRate: metrics.explorationRate,
      policySize: metrics.policySize,
      oscillating: metrics.degrading,
    };
  }

  private computeVerdict(
    trades: JournalEntry[],
    stats: JournalStats,
    sharpe: number,
    maxDD: number,
    ev: number,
    policyMetrics?: { sharpe: number; explorationRate: number; policySize: number; degrading: boolean },
  ): EdgeVerdict {
    const reasons: string[] = [];
    const actions: string[] = [];
    let score = 0; // -10 to +10

    const n = trades.length;
    if (n < 100) {
      reasons.push(`Insufficient data (${n} trades, need ≥100)`);
      actions.push('Continue running to accumulate more trades');
      return { hasEdge: false, confidence: 0.2, reasons, actions };
    }

    // EV check
    if (ev > 0) {
      score += 3;
      reasons.push(`Positive EV: $${ev.toFixed(2)}/trade`);
    } else {
      score -= 4;
      reasons.push(`Negative EV: $${ev.toFixed(2)}/trade`);
      actions.push('Review exit logic — may be cutting winners too early');
    }

    // Sharpe check
    if (sharpe > 0.5) {
      score += 2;
      reasons.push(`Good Sharpe: ${sharpe.toFixed(2)}`);
    } else if (sharpe > 0) {
      score += 1;
      reasons.push(`Marginal Sharpe: ${sharpe.toFixed(2)} (target >0.5)`);
    } else {
      score -= 3;
      reasons.push(`Negative Sharpe: ${sharpe.toFixed(2)}`);
      actions.push('Reward function may need adjustment');
    }

    // Drawdown check
    if (maxDD > 0.15) {
      score -= 3;
      reasons.push(`Drawdown ${(maxDD * 100).toFixed(1)}% exceeds 15% limit`);
      actions.push('Reduce position sizing or tighten stops');
    } else if (maxDD > 0.10) {
      score -= 1;
      reasons.push(`Drawdown ${(maxDD * 100).toFixed(1)}% approaching limit`);
    } else {
      score += 1;
      reasons.push(`Drawdown contained: ${(maxDD * 100).toFixed(1)}%`);
    }

    // Win rate check
    if (stats.winRate > 0.45) {
      score += 1;
      reasons.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}%`);
    } else if (stats.winRate < 0.35) {
      score -= 2;
      reasons.push(`Low win rate: ${(stats.winRate * 100).toFixed(1)}%`);
      actions.push('Signal quality may need improvement');
    }

    // Profit factor
    if (stats.profitFactor > 1.5) {
      score += 2;
      reasons.push(`Strong profit factor: ${stats.profitFactor.toFixed(2)}`);
    } else if (stats.profitFactor < 1.0) {
      score -= 2;
      reasons.push(`Profit factor below 1.0: ${stats.profitFactor.toFixed(2)}`);
    }

    // Learning convergence
    if (policyMetrics?.degrading) {
      score -= 1;
      reasons.push('Policy performance degrading');
      actions.push('Check for regime changes or data quality issues');
    }

    const hasEdge = score >= 3 && ev > 0;
    const confidence = Math.max(0, Math.min(1, (score + 10) / 20));

    if (!hasEdge && actions.length === 0) {
      actions.push('Refine exit logic first, then reward function');
      actions.push('Do NOT touch infrastructure');
    }

    return { hasEdge, confidence, reasons, actions };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private computeSharpe(pnls: number[]): number {
    if (pnls.length < 5) return 0;
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance);
    return std > 0 ? mean / std : 0;
  }

  private computeMaxDrawdown(pnls: number[]): number {
    let peak = 0;
    let equity = 0;
    let maxDD = 0;
    for (const pnl of pnls) {
      equity += pnl;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }
    return maxDD;
  }

  private computeAvgR(trades: JournalEntry[]): number {
    const wins = trades.filter((e) => (e.pnl ?? 0) > 0);
    const losses = trades.filter((e) => (e.pnl ?? 0) < 0);
    if (wins.length === 0 || losses.length === 0) return 0;

    const avgWin = wins.reduce((s, e) => s + (e.pnl ?? 0), 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, e) => s + (e.pnl ?? 0), 0) / losses.length);
    return avgLoss > 0 ? avgWin / avgLoss : 0;
  }
}

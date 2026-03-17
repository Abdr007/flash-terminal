/**
 * Session Evaluator — Post-trade analysis and scaling recommendations.
 *
 * After each session:
 * - Review journal stats
 * - Identify failure patterns
 * - Score session quality
 * - Recommend scaling action
 */

import { TradeJournal } from './trade-journal.js';
import type { AgentState, JournalStats } from './types.js';

// ─── Report Types ────────────────────────────────────────────────────────────

export interface SessionReport {
  /** Overall session score 0-100 */
  score: number;
  /** Grade: A/B/C/D/F */
  grade: string;
  /** Scaling recommendation */
  scalingAction: 'scale_up' | 'hold' | 'scale_down' | 'stop';
  /** Journal statistics */
  stats: JournalStats;
  /** Identified issues */
  issues: SessionIssue[];
  /** Strengths identified */
  strengths: string[];
  /** Scaling reasoning */
  scalingReason: string;
  /** Duration of session in ms */
  sessionDurationMs: number;
  /** Capital change */
  capitalChange: number;
  capitalChangePct: number;
}

export interface SessionIssue {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  message: string;
  recommendation: string;
}

// ─── Session Evaluator ───────────────────────────────────────────────────────

export class SessionEvaluator {
  /**
   * Evaluate a completed agent session.
   */
  evaluate(journal: TradeJournal, state: AgentState): SessionReport {
    const stats = journal.getStats();
    const entries = journal.getEntries();
    const issues: SessionIssue[] = [];
    const strengths: string[] = [];
    let score = 50; // Start at neutral

    // ─── Win Rate Analysis ─────────────────────────────────────
    if (stats.totalTrades >= 3) {
      if (stats.winRate >= 0.6) {
        score += 15;
        strengths.push(`Strong win rate: ${(stats.winRate * 100).toFixed(0)}%`);
      } else if (stats.winRate >= 0.45) {
        score += 5;
      } else if (stats.winRate < 0.3) {
        score -= 20;
        issues.push({
          severity: 'high',
          category: 'win_rate',
          message: `Low win rate: ${(stats.winRate * 100).toFixed(0)}%`,
          recommendation: 'Review strategy entry conditions — signals may be too weak',
        });
      }
    }

    // ─── Profit Factor ─────────────────────────────────────────
    if (stats.totalTrades >= 3) {
      if (stats.profitFactor >= 2) {
        score += 15;
        strengths.push(`Excellent profit factor: ${stats.profitFactor.toFixed(2)}`);
      } else if (stats.profitFactor >= 1.2) {
        score += 5;
      } else if (stats.profitFactor < 1 && stats.profitFactor > 0) {
        score -= 15;
        issues.push({
          severity: 'high',
          category: 'profit_factor',
          message: `Profit factor below 1: ${stats.profitFactor.toFixed(2)}`,
          recommendation: 'Losses exceed wins — review exit logic and stop-loss placement',
        });
      }
    }

    // ─── PnL Analysis ──────────────────────────────────────────
    const capitalChange = state.currentCapital - state.startingCapital;
    const capitalChangePct = state.startingCapital > 0 ? capitalChange / state.startingCapital : 0;

    if (capitalChangePct > 0.02) {
      score += 10;
      strengths.push(`Profitable session: ${(capitalChangePct * 100).toFixed(1)}% return`);
    } else if (capitalChangePct < -0.03) {
      score -= 15;
      issues.push({
        severity: 'high',
        category: 'drawdown',
        message: `Session drawdown: ${(capitalChangePct * 100).toFixed(1)}%`,
        recommendation: 'Reduce position sizes or tighten stop losses',
      });
    }

    // ─── Worst Trade Analysis ──────────────────────────────────
    if (stats.worstTrade < -50) {
      issues.push({
        severity: 'critical',
        category: 'worst_trade',
        message: `Large single loss: $${stats.worstTrade.toFixed(2)}`,
        recommendation: 'Review position sizing — single trade should not lose this much',
      });
      score -= 10;
    }

    // ─── Avg Win vs Avg Loss ───────────────────────────────────
    if (stats.avgWin > 0 && stats.avgLoss > 0) {
      const rr = stats.avgWin / stats.avgLoss;
      if (rr >= 2) {
        strengths.push(`Good risk/reward ratio: ${rr.toFixed(1)}:1`);
        score += 10;
      } else if (rr < 1) {
        issues.push({
          severity: 'medium',
          category: 'risk_reward',
          message: `Average win ($${stats.avgWin.toFixed(2)}) smaller than average loss ($${stats.avgLoss.toFixed(2)})`,
          recommendation: 'Widen take-profit or tighten stop-loss to improve R:R',
        });
        score -= 5;
      }
    }

    // ─── Consecutive Loss Pattern ──────────────────────────────
    let maxConsecutiveLosses = 0;
    let currentStreak = 0;
    for (const entry of entries) {
      if (entry.outcome === 'loss') {
        currentStreak++;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak);
      } else if (entry.outcome === 'win') {
        currentStreak = 0;
      }
    }
    if (maxConsecutiveLosses >= 3) {
      issues.push({
        severity: 'medium',
        category: 'streak',
        message: `${maxConsecutiveLosses} consecutive losses detected`,
        recommendation: 'Cooldown period may need to be longer, or strategy needs re-evaluation',
      });
      score -= 5;
    }

    // ─── Signal Accuracy ───────────────────────────────────────
    if (stats.signalAccuracy > 0.7) {
      strengths.push(`High signal accuracy: ${(stats.signalAccuracy * 100).toFixed(0)}%`);
      score += 5;
    } else if (stats.signalAccuracy > 0 && stats.signalAccuracy < 0.4) {
      issues.push({
        severity: 'medium',
        category: 'signal_quality',
        message: `Low signal accuracy: ${(stats.signalAccuracy * 100).toFixed(0)}%`,
        recommendation: 'Signals are not predictive — review detection thresholds',
      });
      score -= 5;
    }

    // ─── Trade Frequency ───────────────────────────────────────
    if (stats.totalTrades === 0) {
      issues.push({
        severity: 'low',
        category: 'no_trades',
        message: 'No trades executed',
        recommendation: 'Confidence threshold may be too high, or market conditions were quiet',
      });
      score -= 10;
    }

    // ─── Safety Stop ───────────────────────────────────────────
    if (state.safetyStopReason) {
      issues.push({
        severity: 'critical',
        category: 'safety_stop',
        message: `Agent safety-stopped: ${state.safetyStopReason}`,
        recommendation: 'Investigate root cause before restarting',
      });
      score -= 20;
    }

    // ─── Clamp Score ───────────────────────────────────────────
    score = Math.max(0, Math.min(100, score));

    // ─── Scaling Decision (SECTION 6) ──────────────────────────
    const { action: scalingAction, reason: scalingReason } = this.determineScaling(score, stats, capitalChangePct, issues);

    return {
      score,
      grade: this.scoreToGrade(score),
      scalingAction,
      stats,
      issues,
      strengths,
      scalingReason,
      sessionDurationMs: state.lastTradeTimestamp > 0 ? Date.now() - (state.lastTradeTimestamp - state.iteration * 10_000) : 0,
      capitalChange,
      capitalChangePct,
    };
  }

  /**
   * Format a session report as readable text.
   */
  formatReport(report: SessionReport): string {
    const lines: string[] = [
      `SESSION REPORT — Grade: ${report.grade} (${report.score}/100)`,
      `Scaling: ${report.scalingAction.toUpperCase()} — ${report.scalingReason}`,
      '',
      `Capital: ${report.capitalChangePct >= 0 ? '+' : ''}${(report.capitalChangePct * 100).toFixed(2)}% ($${report.capitalChange.toFixed(2)})`,
      `Trades: ${report.stats.totalTrades} (${report.stats.wins}W/${report.stats.losses}L)`,
      `Win Rate: ${(report.stats.winRate * 100).toFixed(1)}% | PF: ${report.stats.profitFactor === Infinity ? '∞' : report.stats.profitFactor.toFixed(2)}`,
    ];

    if (report.strengths.length > 0) {
      lines.push('', 'STRENGTHS:');
      for (const s of report.strengths) lines.push(`  + ${s}`);
    }

    if (report.issues.length > 0) {
      lines.push('', 'ISSUES:');
      for (const i of report.issues) {
        lines.push(`  [${i.severity.toUpperCase()}] ${i.message}`);
        lines.push(`    → ${i.recommendation}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private determineScaling(
    score: number,
    stats: JournalStats,
    capitalChangePct: number,
    issues: SessionIssue[],
  ): { action: SessionReport['scalingAction']; reason: string } {
    const hasCritical = issues.some((i) => i.severity === 'critical');

    if (hasCritical) {
      return { action: 'stop', reason: 'Critical issues detected — resolve before continuing' };
    }

    if (score >= 75 && stats.totalTrades >= 5 && capitalChangePct > 0 && stats.winRate >= 0.5) {
      return { action: 'scale_up', reason: 'Consistent profitability with stable behavior' };
    }

    if (score >= 50 && !hasCritical) {
      return { action: 'hold', reason: 'Acceptable performance — maintain current size' };
    }

    if (score < 50 || capitalChangePct < -0.03) {
      return { action: 'scale_down', reason: 'Underperformance — reduce position sizes' };
    }

    return { action: 'hold', reason: 'Insufficient data for scaling decision' };
  }

  private scoreToGrade(score: number): string {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  }
}

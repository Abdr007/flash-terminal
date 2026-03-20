/**
 * Edge Refiner V2 — Self-improving with controlled learning.
 *
 * V2 improvements over V1:
 *   1. Exit efficiency is now #1 priority (R-multiple > strategy changes)
 *   2. Strategy disable requires ≥25 trades (prevents noise-driven decisions)
 *   3. Regime scaling replaces binary blocking (0.3x size, not 0x)
 *   4. 30-trade cooldown after each change (clean measurement window)
 *   5. Impact tracking — reverts if change worsened performance
 *   6. Safety guard — freezes after 2 consecutive negative cycles
 *
 * Design rules (unchanged):
 *   - One change per cycle (isolate variable)
 *   - Full audit log with before/after metrics
 *   - Never changes multiple components simultaneously
 */

import { EdgeAnalyzer } from './edge-analyzer.js';
import type { EdgeReport } from './edge-analyzer.js';
import type { JournalEntry, JournalStats } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RefinementType =
  | 'tune_exits'        // V2: active exit parameter adjustment
  | 'disable_strategy'
  | 'scale_regime'      // V2: replaces block_regime (scaling not binary)
  | 'reduce_size'
  | 'revert'            // V2: undo a previous change
  | 'freeze'            // V2: safety guard — all changes frozen
  | 'advisory'
  | 'no_action';

export interface RefinementAction {
  type: RefinementType;
  target: string;
  reason: string;
  data?: Record<string, unknown>;
}

export interface RefinementLog {
  timestamp: string;
  tradeCount: number;
  ev: number;
  sharpe: number;
  action: RefinementAction;
  /** V2: snapshot of metrics at time of refinement for impact tracking */
  snapshotBefore?: { ev: number; sharpe: number; winRate: number };
}

// ─── Configuration ───────────────────────────────────────────────────────────

const CYCLE_TRADES = 40;
const COOLDOWN_TRADES = 30;           // V2: minimum trades between changes
const MIN_TRADES_FOR_ACTION = 50;
const MIN_TRADES_FOR_DISABLE = 25;    // V2: raised from 10 for statistical stability
const MAX_DRAWDOWN_THRESHOLD = 0.15;
const EXIT_EFFICIENCY_THRESHOLD = 0.60; // V2: raised from 0.55
const REGIME_SCALE_FACTOR = 0.3;       // V2: scale to 30% instead of blocking
const CONSECUTIVE_NEGATIVE_LIMIT = 2;  // V2: freeze after 2 bad cycles

// ─── Edge Refiner V2 ────────────────────────────────────────────────────────

export class EdgeRefiner {
  private readonly analyzer = new EdgeAnalyzer();
  private lastRefinementAt = 0;
  private lastChangeAt = 0;            // V2: trade count at last *active* change
  private refinementLog: RefinementLog[] = [];

  /** Strategies disabled by the refiner */
  private disabledStrategies: Set<string> = new Set();
  /** V2: Regime scaling (not binary blocking). Default 1.0, reduced to REGIME_SCALE_FACTOR */
  private regimeScaling: Map<string, number> = new Map();
  /** Size reduction from drawdown */
  private sizeReduction = 1.0;

  /** V2: Impact tracking — metrics before last active change */
  private lastChangeSnapshot: { ev: number; sharpe: number; winRate: number } | null = null;
  private lastChangeAction: RefinementAction | null = null;
  /** V2: Consecutive cycles where performance worsened after a change */
  private consecutiveNegativeCycles = 0;
  /** V2: Safety freeze — all changes blocked until manual reset */
  private frozen = false;

  private static readonly MAX_LOG = 50;

  // ─── Public API ────────────────────────────────────────────────────

  shouldRefine(currentTradeCount: number): boolean {
    return currentTradeCount - this.lastRefinementAt >= CYCLE_TRADES
      && currentTradeCount >= MIN_TRADES_FOR_ACTION;
  }

  /**
   * Run one refinement cycle. Returns the action taken.
   * V2: includes cooldown enforcement, impact tracking, and safety freeze.
   */
  refine(
    entries: readonly JournalEntry[],
    stats: JournalStats,
    policyMetrics?: { sharpe: number; explorationRate: number; policySize: number; degrading: boolean },
  ): RefinementAction {
    const report = this.analyzer.analyze(entries, stats, policyMetrics);
    this.lastRefinementAt = report.tradeCount;

    const currentSnapshot = { ev: report.ev, sharpe: report.sharpe, winRate: report.winRate };

    // V2: Check if last change worsened performance → revert
    const revertAction = this.checkImpact(report, currentSnapshot);
    if (revertAction) return this.logAction(report, revertAction, currentSnapshot);

    // V2: Safety freeze check
    if (this.frozen) {
      return this.logAction(report, {
        type: 'freeze', target: 'system',
        reason: `System frozen after ${CONSECUTIVE_NEGATIVE_LIMIT} consecutive negative refinements — reset required`,
      }, currentSnapshot);
    }

    // V2: Cooldown — don't change if recent change hasn't had time to show impact
    if (report.tradeCount - this.lastChangeAt < COOLDOWN_TRADES && this.lastChangeAction) {
      return this.logAction(report, {
        type: 'no_action', target: '',
        reason: `Cooldown: ${COOLDOWN_TRADES - (report.tradeCount - this.lastChangeAt)} trades remaining before next change allowed`,
      }, currentSnapshot);
    }

    // V2: Priority order — exit efficiency FIRST
    const action = this.checkExitEfficiency(report)
      ?? this.checkStrategies(report)
      ?? this.checkRegimes(report)
      ?? this.checkDrawdown(report)
      ?? { type: 'no_action' as const, target: '', reason: `EV=$${report.ev.toFixed(2)} Sharpe=${report.sharpe.toFixed(2)} — system healthy` };

    // Track active changes for impact measurement
    if (action.type !== 'no_action' && action.type !== 'advisory') {
      this.lastChangeSnapshot = currentSnapshot;
      this.lastChangeAction = action;
      this.lastChangeAt = report.tradeCount;
    }

    return this.logAction(report, action, currentSnapshot);
  }

  /** V2: Get regime size multiplier (scaling, not binary). Default 1.0. */
  getRegimeMultiplier(regime: string): number {
    return this.regimeScaling.get(regime) ?? 1.0;
  }

  /** Check if a regime is blocked (V2: never fully blocked, just scaled) */
  isRegimeBlocked(_regime: string): boolean {
    return false; // V2: no binary blocking, only scaling
  }

  isStrategyDisabled(strategy: string): boolean {
    const parts = strategy.split('+');
    return parts.some((p) => this.disabledStrategies.has(p));
  }

  getSizeMultiplier(): number {
    return this.sizeReduction;
  }

  getLog(): readonly RefinementLog[] {
    return this.refinementLog;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  getSummary(): {
    scaledRegimes: Array<{ regime: string; multiplier: number }>;
    disabledStrategies: string[];
    sizeMultiplier: number;
    refinementCount: number;
    frozen: boolean;
    consecutiveNegative: number;
  } {
    return {
      scaledRegimes: [...this.regimeScaling].map(([regime, mult]) => ({ regime, multiplier: mult })),
      disabledStrategies: [...this.disabledStrategies],
      sizeMultiplier: this.sizeReduction,
      refinementCount: this.refinementLog.length,
      frozen: this.frozen,
      consecutiveNegative: this.consecutiveNegativeCycles,
    };
  }

  /** Unfreeze + reset all changes (manual intervention after safety freeze) */
  reset(): void {
    this.lastRefinementAt = 0;
    this.lastChangeAt = 0;
    this.refinementLog = [];
    this.disabledStrategies.clear();
    this.regimeScaling.clear();
    this.sizeReduction = 1.0;
    this.lastChangeSnapshot = null;
    this.lastChangeAction = null;
    this.consecutiveNegativeCycles = 0;
    this.frozen = false;
  }

  // ─── V2: Impact Tracking ──────────────────────────────────────────

  private checkImpact(report: EdgeReport, current: { ev: number; sharpe: number }): RefinementAction | null {
    if (!this.lastChangeSnapshot || !this.lastChangeAction) return null;
    // Need enough trades since last change to measure
    if (report.tradeCount - this.lastChangeAt < COOLDOWN_TRADES) return null;

    const before = this.lastChangeSnapshot;
    const evDelta = current.ev - before.ev;
    const sharpeDelta = current.sharpe - before.sharpe;

    // Performance worsened significantly?
    const worsened = evDelta < -0.5 && sharpeDelta < -0.1;

    if (worsened) {
      this.consecutiveNegativeCycles++;

      if (this.consecutiveNegativeCycles >= CONSECUTIVE_NEGATIVE_LIMIT) {
        // V2 Safety guard: freeze all changes
        this.frozen = true;
        // Revert the last change
        this.revertLastChange();
        return {
          type: 'freeze', target: 'system',
          reason: `${CONSECUTIVE_NEGATIVE_LIMIT} consecutive negative refinements (EV ${evDelta > 0 ? '+' : ''}${evDelta.toFixed(2)}, Sharpe ${sharpeDelta > 0 ? '+' : ''}${sharpeDelta.toFixed(2)}) — frozen + reverted`,
          data: { evBefore: before.ev, evAfter: current.ev, sharpeBefore: before.sharpe, sharpeAfter: current.sharpe },
        };
      }

      // Revert the last change
      this.revertLastChange();
      const revertedAction = this.lastChangeAction;
      this.lastChangeSnapshot = null;
      this.lastChangeAction = null;
      return {
        type: 'revert', target: revertedAction?.target ?? 'unknown',
        reason: `Reverted '${revertedAction?.type}' on '${revertedAction?.target}' — EV ${evDelta > 0 ? '+' : ''}${evDelta.toFixed(2)}, Sharpe ${sharpeDelta > 0 ? '+' : ''}${sharpeDelta.toFixed(2)}`,
        data: { evBefore: before.ev, evAfter: current.ev, sharpeBefore: before.sharpe, sharpeAfter: current.sharpe },
      };
    }

    // Performance improved or stable — reset negative counter
    this.consecutiveNegativeCycles = 0;
    this.lastChangeSnapshot = null;
    this.lastChangeAction = null;
    return null;
  }

  private revertLastChange(): void {
    if (!this.lastChangeAction) return;
    const { type, target } = this.lastChangeAction;

    switch (type) {
      case 'disable_strategy':
        this.disabledStrategies.delete(target);
        break;
      case 'scale_regime':
        this.regimeScaling.delete(target);
        break;
      case 'reduce_size':
        // Undo the 0.8x reduction — multiply by 1.25 to restore
        this.sizeReduction = Math.min(1.0, this.sizeReduction * 1.25);
        break;
      case 'tune_exits':
        // Exit tuning is advisory — nothing to revert
        break;
    }
  }

  // ─── Priority Checks (V2 order) ───────────────────────────────────

  /** V2 Priority 1: Exit efficiency — improve R-multiple first */
  private checkExitEfficiency(report: EdgeReport): RefinementAction | null {
    if (report.exitEfficiency.avgMfeCaptured < EXIT_EFFICIENCY_THRESHOLD) {
      const exit = report.exitEfficiency;

      // Determine specific advice based on the pattern
      let advice: string;
      if (exit.earlyExitPct > 0.4) {
        advice = 'Early exit rate high — increase momentum sensitivity, reduce stagnation tolerance';
      } else if (exit.lateExitPct > 0.3) {
        advice = 'Late exit rate high — tighten stops, increase reversal detection sensitivity';
      } else if (exit.avgLossHoldTime > exit.avgWinHoldTime * 1.5 && exit.avgWinHoldTime > 0) {
        advice = `Holding losers ${(exit.avgLossHoldTime / exit.avgWinHoldTime).toFixed(1)}x longer than winners — flip this ratio`;
      } else {
        advice = 'Overall exit quality low — exit learner needs more data';
      }

      return {
        type: 'tune_exits',
        target: 'exit_policy',
        reason: `MFE captured ${(exit.avgMfeCaptured * 100).toFixed(0)}% < ${(EXIT_EFFICIENCY_THRESHOLD * 100).toFixed(0)}% — ${advice}`,
        data: {
          mfeCaptured: exit.avgMfeCaptured,
          earlyExitPct: exit.earlyExitPct,
          lateExitPct: exit.lateExitPct,
          avgWinHold: exit.avgWinHoldTime,
          avgLossHold: exit.avgLossHoldTime,
        },
      };
    }
    return null;
  }

  /** V2 Priority 2: Disable strategy — requires ≥25 trades */
  private checkStrategies(report: EdgeReport): RefinementAction | null {
    for (const strat of report.strategyContribution.strategies) {
      // V2: require more trades before disabling (prevents noise decisions)
      if (strat.tradeCount >= MIN_TRADES_FOR_DISABLE && strat.shouldDisable && !this.disabledStrategies.has(strat.name)) {
        this.disabledStrategies.add(strat.name);
        return {
          type: 'disable_strategy',
          target: strat.name,
          reason: `${strat.reason} (${strat.tradeCount} trades, meets ${MIN_TRADES_FOR_DISABLE} minimum)`,
          data: { ev: strat.ev, winRate: strat.winRate, trades: strat.tradeCount },
        };
      }
    }
    return null;
  }

  /** V2 Priority 3: Scale regime (not binary block) */
  private checkRegimes(report: EdgeReport): RefinementAction | null {
    for (const regime of report.regimeBreakdown.regimes) {
      if (regime.tradeCount >= 15 && regime.ev < -1 && !regime.profitable && !this.regimeScaling.has(regime.regime)) {
        // V2: Scale down instead of blocking — preserve partial edge
        this.regimeScaling.set(regime.regime, REGIME_SCALE_FACTOR);
        return {
          type: 'scale_regime',
          target: regime.regime,
          reason: `Scaling ${regime.regime} to ${(REGIME_SCALE_FACTOR * 100).toFixed(0)}% size (EV=$${regime.ev.toFixed(2)} over ${regime.tradeCount} trades)`,
          data: { ev: regime.ev, winRate: regime.winRate, trades: regime.tradeCount, scaleFactor: REGIME_SCALE_FACTOR },
        };
      }
    }
    return null;
  }

  /** V2 Priority 4: Drawdown sizing */
  private checkDrawdown(report: EdgeReport): RefinementAction | null {
    if (report.maxDrawdownPct > MAX_DRAWDOWN_THRESHOLD && this.sizeReduction >= 0.8) {
      this.sizeReduction = Math.max(0.4, this.sizeReduction * 0.8);
      return {
        type: 'reduce_size',
        target: 'global',
        reason: `Max drawdown ${(report.maxDrawdownPct * 100).toFixed(1)}% > ${(MAX_DRAWDOWN_THRESHOLD * 100).toFixed(0)}% — size → ${(this.sizeReduction * 100).toFixed(0)}%`,
        data: { maxDD: report.maxDrawdownPct, newSizeMultiplier: this.sizeReduction },
      };
    }
    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private logAction(report: EdgeReport, action: RefinementAction, snapshot: { ev: number; sharpe: number; winRate: number }): RefinementAction {
    this.refinementLog.push({
      timestamp: new Date().toISOString(),
      tradeCount: report.tradeCount,
      ev: report.ev,
      sharpe: report.sharpe,
      action,
      snapshotBefore: snapshot,
    });
    if (this.refinementLog.length > EdgeRefiner.MAX_LOG) {
      this.refinementLog = this.refinementLog.slice(-EdgeRefiner.MAX_LOG);
    }
    return action;
  }
}

/**
 * Meta-Agent — Self-regulating control layer above the trading agent.
 *
 * Evaluates global conditions and decides HOW to trade, not WHAT to trade.
 * Three modes: AGGRESSIVE, NORMAL, CONSERVATIVE, HALT.
 *
 * Inputs: system EV, recent performance, volatility regime, drawdown state.
 * Output: aggression level that adjusts all thresholds.
 */

import type { DrawdownState } from './drawdown-manager.js';
import type { StrategyStats } from './expectancy-engine.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AggressionMode = 'AGGRESSIVE' | 'NORMAL' | 'CONSERVATIVE' | 'HALT';

export interface MetaDecision {
  mode: AggressionMode;
  /** Score threshold for trade execution (higher = more selective) */
  scoreThreshold: number;
  /** Position size multiplier */
  sizeMultiplier: number;
  /** Max positions allowed */
  maxPositions: number;
  /** Confidence floor */
  minConfidence: number;
  /** R:R minimum */
  minRR: number;
  /** Reasoning */
  reason: string;
}

// ─── Mode Parameters ─────────────────────────────────────────────────────────

const MODE_PARAMS: Record<AggressionMode, Omit<MetaDecision, 'reason'>> = {
  AGGRESSIVE: {
    mode: 'AGGRESSIVE',
    scoreThreshold: 55,
    sizeMultiplier: 1.3,
    maxPositions: 3,
    minConfidence: 0.55,
    minRR: 1.5,
  },
  NORMAL: {
    mode: 'NORMAL',
    scoreThreshold: 65,
    sizeMultiplier: 1.0,
    maxPositions: 2,
    minConfidence: 0.60,
    minRR: 1.5,
  },
  CONSERVATIVE: {
    mode: 'CONSERVATIVE',
    scoreThreshold: 75,
    sizeMultiplier: 0.5,
    maxPositions: 1,
    minConfidence: 0.70,
    minRR: 2.0,
  },
  HALT: {
    mode: 'HALT',
    scoreThreshold: 100, // Impossible to reach — no trades
    sizeMultiplier: 0,
    maxPositions: 0,
    minConfidence: 1.0,
    minRR: 99,
  },
};

// ─── Meta-Agent ──────────────────────────────────────────────────────────────

export class MetaAgent {
  private recentDecisions: AggressionMode[] = [];
  private readonly maxHistory = 20;
  /** Consecutive HALT ticks — force resume after limit */
  private consecutiveHalts = 0;
  private static readonly MAX_HALT_TICKS = 10;

  /**
   * Evaluate global conditions and decide aggression level.
   */
  /** Track volatility trend for forward-looking */
  private volatilityTrend: number[] = [];

  /**
   * Record current market volatility for forward-looking signals.
   */
  recordVolatility(avgVolatility: number): void {
    this.volatilityTrend.push(avgVolatility);
    if (this.volatilityTrend.length > 10) this.volatilityTrend.shift();
  }

  evaluate(
    systemEV: number,
    strategyStats: StrategyStats[],
    drawdownState: DrawdownState,
    recentWinRate: number,
    recentTradeCount: number,
  ): MetaDecision {
    let score = 50;
    const reasons: string[] = [];

    // 1. System EV (most important)
    if (systemEV > 2) { score += 20; reasons.push(`EV=${systemEV.toFixed(1)}↑`); }
    else if (systemEV > 0) { score += 10; reasons.push(`EV=${systemEV.toFixed(1)}`); }
    else if (systemEV < -1) { score -= 25; reasons.push(`EV=${systemEV.toFixed(1)}↓`); }
    else if (systemEV < 0) { score -= 10; reasons.push(`EV=${systemEV.toFixed(1)}`); }

    // FORWARD-LOOKING: volatility trend + structural break detection
    if (this.volatilityTrend.length >= 3) {
      const recent = this.volatilityTrend.slice(-3);
      const expanding = recent[2] > recent[1] && recent[1] > recent[0];
      const compressing = recent[2] < recent[1] && recent[1] < recent[0];
      if (expanding) { score += 8; reasons.push('vol↑'); }
      if (compressing) { score -= 5; reasons.push('vol↓'); }

      // STRUCTURAL BREAK: sudden volatility spike (>2x average)
      if (this.volatilityTrend.length >= 5) {
        const avg = this.volatilityTrend.slice(0, -1).reduce((a, b) => a + b, 0) / (this.volatilityTrend.length - 1);
        const latest = this.volatilityTrend[this.volatilityTrend.length - 1];
        if (avg > 0 && latest / avg > 2.0) {
          score -= 15; reasons.push('BREAK:vol_spike');
          // Structural break detected — go conservative until it settles
        }
      }
    }

    // 2. Recent win rate
    if (recentTradeCount >= 5) {
      if (recentWinRate >= 0.6) { score += 15; reasons.push(`WR=${(recentWinRate * 100).toFixed(0)}%↑`); }
      else if (recentWinRate < 0.35) { score -= 20; reasons.push(`WR=${(recentWinRate * 100).toFixed(0)}%↓`); }
    }

    // 3. Drawdown state
    if (drawdownState.drawdownPct > 0.10) { score -= 25; reasons.push(`DD=${(drawdownState.drawdownPct * 100).toFixed(1)}%`); }
    else if (drawdownState.drawdownPct > 0.05) { score -= 10; reasons.push(`DD=${(drawdownState.drawdownPct * 100).toFixed(1)}%`); }
    else if (drawdownState.drawdownPct === 0) { score += 5; reasons.push('ATH'); }

    // 4. Strategy health — count active vs disabled
    const active = strategyStats.filter((s) => !s.disabled && s.trades >= 5);
    const disabled = strategyStats.filter((s) => s.disabled);
    if (disabled.length > active.length) { score -= 15; reasons.push(`${disabled.length}/${strategyStats.length} disabled`); }

    // 5. Stale equity — only penalize if we've actually traded and lost
    // Don't penalize for not trading (that's correct behavior in quiet markets)
    if (drawdownState.barsSinceHigh > 30 && recentTradeCount >= 5 && drawdownState.drawdownPct > 0.02) {
      score -= 10; reasons.push('stale');
    }

    // Determine mode
    let mode: AggressionMode;
    if (score >= 70) mode = 'AGGRESSIVE';
    else if (score >= 45) mode = 'NORMAL';
    else if (score >= 25) mode = 'CONSERVATIVE';
    else mode = 'HALT';

    // HALT time limit — don't stay halted forever, force back to CONSERVATIVE
    if (mode === 'HALT') {
      this.consecutiveHalts++;
      if (this.consecutiveHalts >= MetaAgent.MAX_HALT_TICKS) {
        mode = 'CONSERVATIVE';
        reasons.push('HALT-timeout→CONSERVATIVE');
      }
    } else {
      this.consecutiveHalts = 0;
    }

    // EARLY-PHASE OVERRIDE: Prevent premature HALT when data is insufficient.
    // With <20 closed trades, WR and EV are statistically meaningless.
    // Allow CONSERVATIVE (never HALT) so the agent can collect learning data.
    // Auto-disables at 20 trades — full strict META resumes.
    if (mode === 'HALT' && recentTradeCount < 20) {
      mode = 'CONSERVATIVE';
      reasons.push(`EARLY-PHASE(${recentTradeCount}/20)→CONSERVATIVE`);
    }

    // Hysteresis — don't flip modes every tick
    this.recentDecisions.push(mode);
    if (this.recentDecisions.length > this.maxHistory) this.recentDecisions.shift();
    const stableMode = this.stabilize(mode);

    return {
      ...MODE_PARAMS[stableMode],
      reason: `${stableMode}(${score}) ${reasons.join(' ')}`,
    };
  }

  /**
   * Stabilize mode — require 3 consecutive ticks to switch.
   */
  private stabilize(proposed: AggressionMode): AggressionMode {
    if (this.recentDecisions.length < 3) return proposed;
    const last3 = this.recentDecisions.slice(-3);
    // If all 3 agree, switch
    if (last3.every((m) => m === proposed)) return proposed;
    // Otherwise keep previous mode
    return this.recentDecisions[this.recentDecisions.length - 2] ?? proposed;
  }

  reset(): void {
    this.recentDecisions = [];
  }
}

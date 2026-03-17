/**
 * Strategy Ensemble — Performance-weighted multi-strategy voting system.
 *
 * How professional quant desks combine strategies:
 * 1. Each strategy votes independently (direction + confidence)
 * 2. Votes are weighted by recent strategy performance (rolling win rate)
 * 3. Meta-strategy aggregates votes into a consensus decision
 * 4. Strategies that underperform are auto-disabled (shadow mode)
 * 5. New strategies can run in shadow mode (observe-only) before going live
 *
 * Inspired by: stacking ensemble methods, Sharpe-weighted portfolio allocation,
 * multi-model consensus systems used at Renaissance, D.E. Shaw.
 */

import type { Strategy, StrategyResult, MarketSnapshot, Signal } from './types.js';
import type { CompositeSignal } from './signal-fusion.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StrategyVote {
  strategy: string;
  result: StrategyResult;
  /** Performance weight (0-1, based on recent win rate) */
  performanceWeight: number;
  /** Whether this strategy is in shadow mode (vote doesn't count) */
  shadow: boolean;
}

export interface EnsembleDecision {
  /** Whether the ensemble recommends trading */
  shouldTrade: boolean;
  /** Consensus direction */
  side?: 'long' | 'short';
  /** Market */
  market?: string;
  /** Weighted consensus confidence */
  confidence: number;
  /** Number of strategies that agree */
  agreeing: number;
  /** Total active (non-shadow) strategies that voted */
  totalVoters: number;
  /** All votes (including shadow) */
  votes: StrategyVote[];
  /** Best individual result (for TP/SL/reasoning) */
  bestResult: StrategyResult | null;
  /** Consensus reasoning */
  reasoning: string;
}

// ─── Performance Tracker ─────────────────────────────────────────────────────

interface StrategyPerformance {
  wins: number;
  losses: number;
  totalTrades: number;
  /** Rolling window of recent results (true=win, false=loss) */
  recentResults: boolean[];
  /** Current win rate (rolling) */
  winRate: number;
  /** Whether auto-disabled due to poor performance */
  disabled: boolean;
  /** Whether in shadow mode (vote doesn't count toward consensus) */
  shadow: boolean;
}

const ROLLING_WINDOW = 20;
const MIN_TRADES_FOR_WEIGHT = 3;
const DISABLE_THRESHOLD = 0.25; // Disable below 25% win rate
const RE_ENABLE_THRESHOLD = 0.4; // Re-enable above 40% (in shadow)

// ─── Strategy Ensemble ───────────────────────────────────────────────────────

export class StrategyEnsemble {
  private strategies: Strategy[];
  private performance: Map<string, StrategyPerformance> = new Map();
  /** Minimum agreeing strategies for a trade */
  private minAgreement: number;
  /** Minimum weighted confidence for a trade */
  private minConfidence: number;

  constructor(
    strategies: Strategy[],
    options?: { minAgreement?: number; minConfidence?: number; shadowStrategies?: string[] },
  ) {
    this.strategies = strategies;
    this.minAgreement = options?.minAgreement ?? 1;
    this.minConfidence = options?.minConfidence ?? 0.45;

    // Initialize performance tracking
    for (const s of strategies) {
      this.performance.set(s.name, {
        wins: 0, losses: 0, totalTrades: 0,
        recentResults: [], winRate: 0.5,
        disabled: false,
        shadow: options?.shadowStrategies?.includes(s.name) ?? false,
      });
    }
  }

  /**
   * Evaluate all strategies and produce an ensemble decision.
   * Uses the composite signal from SignalFusionEngine for enriched context.
   */
  evaluate(
    snapshot: MarketSnapshot,
    signals: Signal[],
    composite?: CompositeSignal,
  ): EnsembleDecision {
    const votes: StrategyVote[] = [];

    for (const strategy of this.strategies) {
      const perf = this.performance.get(strategy.name)!;
      if (perf.disabled && !perf.shadow) continue; // Skip fully disabled

      const result = strategy.evaluate(snapshot, signals);
      const weight = this.getPerformanceWeight(strategy.name);

      votes.push({
        strategy: strategy.name,
        result,
        performanceWeight: weight,
        shadow: perf.shadow || perf.disabled,
      });
    }

    return this.aggregateVotes(votes, snapshot, composite);
  }

  /**
   * Record trade outcome for a strategy.
   */
  recordOutcome(strategyName: string, isWin: boolean): void {
    const perf = this.performance.get(strategyName);
    if (!perf) return;

    perf.totalTrades++;
    if (isWin) perf.wins++;
    else perf.losses++;

    perf.recentResults.push(isWin);
    if (perf.recentResults.length > ROLLING_WINDOW) {
      perf.recentResults.shift();
    }

    // Update rolling win rate
    const recentWins = perf.recentResults.filter(Boolean).length;
    perf.winRate = perf.recentResults.length > 0 ? recentWins / perf.recentResults.length : 0.5;

    // Auto-disable/re-enable based on performance
    if (perf.totalTrades >= MIN_TRADES_FOR_WEIGHT) {
      if (perf.winRate < DISABLE_THRESHOLD && !perf.disabled) {
        perf.disabled = true;
        perf.shadow = true; // Move to shadow mode instead of full disable
      } else if (perf.shadow && perf.winRate >= RE_ENABLE_THRESHOLD) {
        perf.disabled = false;
        perf.shadow = false; // Promote back to active
      }
    }
  }

  /**
   * Get performance-based weight for a strategy.
   * Better performing strategies get higher weight in the vote.
   */
  private getPerformanceWeight(strategyName: string): number {
    const perf = this.performance.get(strategyName);
    if (!perf || perf.totalTrades < MIN_TRADES_FOR_WEIGHT) return 1.0; // Default equal weight

    // Weight = winRate normalized to 0.5-1.5 range
    // 30% WR → 0.6 weight, 50% → 1.0, 70% → 1.4
    return 0.5 + perf.winRate;
  }

  /**
   * Aggregate individual votes into consensus decision.
   */
  private aggregateVotes(
    votes: StrategyVote[],
    snapshot: MarketSnapshot,
    composite?: CompositeSignal,
  ): EnsembleDecision {
    const base: EnsembleDecision = {
      shouldTrade: false, confidence: 0, agreeing: 0,
      totalVoters: 0, votes, bestResult: null, reasoning: '',
    };

    // Only count active (non-shadow) votes for consensus
    const activeVotes = votes.filter((v) => !v.shadow && v.result.shouldTrade);
    const allActiveVoters = votes.filter((v) => !v.shadow);
    base.totalVoters = allActiveVoters.length;

    if (activeVotes.length === 0) {
      base.reasoning = 'No strategies produced a trade signal';
      return base;
    }

    // Count direction votes (weighted)
    let bullishWeight = 0;
    let bearishWeight = 0;

    for (const vote of activeVotes) {
      const w = vote.result.confidence * vote.performanceWeight;
      if (vote.result.side === 'long') bullishWeight += w;
      else if (vote.result.side === 'short') bearishWeight += w;
    }

    const totalDirectionalWeight = bullishWeight + bearishWeight;
    if (totalDirectionalWeight === 0) {
      base.reasoning = 'No directional consensus';
      return base;
    }

    // Determine consensus direction
    const side = bullishWeight > bearishWeight ? 'long' as const : 'short' as const;
    const agreeing = activeVotes.filter((v) => v.result.side === side);
    base.agreeing = agreeing.length;
    base.side = side;
    base.market = snapshot.market;

    // Weighted confidence from agreeing strategies
    const weightedConf = agreeing.reduce((sum, v) => sum + v.result.confidence * v.performanceWeight, 0);
    const totalAgreeWeight = agreeing.reduce((sum, v) => sum + v.performanceWeight, 0);
    base.confidence = totalAgreeWeight > 0 ? weightedConf / totalAgreeWeight : 0;

    // Boost from composite signal alignment
    if (composite && composite.confirmed && composite.direction !== 'neutral') {
      if ((composite.direction === 'bullish' && side === 'long') ||
          (composite.direction === 'bearish' && side === 'short')) {
        base.confidence = Math.min(0.95, base.confidence + composite.strength * 0.1);
      }
    }

    // Pick best individual result for TP/SL
    base.bestResult = agreeing.reduce((best, v) =>
      v.result.confidence > (best?.confidence ?? 0) ? v.result : best,
      null as StrategyResult | null);

    // Check minimum agreement
    if (base.agreeing < this.minAgreement) {
      base.reasoning = `Only ${base.agreeing}/${this.minAgreement} strategies agree — below threshold`;
      return base;
    }

    if (base.confidence < this.minConfidence) {
      base.reasoning = `Confidence ${(base.confidence * 100).toFixed(0)}% below ${(this.minConfidence * 100).toFixed(0)}% threshold`;
      return base;
    }

    base.shouldTrade = true;
    const stratNames = agreeing.map((v) => v.strategy).join(', ');
    base.reasoning = `Ensemble consensus: ${base.agreeing}/${base.totalVoters} strategies vote ${side} (${stratNames})`;

    return base;
  }

  /**
   * Get performance summary for all strategies.
   */
  getPerformanceSummary(): Array<{ name: string; winRate: number; trades: number; disabled: boolean; shadow: boolean; weight: number }> {
    return this.strategies.map((s) => {
      const perf = this.performance.get(s.name)!;
      return {
        name: s.name,
        winRate: perf.winRate,
        trades: perf.totalTrades,
        disabled: perf.disabled,
        shadow: perf.shadow,
        weight: this.getPerformanceWeight(s.name),
      };
    });
  }

  /** Reset all performance data */
  reset(): void {
    for (const perf of this.performance.values()) {
      perf.wins = 0;
      perf.losses = 0;
      perf.totalTrades = 0;
      perf.recentResults = [];
      perf.winRate = 0.5;
      perf.disabled = false;
    }
  }
}

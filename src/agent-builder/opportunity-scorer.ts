/**
 * Opportunity Scorer v2 — Adaptive weights + execution-aware scoring.
 *
 * Weights now LEARN from outcomes via AdaptiveWeights.
 * Execution costs (slippage, fees) reduce the score.
 * Leading indicators weighted higher than lagging by default,
 * but weights shift based on what actually predicts correctly.
 */

import type { TechnicalSignal } from './technical-indicators.js';
import type { EVDecision } from './expectancy-engine.js';
import type { CompositeSignal } from './signal-fusion.js';
import { AdaptiveWeights } from './adaptive-weights.js';
import { ExecutionModel, type ExecutionCost } from './execution-model.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpportunityScore {
  total: number;
  components: {
    signal: number;
    strategy: number;
    ev: number;
    technicals: number;
    regime: number;
    riskReward: number;
  };
  /** Execution cost impact */
  executionCost: ExecutionCost | null;
  passes: boolean;
  summary: string;
}

// ─── Initial Weights (leading > lagging) ─────────────────────────────────────

const INITIAL_WEIGHTS: Record<string, number> = {
  signal: 0.30,       // OI, funding, volatility — leading
  strategy: 0.20,     // Ensemble confidence
  ev: 0.15,           // Historical expected value
  technicals: 0.12,   // RSI/MACD/EMA — lagging, lower initial weight
  regime: 0.12,       // Regime alignment
  riskReward: 0.11,   // R:R quality
};

// ─── Opportunity Scorer ──────────────────────────────────────────────────────

export class OpportunityScorer {
  readonly adaptiveWeights: AdaptiveWeights;
  private readonly executionModel: ExecutionModel;

  constructor() {
    this.adaptiveWeights = new AdaptiveWeights(INITIAL_WEIGHTS);
    this.executionModel = new ExecutionModel();
  }

  /**
   * Score a trade opportunity on 0-100 scale with adaptive weights.
   */
  score(
    composite: CompositeSignal,
    ensembleConfidence: number,
    ensembleAgreeing: number,
    ensembleTotal: number,
    evDecision: EVDecision,
    techSignal: TechnicalSignal,
    techDataAvailable: boolean,
    regimeAllowed: boolean,
    rrRatio: number,
    threshold: number,
    /** Optional: for execution cost modeling */
    positionSizeUsd?: number,
    marketOiUsd?: number,
    entryPrice?: number,
    slPrice?: number,
  ): OpportunityScore {
    const w = this.adaptiveWeights.getAll();

    // 1. Signal component (0-100)
    const signalScore = Math.min(100, composite.confidence * 100 + (composite.confirmedFactors * 5));

    // 2. Strategy component (0-100)
    const agreementPct = ensembleTotal > 0 ? ensembleAgreeing / ensembleTotal : 0;
    const strategyScore = Math.min(100, ensembleConfidence * 60 + agreementPct * 40);

    // 3. EV component (0-100)
    let evScore: number;
    if (!evDecision.allowed && evDecision.ev < 0) {
      evScore = Math.max(0, 30 + evDecision.ev * 5);
    } else if (evDecision.ev > 0) {
      evScore = Math.min(100, 50 + evDecision.ev * 10);
    } else {
      evScore = 50;
    }

    // 4. Technicals component (0-100)
    let techScore: number;
    if (!techDataAvailable) {
      techScore = 50;
    } else {
      techScore = Math.min(100, 30 + techSignal.agreement * 15 + (Math.abs(techSignal.score) * 20));
    }

    // 5. Regime component
    const regimeScore = regimeAllowed ? 100 : 10;

    // 6. R:R component (0-100)
    let rrScore: number;
    if (rrRatio >= 3) rrScore = 100;
    else if (rrRatio >= 2) rrScore = 80;
    else if (rrRatio >= 1.5) rrScore = 60;
    else if (rrRatio >= 1) rrScore = 30;
    else rrScore = 0;

    // Weighted total using ADAPTIVE weights
    let total = Math.round(
      signalScore * (w.signal ?? 0.30) +
      strategyScore * (w.strategy ?? 0.20) +
      evScore * (w.ev ?? 0.15) +
      techScore * (w.technicals ?? 0.12) +
      regimeScore * (w.regime ?? 0.12) +
      rrScore * (w.riskReward ?? 0.11)
    );

    // Execution cost penalty
    let executionCost: ExecutionCost | null = null;
    if (positionSizeUsd && entryPrice && slPrice) {
      executionCost = this.executionModel.estimate(
        positionSizeUsd, marketOiUsd ?? 0, rrRatio, entryPrice, slPrice,
      );
      if (!executionCost.viable) {
        total = Math.round(total * 0.5); // Heavy penalty if costs eat the edge
      } else if (executionCost.totalCostPct > 0.2) {
        total = Math.round(total * 0.85); // Moderate penalty for high costs
      }
    }

    total = Math.max(0, Math.min(100, total));
    const passes = total >= threshold;

    const wStr = Object.entries(w).map(([k, v]) => `${k.slice(0, 3)}=${(v * 100).toFixed(0)}%`).join(' ');
    const summary = `${total}/100 [sig=${signalScore.toFixed(0)} str=${strategyScore.toFixed(0)} ev=${evScore.toFixed(0)} ta=${techScore.toFixed(0)} rg=${regimeScore.toFixed(0)} rr=${rrScore.toFixed(0)}] W:{${wStr}}`;

    return {
      total,
      components: { signal: signalScore, strategy: strategyScore, ev: evScore, technicals: techScore, regime: regimeScore, riskReward: rrScore },
      executionCost,
      passes,
      summary,
    };
  }

  /**
   * Record outcome for a scored trade — updates adaptive weights.
   * Call after every trade close with which components were correct.
   */
  recordOutcome(components: Record<string, boolean>): void {
    for (const [factor, wasCorrect] of Object.entries(components)) {
      this.adaptiveWeights.recordOutcome(factor, wasCorrect);
    }
  }

  reset(): void {
    this.adaptiveWeights.reset();
  }
}

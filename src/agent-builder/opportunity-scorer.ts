/**
 * Opportunity Scorer — Replace hard pass/fail with aggregate scoring.
 *
 * Every trade opportunity gets a score 0-100. Only top percentile executes.
 * This replaces the chain of hard rejects with soft penalties, allowing
 * strong signals to override weak individual filters.
 *
 * Scoring factors:
 * - Composite signal strength (30%)
 * - Strategy confidence (20%)
 * - EV history (15%)
 * - Technical alignment (15%)
 * - Regime match (10%)
 * - R:R quality (10%)
 */

import type { TechnicalSignal } from './technical-indicators.js';
import type { EVDecision } from './expectancy-engine.js';
import type { CompositeSignal } from './signal-fusion.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpportunityScore {
  /** Total score 0-100 */
  total: number;
  /** Breakdown by component */
  components: {
    signal: number;
    strategy: number;
    ev: number;
    technicals: number;
    regime: number;
    riskReward: number;
  };
  /** Whether this passes the threshold */
  passes: boolean;
  /** Human-readable summary */
  summary: string;
}

// ─── Weights (leading indicators weighted higher) ────────────────────────────

const WEIGHTS = {
  signal: 0.30,       // Composite fusion (OI, funding, vol — leading)
  strategy: 0.20,     // Ensemble confidence
  ev: 0.15,           // Expected value history
  technicals: 0.15,   // RSI/MACD/EMA (lagging — lower weight)
  regime: 0.10,       // Regime alignment
  riskReward: 0.10,   // R:R quality
};

// ─── Opportunity Scorer ──────────────────────────────────────────────────────

export class OpportunityScorer {

  /**
   * Score a trade opportunity on 0-100 scale.
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
  ): OpportunityScore {
    // 1. Signal component (0-100) — from Bayesian fusion
    const signalScore = Math.min(100, composite.confidence * 100 + (composite.confirmedFactors * 5));

    // 2. Strategy component (0-100) — from ensemble
    const agreementPct = ensembleTotal > 0 ? ensembleAgreeing / ensembleTotal : 0;
    const strategyScore = Math.min(100, ensembleConfidence * 60 + agreementPct * 40);

    // 3. EV component (0-100)
    let evScore: number;
    if (!evDecision.allowed && evDecision.ev < 0) {
      evScore = Math.max(0, 30 + evDecision.ev * 5); // Negative EV = heavy penalty
    } else if (evDecision.ev > 0) {
      evScore = Math.min(100, 50 + evDecision.ev * 10); // Positive EV = bonus
    } else {
      evScore = 50; // No data = neutral
    }

    // 4. Technicals component (0-100) — lower weight since lagging
    let techScore: number;
    if (!techDataAvailable) {
      techScore = 50; // Neutral if no data
    } else {
      // Score based on agreement count and direction alignment
      techScore = Math.min(100, 30 + techSignal.agreement * 15 + (Math.abs(techSignal.score) * 20));
    }

    // 5. Regime component (0 or 100 — hard binary)
    const regimeScore = regimeAllowed ? 100 : 10; // Heavy penalty but not zero

    // 6. R:R component (0-100)
    let rrScore: number;
    if (rrRatio >= 3) rrScore = 100;
    else if (rrRatio >= 2) rrScore = 80;
    else if (rrRatio >= 1.5) rrScore = 60;
    else if (rrRatio >= 1) rrScore = 30;
    else rrScore = 0;

    // Weighted total
    const total = Math.round(
      signalScore * WEIGHTS.signal +
      strategyScore * WEIGHTS.strategy +
      evScore * WEIGHTS.ev +
      techScore * WEIGHTS.technicals +
      regimeScore * WEIGHTS.regime +
      rrScore * WEIGHTS.riskReward
    );

    const passes = total >= threshold;

    const summary = `${total}/100 [sig=${signalScore.toFixed(0)} strat=${strategyScore.toFixed(0)} ev=${evScore.toFixed(0)} ta=${techScore.toFixed(0)} reg=${regimeScore.toFixed(0)} rr=${rrScore.toFixed(0)}]`;

    return {
      total,
      components: {
        signal: signalScore,
        strategy: strategyScore,
        ev: evScore,
        technicals: techScore,
        regime: regimeScore,
        riskReward: rrScore,
      },
      passes,
      summary,
    };
  }
}

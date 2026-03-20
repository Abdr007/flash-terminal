/**
 * Exit Policy Learner V2 — Learn WHEN and HOW to exit for maximum R-multiple.
 *
 * State dimensions (V2 — 5×4×3×3×3 = 540 states):
 * - unrealizedPnL bucket (5)
 * - time in trade bucket (4)
 * - volatility regime (3)
 * - distance to TP/SL (3)
 * - momentum state (3): accelerating, decaying, reversing
 *
 * Actions (V2 — 5 total):
 * - HOLD: keep position unchanged
 * - TIGHTEN_STOP: move stop closer (lock in profit / reduce risk)
 * - EXTEND_TP: raise take-profit target (let winners run)
 * - PARTIAL_CLOSE: close 50% of position
 * - FULL_CLOSE: close entire position
 *
 * Key rule: if momentum reverses AND profit > 0 → strong bias to exit early
 *
 * IMPORTANT: Hard safety stops (-15% emergency) are NEVER overridden.
 */

import type { PersistedAgentState } from './state-persistence.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExitState {
  pnlBucket: string;
  timeBucket: string;
  volRegime: string;
  tpSlDistance: string;
  /** V2: momentum state — tracks price velocity direction */
  momentum: string;
}

export type ExitAction = 'hold' | 'tighten_stop' | 'extend_tp' | 'partial_close' | 'full_close';

interface ExitPolicyEntry {
  qValues: Record<ExitAction, number>;
  visits: number;
  avgReward: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const EXIT_ACTIONS: ExitAction[] = ['hold', 'tighten_stop', 'extend_tp', 'partial_close', 'full_close'];
const INITIAL_LEARNING_RATE = 0.12;
const MIN_LEARNING_RATE = 0.03;
const LR_DECAY = 0.998;
const EXPLORATION_RATE = 0.10;
const MIN_EXPLORATION = 0.02;
const EXPLORATION_DECAY = 0.997;
const MIN_VISITS_FOR_TRUST = 20;   // V2: reduced from 25 (more states need faster learning)
const MIN_VISITS_FOR_UPDATE = 2;    // V2: reduced from 3

// ─── Exit Policy Learner ────────────────────────────────────────────────────

export class ExitPolicyLearner {
  private policy: Map<string, ExitPolicyEntry> = new Map();
  private currentExploration: number;
  private currentLearningRate: number;
  private totalUpdates = 0;

  /** Rolling price velocity per market for momentum detection */
  private priceVelocity: Map<string, number[]> = new Map();
  private static readonly MAX_VELOCITY_SAMPLES = 10;

  constructor() {
    this.currentExploration = EXPLORATION_RATE;
    this.currentLearningRate = INITIAL_LEARNING_RATE;
  }

  // ─── Momentum Tracking ──────────────────────────────────────────────

  /**
   * Record a price tick for momentum tracking. Call every tick per market.
   * Returns the current momentum state for the market.
   */
  recordPrice(market: string, price: number): void {
    const key = market.toUpperCase();
    const history = this.priceVelocity.get(key) ?? [];
    history.push(price);
    if (history.length > ExitPolicyLearner.MAX_VELOCITY_SAMPLES) history.shift();
    this.priceVelocity.set(key, history);
  }

  /**
   * Get momentum state for a market: 'accelerating', 'decaying', 'reversing'
   * Based on comparing recent velocity (last 3 ticks) vs older velocity (3 before that).
   */
  getMomentumState(market: string, side: 'long' | 'short'): string {
    const history = this.priceVelocity.get(market.toUpperCase());
    if (!history || history.length < 6) return 'accelerating'; // Default: assume trend continuing

    const n = history.length;
    // Recent velocity: average of last 3 price changes
    const recentChanges: number[] = [];
    for (let i = n - 3; i < n; i++) {
      recentChanges.push(history[i] - history[i - 1]);
    }
    // Older velocity: 3 price changes before that
    const olderChanges: number[] = [];
    for (let i = n - 6; i < n - 3; i++) {
      olderChanges.push(history[i] - history[i - 1]);
    }

    const recentAvg = recentChanges.reduce((a, b) => a + b, 0) / recentChanges.length;
    const olderAvg = olderChanges.reduce((a, b) => a + b, 0) / olderChanges.length;

    // Normalize direction: for longs, positive = favorable; for shorts, negative = favorable
    const recentDir = side === 'long' ? recentAvg : -recentAvg;
    const olderDir = side === 'long' ? olderAvg : -olderAvg;

    // Reversal: momentum flipped direction (was favorable, now unfavorable)
    if (olderDir > 0 && recentDir < 0) return 'reversing';
    // Decaying: same direction but weakening
    if (olderDir > 0 && recentDir > 0 && recentDir < olderDir * 0.5) return 'decaying';
    // Accelerating: momentum increasing or maintaining
    return 'accelerating';
  }

  // ─── State Building ─────────────────────────────────────────────────

  /**
   * Discretize position state into exit state buckets.
   * V2: adds momentum dimension.
   */
  buildState(
    pnlPct: number,
    holdingTicks: number,
    volatilityRegime: string,
    distanceToTpPct: number,
    distanceToSlPct: number,
    momentum?: string,
  ): ExitState {
    // PnL buckets (5): deep_loss, loss, flat, profit, big_profit
    let pnlBucket: string;
    if (pnlPct < -8) pnlBucket = 'deep_loss';
    else if (pnlPct < -2) pnlBucket = 'loss';
    else if (pnlPct < 2) pnlBucket = 'flat';
    else if (pnlPct < 8) pnlBucket = 'profit';
    else pnlBucket = 'big_profit';

    // Time buckets (4): fresh, developing, mature, stale
    let timeBucket: string;
    if (holdingTicks < 5) timeBucket = 'fresh';
    else if (holdingTicks < 15) timeBucket = 'developing';
    else if (holdingTicks < 30) timeBucket = 'mature';
    else timeBucket = 'stale';

    // Volatility regime (3)
    const volRegime = (volatilityRegime === 'TRENDING_UP' || volatilityRegime === 'TRENDING_DOWN')
      ? 'trend'
      : volatilityRegime === 'HIGH_VOLATILITY' ? 'volatile' : 'range';

    // TP/SL distance (3)
    let tpSlDistance: string;
    if (distanceToTpPct < 2) tpSlDistance = 'near_tp';
    else if (distanceToSlPct < 2) tpSlDistance = 'near_sl';
    else tpSlDistance = 'balanced';

    return {
      pnlBucket, timeBucket, volRegime, tpSlDistance,
      momentum: momentum ?? 'accelerating',
    };
  }

  /**
   * Recommend an exit action for the current position state.
   */
  recommend(state: ExitState, inDrawdown: boolean): { action: ExitAction; isExploration: boolean; confidence: number } {
    const key = this.stateKey(state);
    const entry = this.policy.get(key);

    // RULE: momentum reversal + profit → strong exit bias
    if (state.momentum === 'reversing' && (state.pnlBucket === 'profit' || state.pnlBucket === 'big_profit')) {
      // Don't override learned policy if it has strong data
      if (!entry || entry.visits < MIN_VISITS_FOR_TRUST) {
        return { action: 'full_close', isExploration: false, confidence: 0.7 };
      }
    }

    // RULE: momentum decaying + big profit + stale → tighten or close
    if (state.momentum === 'decaying' && state.pnlBucket === 'big_profit' && state.timeBucket === 'stale') {
      if (!entry || entry.visits < MIN_VISITS_FOR_TRUST) {
        return { action: 'tighten_stop', isExploration: false, confidence: 0.6 };
      }
    }

    // Exploration (reduced during drawdown)
    const effectiveExploration = inDrawdown ? MIN_EXPLORATION * 0.5 : this.currentExploration;
    if (Math.random() < effectiveExploration) {
      // During drawdown, bias toward protective actions
      const safeActions: ExitAction[] = inDrawdown
        ? ['tighten_stop', 'partial_close', 'full_close']
        : EXIT_ACTIONS;
      const randomAction = safeActions[Math.floor(Math.random() * safeActions.length)];
      return { action: randomAction, isExploration: true, confidence: 0 };
    }

    // Not enough data — rule-based default
    if (!entry || entry.visits < MIN_VISITS_FOR_TRUST) {
      return { action: 'hold', isExploration: false, confidence: 0.3 };
    }

    const bestAction = this.getBestAction(entry);
    const maxQ = entry.qValues[bestAction];
    const totalQ = Object.values(entry.qValues).reduce((s, v) => s + Math.max(0, v), 0);
    const confidence = totalQ > 0 ? Math.max(0, maxQ) / totalQ : 0.5;

    // Low confidence — hold
    if (confidence < 0.35) {
      return { action: 'hold', isExploration: false, confidence: 0.3 };
    }

    return { action: bestAction, isExploration: false, confidence: Math.min(1, confidence) };
  }

  /**
   * Update exit policy after observing the outcome.
   */
  update(state: ExitState, action: ExitAction, reward: number): void {
    if (!Number.isFinite(reward)) return;

    const key = this.stateKey(state);
    let entry = this.policy.get(key);

    if (!entry) {
      entry = {
        qValues: { hold: 0, tighten_stop: 0, extend_tp: 0, partial_close: 0, full_close: 0 },
        visits: 0,
        avgReward: 0,
      };
      this.policy.set(key, entry);
    }

    entry.visits++;
    entry.avgReward = entry.avgReward + (reward - entry.avgReward) / entry.visits;

    if (entry.visits >= MIN_VISITS_FOR_UPDATE) {
      const oldQ = entry.qValues[action];
      entry.qValues[action] = oldQ + this.currentLearningRate * (reward - oldQ);
    }

    this.totalUpdates++;
    this.currentLearningRate = Math.max(MIN_LEARNING_RATE, INITIAL_LEARNING_RATE * Math.pow(LR_DECAY, this.totalUpdates));
    this.currentExploration = Math.max(MIN_EXPLORATION, EXPLORATION_RATE * Math.pow(EXPLORATION_DECAY, this.totalUpdates));

    // Cap policy size (V2 has 540 theoretical states — allow more room)
    if (this.policy.size > 600) {
      const entries = Array.from(this.policy.entries()).sort((a, b) => a[1].visits - b[1].visits);
      for (let i = 0; i < 60; i++) this.policy.delete(entries[i][0]);
    }
  }

  /**
   * Compute reward for an exit action.
   * V2: rewards R-multiple maximization, penalizes stagnation.
   */
  computeExitReward(
    pnlPct: number,
    rMultiple: number,
    holdingTicks: number,
    action: ExitAction,
    subsequentPnlChange: number,
  ): number {
    if (action === 'full_close' || action === 'partial_close') {
      // Base: reward proportional to R-multiple achieved
      let reward = rMultiple * 0.5;

      // Time efficiency: quick profitable exits bonus
      if (pnlPct > 0 && holdingTicks <= 10) reward += 0.15;
      // Stale trade penalty: if held too long for mediocre result
      if (holdingTicks > 25 && Math.abs(pnlPct) < 2) reward -= 0.1;

      // Left money on table: closed winner but price kept going
      if (pnlPct > 0 && subsequentPnlChange > 0.5) reward -= 0.12;
      // Defensive close: avoided further damage
      if (pnlPct < 0 && subsequentPnlChange < -0.5) reward += 0.25;
      // Clean trend capture bonus: caught ≥3% move in ≤15 ticks
      if (pnlPct >= 3 && holdingTicks <= 15) reward += 0.2;

      return reward;
    }

    if (action === 'tighten_stop') {
      // Reward tightening when it would have helped
      if (pnlPct > 0 && subsequentPnlChange < -0.3) return 0.2; // Good tighten — locked profit
      if (pnlPct > 0 && subsequentPnlChange > 0.5) return -0.1; // Bad tighten — stopped out of winner
      return 0.05; // Neutral — tightening in profit is mildly good
    }

    if (action === 'extend_tp') {
      // Reward extending when price continued in favor
      if (subsequentPnlChange > 0.5) return 0.2; // Price kept going — good extension
      if (subsequentPnlChange < -0.3) return -0.15; // Price reversed — should have taken profit
      return 0; // Neutral
    }

    // Action was HOLD
    if (subsequentPnlChange > 0.3) return 0.1;   // Good hold
    if (subsequentPnlChange < -0.5) return -0.15; // Bad hold — should have exited
    // Stagnation penalty: holding a position that's going nowhere
    if (holdingTicks > 20 && Math.abs(subsequentPnlChange) < 0.1) return -0.05;
    return 0;
  }

  // ─── Serialization ──────────────────────────────────────────────────

  serialize(): PersistedAgentState['exitPolicy'] {
    const entries: Array<{ key: string; entry: { qValues: Record<string, number>; visits: number; avgReward: number } }> = [];
    for (const [key, entry] of this.policy) {
      entries.push({ key, entry: { qValues: entry.qValues, visits: entry.visits, avgReward: entry.avgReward } });
    }
    return {
      entries,
      explorationRate: this.currentExploration,
      learningRate: this.currentLearningRate,
      totalUpdates: this.totalUpdates,
    };
  }

  restore(data: PersistedAgentState['exitPolicy']): void {
    if (!data || !Array.isArray(data.entries)) return;
    this.policy.clear();
    for (const { key, entry } of data.entries) {
      if (key && entry && entry.qValues && typeof entry.visits === 'number') {
        this.policy.set(key, {
          qValues: {
            hold: entry.qValues.hold ?? 0,
            tighten_stop: entry.qValues.tighten_stop ?? 0,
            extend_tp: entry.qValues.extend_tp ?? 0,
            partial_close: entry.qValues.partial_close ?? 0,
            full_close: entry.qValues.full_close ?? 0,
          },
          visits: entry.visits,
          avgReward: entry.avgReward ?? 0,
        });
      }
    }
    if (Number.isFinite(data.explorationRate)) this.currentExploration = data.explorationRate;
    if (Number.isFinite(data.learningRate)) this.currentLearningRate = data.learningRate;
    if (Number.isFinite(data.totalUpdates)) this.totalUpdates = data.totalUpdates;
  }

  getMetrics(): { policySize: number; totalUpdates: number; explorationRate: number } {
    return {
      policySize: this.policy.size,
      totalUpdates: this.totalUpdates,
      explorationRate: this.currentExploration,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private stateKey(state: ExitState): string {
    return `${state.pnlBucket}|${state.timeBucket}|${state.volRegime}|${state.tpSlDistance}|${state.momentum}`;
  }

  private getBestAction(entry: ExitPolicyEntry): ExitAction {
    let best: ExitAction = 'hold';
    let bestQ = -Infinity;
    for (const action of EXIT_ACTIONS) {
      if (entry.qValues[action] > bestQ) {
        bestQ = entry.qValues[action];
        best = action;
      }
    }
    return best;
  }

  reset(): void {
    this.policy.clear();
    this.priceVelocity.clear();
    this.currentExploration = EXPLORATION_RATE;
    this.currentLearningRate = INITIAL_LEARNING_RATE;
    this.totalUpdates = 0;
  }
}

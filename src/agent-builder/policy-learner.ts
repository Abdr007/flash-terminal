/**
 * Policy Learner — Learn WHAT to do, not just WHEN to do it.
 *
 * Instead of fixed rules ("if OI > 70% → short"), learn policies:
 * - Which signal+regime+timing combos produce best risk-adjusted returns
 * - When to be aggressive vs conservative
 * - Which strategies to prioritize in which conditions
 *
 * Uses tabular Q-learning: state → action → reward → update policy.
 * States are discretized market conditions. Actions are trading decisions.
 * Rewards are risk-adjusted returns (Sharpe-like).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Discretized market state for policy lookup */
export interface MarketState {
  regime: string;           // RANGING, TRENDING_UP, etc.
  signalDirection: string;  // bullish, bearish, neutral
  signalStrength: string;   // weak, moderate, strong
  volatility: string;       // low, medium, high
  recentPerformance: string;// winning, neutral, losing
}

/** Available actions the policy can recommend */
export type PolicyAction = 'trade_aggressive' | 'trade_normal' | 'trade_conservative' | 'skip';

/** Policy entry: state → action values */
interface PolicyEntry {
  /** Q-values for each action (higher = better) */
  qValues: Record<PolicyAction, number>;
  /** Visit count for exploration/exploitation balance */
  visits: number;
  /** Average reward observed */
  avgReward: number;
}

/** Pattern that the system has learned */
export interface LearnedPattern {
  stateKey: string;
  bestAction: PolicyAction;
  confidence: number;
  avgReward: number;
  visits: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIONS: PolicyAction[] = ['trade_aggressive', 'trade_normal', 'trade_conservative', 'skip'];
const LEARNING_RATE = 0.15;      // How fast to update Q-values
const DISCOUNT_FACTOR = 0.9;     // How much to value future rewards
const EXPLORATION_RATE = 0.15;   // 15% random exploration initially
const MIN_EXPLORATION = 0.05;    // Minimum 5% exploration always
const EXPLORATION_DECAY = 0.995; // Decay exploration over time

// ─── Policy Learner ──────────────────────────────────────────────────────────

export class PolicyLearner {
  private policy: Map<string, PolicyEntry> = new Map();
  private currentExploration: number;
  private totalUpdates = 0;

  constructor() {
    this.currentExploration = EXPLORATION_RATE;
  }

  /**
   * Discretize continuous market conditions into a state key.
   */
  buildState(
    regime: string,
    compositeDirection: string,
    compositeConfidence: number,
    volatilityPct: number,
    recentWinRate: number,
  ): MarketState {
    return {
      regime,
      signalDirection: compositeDirection,
      signalStrength: compositeConfidence >= 0.6 ? 'strong' : compositeConfidence >= 0.35 ? 'moderate' : 'weak',
      volatility: volatilityPct > 5 ? 'high' : volatilityPct > 2 ? 'medium' : 'low',
      recentPerformance: recentWinRate >= 0.55 ? 'winning' : recentWinRate >= 0.40 ? 'neutral' : 'losing',
    };
  }

  /**
   * Get the recommended action for a state (exploit best known, or explore).
   */
  recommend(state: MarketState): { action: PolicyAction; isExploration: boolean; confidence: number } {
    const key = this.stateKey(state);
    const entry = this.policy.get(key);

    // Exploration: try random action sometimes to discover better policies
    if (Math.random() < this.currentExploration) {
      const randomAction = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
      return { action: randomAction, isExploration: true, confidence: 0 };
    }

    // Exploitation: pick best known action
    if (!entry || entry.visits < 3) {
      // Not enough data — default to normal
      return { action: 'trade_normal', isExploration: false, confidence: 0.3 };
    }

    const bestAction = this.getBestAction(entry);
    const maxQ = entry.qValues[bestAction];
    const totalQ = Object.values(entry.qValues).reduce((s, v) => s + Math.max(0, v), 0);
    const confidence = totalQ > 0 ? Math.max(0, maxQ) / totalQ : 0.5;

    return { action: bestAction, isExploration: false, confidence: Math.min(1, confidence) };
  }

  /**
   * Update policy after observing a reward for a state-action pair.
   * reward = risk-adjusted return (positive = good, negative = bad)
   */
  update(state: MarketState, action: PolicyAction, reward: number): void {
    const key = this.stateKey(state);
    let entry = this.policy.get(key);

    if (!entry) {
      entry = {
        qValues: { trade_aggressive: 0, trade_normal: 0, trade_conservative: 0, skip: 0 },
        visits: 0,
        avgReward: 0,
      };
      this.policy.set(key, entry);
    }

    // Q-learning update: Q(s,a) = Q(s,a) + α * (reward + γ * maxQ(s') - Q(s,a))
    // Simplified: we don't have a clear "next state", so just update with reward
    const oldQ = entry.qValues[action];
    entry.qValues[action] = oldQ + LEARNING_RATE * (reward - oldQ);

    entry.visits++;
    entry.avgReward = entry.avgReward + (reward - entry.avgReward) / entry.visits;

    // Decay exploration rate
    this.totalUpdates++;
    this.currentExploration = Math.max(MIN_EXPLORATION, EXPLORATION_RATE * Math.pow(EXPLORATION_DECAY, this.totalUpdates));

    // Cap policy size to prevent memory issues
    if (this.policy.size > 500) {
      // Remove least-visited entries
      const entries = Array.from(this.policy.entries()).sort((a, b) => a[1].visits - b[1].visits);
      for (let i = 0; i < 50; i++) this.policy.delete(entries[i][0]);
    }
  }

  /**
   * Compute risk-adjusted reward from a trade outcome.
   * Reward = PnL / risk taken, penalized for drawdown.
   */
  computeReward(pnl: number, collateral: number, leverage: number, holdingTicks: number): number {
    if (!Number.isFinite(pnl) || collateral <= 0) return 0;

    // Base: return on risk
    const riskTaken = collateral * leverage;
    const returnOnRisk = riskTaken > 0 ? pnl / riskTaken : 0;

    // Time penalty: longer holds should earn more (efficiency)
    const timePenalty = holdingTicks > 20 ? 0.9 : 1.0; // Slight penalty for slow trades

    // Win bonus / loss penalty (asymmetric — losses hurt more)
    const asymmetry = pnl >= 0 ? 1.0 : 1.5; // Losses penalized 1.5x

    return returnOnRisk * timePenalty * (pnl >= 0 ? 1 : -asymmetry);
  }

  /**
   * Convert a policy action to trading parameters.
   */
  actionToParams(action: PolicyAction): { sizeMultiplier: number; confidenceFloor: number; shouldTrade: boolean } {
    switch (action) {
      case 'trade_aggressive':
        return { sizeMultiplier: 1.3, confidenceFloor: 0.50, shouldTrade: true };
      case 'trade_normal':
        return { sizeMultiplier: 1.0, confidenceFloor: 0.60, shouldTrade: true };
      case 'trade_conservative':
        return { sizeMultiplier: 0.5, confidenceFloor: 0.75, shouldTrade: true };
      case 'skip':
        return { sizeMultiplier: 0, confidenceFloor: 1.0, shouldTrade: false };
    }
  }

  /**
   * Get all learned patterns sorted by confidence.
   */
  getLearnedPatterns(): LearnedPattern[] {
    const patterns: LearnedPattern[] = [];
    for (const [key, entry] of this.policy) {
      if (entry.visits < 3) continue;
      const bestAction = this.getBestAction(entry);
      const maxQ = entry.qValues[bestAction];
      const totalQ = Object.values(entry.qValues).reduce((s, v) => s + Math.max(0, v), 0);
      patterns.push({
        stateKey: key,
        bestAction,
        confidence: totalQ > 0 ? maxQ / totalQ : 0,
        avgReward: entry.avgReward,
        visits: entry.visits,
      });
    }
    return patterns.sort((a, b) => b.avgReward - a.avgReward);
  }

  /**
   * Get exploration rate for logging.
   */
  getExplorationRate(): number {
    return this.currentExploration;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private stateKey(state: MarketState): string {
    return `${state.regime}|${state.signalDirection}|${state.signalStrength}|${state.volatility}|${state.recentPerformance}`;
  }

  private getBestAction(entry: PolicyEntry): PolicyAction {
    let best: PolicyAction = 'trade_normal';
    let bestQ = -Infinity;
    for (const action of ACTIONS) {
      if (entry.qValues[action] > bestQ) {
        bestQ = entry.qValues[action];
        best = action;
      }
    }
    return best;
  }

  reset(): void {
    this.policy.clear();
    this.currentExploration = EXPLORATION_RATE;
    this.totalUpdates = 0;
  }
}

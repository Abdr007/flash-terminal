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
const INITIAL_LEARNING_RATE = 0.15; // Starting learning rate
const MIN_LEARNING_RATE = 0.03;     // Floor — never stop learning entirely
const LR_DECAY = 0.998;            // Learning rate decays over time (prevents overfitting)
const EXPLORATION_RATE = 0.15;
const MIN_EXPLORATION = 0.05;
const EXPLORATION_DECAY = 0.995;
const MIN_VISITS_FOR_UPDATE = 2;    // Minimum visits before Q-value updates take effect
const MIN_VISITS_FOR_TRUST = 5;     // Minimum visits before trusting a policy decision

// ─── Policy Learner ──────────────────────────────────────────────────────────

export class PolicyLearner {
  private policy: Map<string, PolicyEntry> = new Map();
  private currentExploration: number;
  private currentLearningRate: number;
  private totalUpdates = 0;
  /** Track recent rewards for Sharpe computation */
  private recentRewards: number[] = [];
  /** Track if system is in drawdown (disable exploration) */
  private inDrawdown = false;
  /** Evaluation metrics */
  private metrics = { totalReward: 0, maxDrawdown: 0, peakReward: 0, winCount: 0, lossCount: 0 };

  constructor() {
    this.currentExploration = EXPLORATION_RATE;
    this.currentLearningRate = INITIAL_LEARNING_RATE;
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

    // Exploration — but DISABLE during drawdowns (protect capital)
    const effectiveExploration = this.inDrawdown ? MIN_EXPLORATION * 0.5 : this.currentExploration;
    if (Math.random() < effectiveExploration) {
      // During drawdown exploration: only explore conservative or skip (never aggressive)
      const safeActions: PolicyAction[] = this.inDrawdown
        ? ['trade_conservative', 'skip']
        : ACTIONS;
      const randomAction = safeActions[Math.floor(Math.random() * safeActions.length)];
      return { action: randomAction, isExploration: true, confidence: 0 };
    }

    // Not enough data — FALL BACK to rule-based (confidence gating)
    if (!entry || entry.visits < MIN_VISITS_FOR_TRUST) {
      return { action: 'trade_normal', isExploration: false, confidence: 0.3 };
    }

    const bestAction = this.getBestAction(entry);
    const maxQ = entry.qValues[bestAction];
    const totalQ = Object.values(entry.qValues).reduce((s, v) => s + Math.max(0, v), 0);
    const confidence = totalQ > 0 ? Math.max(0, maxQ) / totalQ : 0.5;

    // CONFIDENCE GATING: if policy is uncertain, fall back to rule-based
    if (confidence < 0.35) {
      return { action: 'trade_normal', isExploration: false, confidence: 0.3 };
    }

    return { action: bestAction, isExploration: false, confidence: Math.min(1, confidence) };
  }

  /**
   * Update policy after observing a reward for a state-action pair.
   * reward = risk-adjusted return (positive = good, negative = bad)
   */
  update(state: MarketState, action: PolicyAction, reward: number): void {
    if (!Number.isFinite(reward)) return;

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

    entry.visits++;
    entry.avgReward = entry.avgReward + (reward - entry.avgReward) / entry.visits;

    // ANTI-OVERFITTING: only update Q-values after minimum sample threshold
    if (entry.visits >= MIN_VISITS_FOR_UPDATE) {
      const oldQ = entry.qValues[action];
      entry.qValues[action] = oldQ + this.currentLearningRate * (reward - oldQ);
    }

    // Track metrics
    this.totalUpdates++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 50) this.recentRewards.shift();

    this.metrics.totalReward += reward;
    if (reward > 0) this.metrics.winCount++;
    else this.metrics.lossCount++;
    this.metrics.peakReward = Math.max(this.metrics.peakReward, this.metrics.totalReward);
    const currentDD = this.metrics.peakReward - this.metrics.totalReward;
    this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, currentDD);

    // Update drawdown state for exploration control
    this.inDrawdown = currentDD > 0.5;

    // Decay learning rate over time (prevents overfitting to recent data)
    this.currentLearningRate = Math.max(MIN_LEARNING_RATE, INITIAL_LEARNING_RATE * Math.pow(LR_DECAY, this.totalUpdates));

    // Decay exploration — but stabilize if performance is consistent
    const rewardStdDev = this.computeRewardStdDev();
    const stabilityBonus = rewardStdDev < 0.3 ? 0.5 : 1.0; // Stable = explore less
    this.currentExploration = Math.max(MIN_EXPLORATION, EXPLORATION_RATE * Math.pow(EXPLORATION_DECAY, this.totalUpdates) * stabilityBonus);

    // Cap policy size
    if (this.policy.size > 500) {
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

    const riskTaken = collateral * leverage;
    const returnOnRisk = riskTaken > 0 ? pnl / riskTaken : 0;

    // Time efficiency: quick wins rewarded, slow trades penalized
    const timeFactor = holdingTicks <= 5 ? 1.1 : holdingTicks <= 15 ? 1.0 : holdingTicks <= 30 ? 0.9 : 0.75;

    // Asymmetric: losses hurt more than wins help (loss aversion)
    const asymmetry = pnl >= 0 ? 1.0 : 1.8;

    // Drawdown penalty: large losses penalized exponentially
    const ddPenalty = pnl < 0 ? Math.pow(Math.abs(returnOnRisk) + 1, 1.3) : 1.0;

    // Consistency bonus: reward trades close to average (stable system)
    let consistencyBonus = 0;
    if (this.recentRewards.length >= 5 && pnl > 0) {
      const avgReward = this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length;
      if (avgReward > 0 && returnOnRisk > 0) {
        consistencyBonus = 0.1; // Bonus for continuing a winning streak
      }
    }

    const baseReward = returnOnRisk * timeFactor;
    return pnl >= 0
      ? baseReward + consistencyBonus
      : -Math.abs(baseReward) * asymmetry * ddPenalty;
  }

  // ─── Evaluation Metrics ────────────────────────────────────────────

  /**
   * Compute Sharpe ratio from recent rewards.
   */
  getSharpeRatio(): number {
    if (this.recentRewards.length < 5) return 0;
    const mean = this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length;
    const stdDev = this.computeRewardStdDev();
    return stdDev > 0 ? mean / stdDev : 0;
  }

  /**
   * Get all evaluation metrics.
   */
  getMetrics(): { sharpe: number; maxDrawdown: number; winRate: number; totalUpdates: number; learningRate: number; explorationRate: number; policySize: number } {
    const total = this.metrics.winCount + this.metrics.lossCount;
    return {
      sharpe: this.getSharpeRatio(),
      maxDrawdown: this.metrics.maxDrawdown,
      winRate: total > 0 ? this.metrics.winCount / total : 0,
      totalUpdates: this.totalUpdates,
      learningRate: this.currentLearningRate,
      explorationRate: this.currentExploration,
      policySize: this.policy.size,
    };
  }

  /**
   * Set drawdown state externally (from drawdown manager).
   */
  setDrawdownState(inDrawdown: boolean): void {
    this.inDrawdown = inDrawdown;
  }

  private computeRewardStdDev(): number {
    if (this.recentRewards.length < 3) return 1;
    const mean = this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length;
    const variance = this.recentRewards.reduce((s, r) => s + (r - mean) ** 2, 0) / this.recentRewards.length;
    return Math.sqrt(variance);
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

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

/** Compressed market state — fewer dimensions = denser learning */
export interface MarketState {
  /** Grouped regime: trend, range, volatile (3 values, not 5) */
  regime: string;
  /** Signal direction (3 values) */
  signalDirection: string;
  /** Combined condition: signal strength + volatility (4 values) */
  condition: string;
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
const EXPLORATION_RATE = 0.12;       // Start lower — 12% not 15%
const MIN_EXPLORATION = 0.025;       // Floor at 2.5% (prevents stagnation)
const EXPLORATION_DECAY = 0.997;     // Slower decay — reach floor in ~200 updates
const MIN_VISITS_FOR_UPDATE = 2;    // Minimum visits before Q-value updates take effect
const MIN_VISITS_FOR_TRUST = 25;    // Minimum visits before trusting a policy decision

// ─── Policy Learner ──────────────────────────────────────────────────────────

export class PolicyLearner {
  private policy: Map<string, PolicyEntry> = new Map();
  private currentExploration: number;
  private currentLearningRate: number;
  private totalUpdates = 0;
  /** Rolling reward windows for metrics */
  private recentRewards: number[] = [];      // Last 50
  private shortWindow: number[] = [];        // Last 10 (fast degradation detect)
  /** Track if system is in drawdown (disable exploration) */
  private inDrawdown = false;
  /** Rolling evaluation metrics */
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
    _recentWinRate: number,
  ): MarketState {
    // Compress regime: 5 types → 3 groups
    const regimeGroup = (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') ? 'trend'
      : (regime === 'HIGH_VOLATILITY') ? 'volatile'
      : 'range'; // RANGING + COMPRESSION

    // Compress signal strength + volatility into one "condition" dimension
    const isStrong = compositeConfidence >= 0.5;
    const isHighVol = volatilityPct > 4;
    const condition = isStrong
      ? (isHighVol ? 'strong_volatile' : 'strong_calm')
      : (isHighVol ? 'weak_volatile' : 'weak_calm');

    return {
      regime: regimeGroup,
      signalDirection: compositeDirection,
      condition,
    };
    // Total states: 3 regimes × 3 directions × 4 conditions = 36
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

    // Track metrics in dual rolling windows
    this.totalUpdates++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 50) this.recentRewards.shift();
    this.shortWindow.push(reward);
    if (this.shortWindow.length > 10) this.shortWindow.shift();

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
  /**
   * Compute risk-adjusted reward from a trade outcome.
   *
   * V2 formula:
   *   reward = (PnL / risk) × time_efficiency × consistency_bonus − drawdown_penalty
   *
   * Improvements over V1:
   * - Non-linear drawdown penalty (exponential for large losses)
   * - Stagnation penalty for trades that go nowhere
   * - Clean trend capture bonus (high R in few ticks)
   * - Graduated time efficiency (smoother curve)
   */
  computeReward(pnl: number, collateral: number, leverage: number, holdingTicks: number): number {
    if (!Number.isFinite(pnl) || collateral <= 0) return 0;

    const riskTaken = collateral * leverage;
    const returnOnRisk = riskTaken > 0 ? pnl / riskTaken : 0;

    // Time efficiency: smooth curve instead of stepped
    // Optimal: 5-12 ticks. Penalty ramps beyond 20.
    let timeFactor: number;
    if (holdingTicks <= 3) timeFactor = 1.05;           // Very quick — slight bonus
    else if (holdingTicks <= 12) timeFactor = 1.1;       // Sweet spot
    else if (holdingTicks <= 20) timeFactor = 1.0;       // Normal
    else if (holdingTicks <= 30) timeFactor = 0.85;      // Getting stale
    else timeFactor = 0.65;                               // Stagnant — heavy penalty

    // Asymmetric: losses hurt 2x (prospect theory)
    const asymmetry = pnl >= 0 ? 1.0 : 2.0;

    // Non-linear drawdown penalty: exponential for large losses
    let ddPenalty = 1.0;
    if (pnl < 0) {
      const absRoR = Math.abs(returnOnRisk);
      ddPenalty = Math.pow(absRoR + 1, 1.5); // steeper curve for bigger losses
    }

    // Consistency bonus: reward maintaining a winning streak
    let consistencyBonus = 0;
    if (this.recentRewards.length >= 5 && pnl > 0) {
      const recentPositive = this.recentRewards.slice(-5).filter((r) => r > 0).length;
      if (recentPositive >= 3) {
        consistencyBonus = 0.1 + (recentPositive - 3) * 0.05; // 0.1 at 3/5, 0.2 at 5/5
      }
    }

    // Clean trend capture bonus: caught a big move quickly
    if (pnl > 0 && returnOnRisk > 0.03 && holdingTicks <= 10) {
      consistencyBonus += 0.15;
    }

    // Stagnation penalty: trade went nowhere (PnL ≈ 0 after many ticks)
    let stagnationPenalty = 0;
    if (holdingTicks > 20 && Math.abs(returnOnRisk) < 0.005) {
      stagnationPenalty = 0.1; // Penalty for wasting a position slot
    }

    const baseReward = returnOnRisk * timeFactor;
    const reward = pnl >= 0
      ? baseReward + consistencyBonus - stagnationPenalty
      : -Math.abs(baseReward) * asymmetry * ddPenalty - stagnationPenalty;

    return Number.isFinite(reward) ? reward : 0;
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
  getMetrics(): {
    sharpe: number; shortSharpe: number; maxDrawdown: number; winRate: number;
    totalUpdates: number; learningRate: number; explorationRate: number;
    policySize: number; degrading: boolean;
  } {
    const total = this.metrics.winCount + this.metrics.lossCount;
    const longSharpe = this.getSharpeRatio();

    // Short-window Sharpe (fast degradation detection)
    let shortSharpe = 0;
    if (this.shortWindow.length >= 5) {
      const mean = this.shortWindow.reduce((a, b) => a + b, 0) / this.shortWindow.length;
      const variance = this.shortWindow.reduce((s, r) => s + (r - mean) ** 2, 0) / this.shortWindow.length;
      const std = Math.sqrt(variance);
      shortSharpe = std > 0 ? mean / std : 0;
    }

    // Degradation: short-window Sharpe significantly worse than long-window
    const degrading = this.shortWindow.length >= 5 && this.recentRewards.length >= 20
      && shortSharpe < longSharpe - 0.5;

    return {
      sharpe: longSharpe,
      shortSharpe,
      maxDrawdown: this.metrics.maxDrawdown,
      winRate: total > 0 ? this.metrics.winCount / total : 0,
      totalUpdates: this.totalUpdates,
      learningRate: this.currentLearningRate,
      explorationRate: this.currentExploration,
      policySize: this.policy.size,
      degrading,
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
   * Compute intermediate reward for open positions (shaping signal).
   * Called every tick for active trades — rewards partial progress.
   */
  computeIntermediateReward(currentPnlPct: number, rMultiple: number, holdingTicks: number): number {
    let reward = 0;

    // Reward reaching 1R milestone
    if (rMultiple >= 1.0) reward += 0.15;

    // Reward positive PnL (scaled down — it's partial)
    if (currentPnlPct > 0) reward += currentPnlPct * 0.01;

    // Penalize holding losses too long
    if (currentPnlPct < -1 && holdingTicks > 10) reward -= 0.1;

    // Penalize deep drawdown
    if (currentPnlPct < -3) reward -= 0.2;

    return reward * 0.3; // Scale down — intermediate rewards are small shaping signals
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
    return `${state.regime}|${state.signalDirection}|${state.condition}`;
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

  // ─── Serialization ──────────────────────────────────────────────────

  serialize(): {
    entries: Array<{ key: string; entry: { qValues: Record<string, number>; visits: number; avgReward: number } }>;
    explorationRate: number;
    learningRate: number;
    totalUpdates: number;
    recentRewards: number[];
    shortWindow: number[];
    metrics: { totalReward: number; maxDrawdown: number; peakReward: number; winCount: number; lossCount: number };
  } {
    const entries: Array<{ key: string; entry: { qValues: Record<string, number>; visits: number; avgReward: number } }> = [];
    for (const [key, entry] of this.policy) {
      entries.push({ key, entry: { qValues: { ...entry.qValues }, visits: entry.visits, avgReward: entry.avgReward } });
    }
    return {
      entries,
      explorationRate: this.currentExploration,
      learningRate: this.currentLearningRate,
      totalUpdates: this.totalUpdates,
      recentRewards: [...this.recentRewards],
      shortWindow: [...this.shortWindow],
      metrics: { ...this.metrics },
    };
  }

  restore(data: ReturnType<PolicyLearner['serialize']>): void {
    if (!data || !Array.isArray(data.entries)) return;
    this.policy.clear();
    for (const { key, entry } of data.entries) {
      if (key && entry && entry.qValues && typeof entry.visits === 'number') {
        this.policy.set(key, {
          qValues: {
            trade_aggressive: entry.qValues.trade_aggressive ?? 0,
            trade_normal: entry.qValues.trade_normal ?? 0,
            trade_conservative: entry.qValues.trade_conservative ?? 0,
            skip: entry.qValues.skip ?? 0,
          },
          visits: entry.visits,
          avgReward: entry.avgReward ?? 0,
        });
      }
    }
    if (Number.isFinite(data.explorationRate)) this.currentExploration = data.explorationRate;
    if (Number.isFinite(data.learningRate)) this.currentLearningRate = data.learningRate;
    if (Number.isFinite(data.totalUpdates)) this.totalUpdates = data.totalUpdates;
    if (Array.isArray(data.recentRewards)) this.recentRewards = data.recentRewards.filter(Number.isFinite).slice(-50);
    if (Array.isArray(data.shortWindow)) this.shortWindow = data.shortWindow.filter(Number.isFinite).slice(-10);
    if (data.metrics && typeof data.metrics === 'object') {
      const m = data.metrics;
      if (Number.isFinite(m.totalReward)) this.metrics.totalReward = m.totalReward;
      if (Number.isFinite(m.maxDrawdown)) this.metrics.maxDrawdown = m.maxDrawdown;
      if (Number.isFinite(m.peakReward)) this.metrics.peakReward = m.peakReward;
      if (Number.isFinite(m.winCount)) this.metrics.winCount = m.winCount;
      if (Number.isFinite(m.lossCount)) this.metrics.lossCount = m.lossCount;
    }
  }

  reset(): void {
    this.policy.clear();
    this.currentExploration = EXPLORATION_RATE;
    this.totalUpdates = 0;
  }
}

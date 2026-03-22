// ─────────────────────────────────────────────────────────────────────────────
// System Governor — stabilizes, normalizes, and governs all adaptive systems
// Prevents over-reaction, capital underutilization, and feedback loop conflicts
// Zero external dependencies, self-contained types, bounded storage throughout
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

export interface GovernorState {
  lastRawMultiplier: number; lastNormalizedMultiplier: number;
  effectiveSizeRatio: number; clampEvents: number;
  recentChanges: ChangeRecord[]; frozen: boolean; frozenUntilTrade: number;
  signalStable: boolean; scoreBuffer: number; stabilitySizeMultiplier: number;
  utilizationPct: number; filterRelaxation: number;
  metaStabilityScore: number; globalSizeOverride: number; adaptationsEnabled: boolean;
  shadowActive: boolean; shadowBetterCount: number; revertRecommended: boolean;
  // V2 additions
  clampFrequency: number;        // % of recent normalizations that were clamped
  dominantFactor: string;        // largest reducer in multiplier chain
  shadowAutoReverted: boolean;   // true if auto-revert was executed
  executionStabilityScore: number; // 0-25 component for meta-stability
  dualLane: 'fast' | 'safe';    // current execution lane
}

/** V2: Clamp intelligence — per-factor breakdown */
export interface ClampAnalytics {
  clampFrequency: number;        // % of last 100 evaluations that were clamped
  dominantFactor: string;        // name of the factor causing most clamping
  factorBreakdown: Array<{ name: string; avgValue: number; clampContribution: number }>;
  recommendation: string;        // actionable advice
}

/** V2: Dual-lane execution mode */
export type ExecutionLane = 'fast' | 'safe';

/** V2: Governor transparency report for `agent governor` command */
export interface GovernorTransparency {
  clampAnalytics: ClampAnalytics;
  utilizationState: CapitalUtilization & { relaxationReason: string };
  shadowDelta: ShadowComparison;
  activeRestrictions: string[];
  executionLane: ExecutionLane;
  metaStabilityComponents: MetaStabilityScore['components'] & { executionStability: number };
  frozen: boolean;
  freezeReason: string;
}

export interface ChangeRecord {
  tick: number;
  tradeCount: number;
  source: string;
  parameter: string;
  oldValue: number;
  newValue: number;
  timestamp: number;
}

export interface MultiplierNormalization {
  rawMultiplier: number;
  normalizedMultiplier: number;
  clamped: boolean;
  reason: string;
  baseSize: number;
  rawSize: number;
  finalSize: number;
}

export interface PriorityLevel {
  name: string;
  level: number;
  canOverride: Set<string>;
}

export interface SignalStabilityResult {
  stable: boolean;
  scoreVariance: number;
  evVariance: number;
  flipFrequency: number;
  extraScoreBuffer: number;
  sizeMultiplier: number;
}

export interface CapitalUtilization {
  deployedPct: number;
  avgPositionSizePct: number;
  tradesSkipped: number;
  tradesExecuted: number;
  skipRate: number;
  underUtilized: boolean;
  filterRelaxation: number;
}

export interface MetaStabilityScore {
  score: number;
  components: {
    sharpeConsistency: number;
    drawdownSmoothness: number;
    parameterStability: number;
    decisionConsistency: number;
  };
  action: 'none' | 'reduce_size' | 'disable_adaptations';
  globalSizeMultiplier: number;
}

export interface ShadowComparison {
  shadowPnl: number;
  livePnl: number;
  shadowSharpe: number;
  liveSharpe: number;
  shadowBetter: boolean;
  revertRecommended: boolean;
  reason: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_MULTIPLIER = 0.4;
const MAX_MULTIPLIER = 1.5;
const MAX_CHANGES_PER_100_TRADES = 3;
const FREEZE_DURATION_TRADES = 50;
const MAX_CHANGE_HISTORY = 200;
const CIRCULAR_BUFFER_SIZE = 50;
const SHADOW_BUFFER_SIZE = 100;
const HISTORY_BUFFER_SIZE = 100;
const SIGNAL_WINDOW = 20;
const SHADOW_MIN_TRADES = 20;
const SHADOW_REVERT_THRESHOLD = 3;

// ── Priority hierarchy definition ────────────────────────────────────────────

const SYSTEM_LEVELS: [string, number][] = [
  ['killswitch', 1], ['drawdown', 1], ['daily_loss', 1],           // SAFETY
  ['slippage', 2], ['execution_feedback', 2],                       // EXECUTION
  ['real_ev', 3], ['quality_filter', 3], ['stability', 3],          // EDGE
  ['policy_learner', 4], ['exit_policy', 4], ['scoring_weights', 4],// LEARNING
  ['edge_refiner', 5], ['regime_tuning', 5],                        // OPTIMIZATION
];

// Build priority map: each system can override all systems at lower priority (higher level number)
const PRIORITY_LEVELS: Record<string, PriorityLevel> = {};
for (const [name, level] of SYSTEM_LEVELS) {
  const canOverride = new Set(SYSTEM_LEVELS.filter(([, l]) => l > level).map(([n]) => n));
  PRIORITY_LEVELS[name] = { name, level, canOverride };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safe(v: number, fallback: number = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(safe(v), min), max);
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + safe(v), 0) / values.length;
  const sumSqDiff = values.reduce((s, v) => s + (safe(v) - mean) ** 2, 0);
  return sumSqDiff / values.length;
}

function stdDev(values: number[]): number {
  return Math.sqrt(variance(values));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + safe(v), 0) / values.length;
}

function sharpeFromPnls(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const m = mean(pnls);
  const sd = stdDev(pnls);
  if (sd === 0) return m > 0 ? 3 : m < 0 ? -3 : 0;
  return safe(m / sd, 0);
}

/** Bounded circular buffer — push evicts oldest when full */
class CircularBuffer<T> {
  private buf: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.maxSize) {
      this.buf.shift();
    }
  }

  toArray(): T[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }

  last(n: number): T[] {
    return this.buf.slice(-n);
  }

  clear(): void {
    this.buf = [];
  }
}

// ── SystemGovernor ───────────────────────────────────────────────────────────

export class SystemGovernor {
  // Phase 1: Multiplier normalization
  private _lastRawMultiplier = 1;
  private _lastNormalizedMultiplier = 1;
  private _effectiveSizeRatio = 1;
  private _clampEvents = 0;
  // Phase 3: Change rate limiting
  private changeHistory = new CircularBuffer<ChangeRecord>(MAX_CHANGE_HISTORY);
  private _frozen = false;
  private _frozenUntilTrade = 0;
  private _freezeBaseTradeCount = 0;
  // Phase 4: Signal stability
  private _signalStable = true;
  private _scoreBuffer = 0;
  private _stabilitySizeMultiplier = 1;
  // Phase 5: Capital utilization
  private _utilizationPct = 0;
  private _filterRelaxation = 0;
  // Phase 6: Meta-stability
  private _metaStabilityScore = 100;
  private _globalSizeOverride = 1;
  private _adaptationsEnabled = true;
  // Phase 7: Shadow validation
  private shadowPnls = new CircularBuffer<number>(SHADOW_BUFFER_SIZE);
  private livePnls = new CircularBuffer<number>(SHADOW_BUFFER_SIZE);
  private _shadowBetterCount = 0;
  private _revertRecommended = false;
  private _shadowActive = false;
  // V2: Clamp intelligence tracking
  private clampLog = new CircularBuffer<{ clamped: boolean; rawMult: number; factors: Array<{ name: string; value: number }> }>(100);
  private _dominantFactor = 'none';
  private _clampFrequency = 0;
  // V2: Shadow reversion enforcement
  private _shadowAutoReverted = false;
  private _shadowRevertFreezeUntil = 0;
  // V2: Execution stability for meta-stability
  private _execStabilityScore = 25; // 0-25
  // V2: Dual-lane mode
  private _dualLane: ExecutionLane = 'safe';
  // V2: Utilization relaxation conditions
  private _lastRelaxReason = '';
  // Internal tracking buffers
  private scoreHistory = new CircularBuffer<number>(CIRCULAR_BUFFER_SIZE);
  private evHistory = new CircularBuffer<number>(CIRCULAR_BUFFER_SIZE);
  private decisionHistory = new CircularBuffer<string>(CIRCULAR_BUFFER_SIZE);
  private sharpeHistory = new CircularBuffer<number>(HISTORY_BUFFER_SIZE);
  private drawdownHistory = new CircularBuffer<number>(HISTORY_BUFFER_SIZE);

  constructor() { /* all state initialized via field defaults */ }

  // ── PHASE 1: Multiplier Normalization ──

  normalizeMultiplier(rawCompositeMultiplier: number, baseSize: number, factorBreakdown?: Array<{ name: string; value: number }>): MultiplierNormalization {
    const rawMult = safe(rawCompositeMultiplier, 1);
    const base = safe(baseSize, 0);
    let normalized = rawMult;
    let clamped = false;
    let reason = '';

    const ratio = rawMult;

    if (ratio < MIN_MULTIPLIER) {
      normalized = MIN_MULTIPLIER;
      clamped = true;
      reason = 'capital starvation prevention';
      this._clampEvents++;
    } else if (ratio > MAX_MULTIPLIER) {
      normalized = MAX_MULTIPLIER;
      clamped = true;
      reason = 'over-allocation cap';
      this._clampEvents++;
    }

    // V2: Track clamp analytics with factor breakdown
    this.clampLog.push({ clamped, rawMult, factors: factorBreakdown ?? [] });
    this._updateClampAnalytics();

    // V2: If clamping frequency > 40%, reduce non-critical penalties by 10%
    if (this._clampFrequency > 0.4 && clamped && ratio < MIN_MULTIPLIER) {
      // Boost the normalized multiplier slightly to counteract over-suppression
      normalized = Math.min(MAX_MULTIPLIER, normalized * 1.10);
      reason += ' (V2: anti-suppression boost +10%)';
    }

    this._lastRawMultiplier = rawMult;
    this._lastNormalizedMultiplier = normalized;
    this._effectiveSizeRatio = normalized;

    const rawSize = safe(base * rawMult, 0);
    const finalSize = safe(base * normalized, 0);

    return {
      rawMultiplier: rawMult,
      normalizedMultiplier: normalized,
      clamped,
      reason,
      baseSize: base,
      rawSize,
      finalSize,
    };
  }

  /** V2: Compute clamp frequency and dominant factor from recent history */
  private _updateClampAnalytics(): void {
    const log = this.clampLog.toArray();
    if (log.length === 0) return;

    // Clamp frequency
    const clampCount = log.filter(e => e.clamped).length;
    this._clampFrequency = clampCount / log.length;

    // Dominant factor: which factor has the lowest average value (most restrictive)
    const factorSums = new Map<string, { sum: number; count: number }>();
    for (const entry of log) {
      for (const f of entry.factors) {
        const existing = factorSums.get(f.name) ?? { sum: 0, count: 0 };
        existing.sum += safe(f.value, 1);
        existing.count++;
        factorSums.set(f.name, existing);
      }
    }

    let minAvg = Infinity;
    let dominant = 'none';
    for (const [name, data] of factorSums) {
      if (data.count === 0) continue;
      const avg = data.sum / data.count;
      if (avg < minAvg) {
        minAvg = avg;
        dominant = name;
      }
    }
    this._dominantFactor = dominant;
  }

  /** V2 Phase 1: Get detailed clamp analytics */
  getClampAnalytics(): ClampAnalytics {
    const log = this.clampLog.toArray();
    const factorSums = new Map<string, { sum: number; count: number; clampContrib: number }>();

    for (const entry of log) {
      for (const f of entry.factors) {
        const existing = factorSums.get(f.name) ?? { sum: 0, count: 0, clampContrib: 0 };
        existing.sum += safe(f.value, 1);
        existing.count++;
        if (entry.clamped && safe(f.value, 1) < 0.7) existing.clampContrib++;
        factorSums.set(f.name, existing);
      }
    }

    const breakdown = Array.from(factorSums.entries())
      .map(([name, data]) => ({
        name,
        avgValue: data.count > 0 ? data.sum / data.count : 1,
        clampContribution: log.length > 0 ? data.clampContrib / log.length : 0,
      }))
      .sort((a, b) => a.avgValue - b.avgValue);

    let recommendation = 'System operating normally';
    if (this._clampFrequency > 0.4) {
      recommendation = `Clamp rate ${(this._clampFrequency * 100).toFixed(0)}% > 40% — reduce non-critical penalties`;
      if (this._dominantFactor !== 'none') {
        recommendation += ` (dominant suppressor: ${this._dominantFactor})`;
      }
    }

    return {
      clampFrequency: this._clampFrequency,
      dominantFactor: this._dominantFactor,
      factorBreakdown: breakdown.slice(0, 5), // top 5
      recommendation,
    };
  }

  // ── PHASE 2: Priority Hierarchy ──

  validateChange(source: string, target: string, _currentLevel: number): { allowed: boolean; reason: string } {
    const sourcePriority = PRIORITY_LEVELS[source];
    const targetPriority = PRIORITY_LEVELS[target];

    if (!sourcePriority) {
      return { allowed: false, reason: `unknown source system: ${source}` };
    }
    if (!targetPriority) {
      return { allowed: false, reason: `unknown target system: ${target}` };
    }

    // A system at level N cannot override decisions from level < N (higher priority)
    if (sourcePriority.level > targetPriority.level) {
      return {
        allowed: false,
        reason: `${source} (level ${sourcePriority.level}) cannot override ${target} (level ${targetPriority.level}) — lower priority cannot override higher`,
      };
    }

    // Same level systems cannot override each other
    if (sourcePriority.level === targetPriority.level && source !== target) {
      return {
        allowed: false,
        reason: `${source} and ${target} are same priority level ${sourcePriority.level} — peer systems cannot override each other`,
      };
    }

    // Check explicit override set
    if (source === target) {
      return { allowed: true, reason: 'self-modification allowed' };
    }

    if (sourcePriority.canOverride.has(target)) {
      return { allowed: true, reason: `${source} (level ${sourcePriority.level}) may override ${target} (level ${targetPriority.level})` };
    }

    return {
      allowed: false,
      reason: `${source} does not have explicit override permission for ${target}`,
    };
  }

  // ── PHASE 3: Change Rate Limiting ──

  recordChange(
    source: string,
    parameter: string,
    oldValue: number,
    newValue: number,
    tick: number,
    tradeCount: number,
  ): boolean {
    // Check freeze first
    this.checkFreeze(tradeCount);
    if (this._frozen) {
      return false;
    }

    // Count changes in the last 100 trades
    const recentTradeFloor = tradeCount - 100;
    const recentChanges = this.changeHistory
      .toArray()
      .filter(c => c.tradeCount > recentTradeFloor);

    if (recentChanges.length >= MAX_CHANGES_PER_100_TRADES) {
      // Freeze adaptive updates
      this._frozen = true;
      this._freezeBaseTradeCount = tradeCount;
      this._frozenUntilTrade = tradeCount + FREEZE_DURATION_TRADES;
      return false;
    }

    // Record the change
    const record: ChangeRecord = {
      tick,
      tradeCount,
      source,
      parameter,
      oldValue: safe(oldValue),
      newValue: safe(newValue),
      timestamp: Date.now(),
    };
    this.changeHistory.push(record);
    return true;
  }

  isFrozen(): boolean {
    return this._frozen;
  }

  checkFreeze(currentTradeCount: number): void {
    if (this._frozen && currentTradeCount >= this._frozenUntilTrade) {
      this._frozen = false;
      this._frozenUntilTrade = 0;
    }
  }

  getChangeHistory(last?: number): ChangeRecord[] {
    const all = this.changeHistory.toArray();
    if (last !== undefined && last > 0) {
      return all.slice(-last);
    }
    return all;
  }

  // ── PHASE 4: Signal Stability Filter ──

  evaluateSignalStability(
    recentScores: number[],
    recentEVs: number[],
    recentDecisions: string[],
  ): SignalStabilityResult {
    // Store into internal buffers
    for (const s of recentScores) this.scoreHistory.push(safe(s));
    for (const e of recentEVs) this.evHistory.push(safe(e));
    for (const d of recentDecisions) this.decisionHistory.push(d);

    // Use last SIGNAL_WINDOW entries
    const scores = this.scoreHistory.last(SIGNAL_WINDOW).map(v => safe(v));
    const evs = this.evHistory.last(SIGNAL_WINDOW).map(v => safe(v));
    const decisions = this.decisionHistory.last(SIGNAL_WINDOW);

    // Score variance
    const scoreVar = variance(scores);
    const scoreMean = mean(scores);

    // EV variance
    const evVar = variance(evs);

    // Decision flip frequency
    let flips = 0;
    for (let i = 1; i < decisions.length; i++) {
      if (decisions[i] !== decisions[i - 1]) {
        flips++;
      }
    }
    const flipFreq = decisions.length > 1 ? safe(flips / decisions.length, 0) : 0;

    // Instability checks
    const scoreThreshold = (safe(scoreMean) * 0.5) ** 2;
    const unstable = scoreVar > scoreThreshold || flipFreq > 0.4;

    let extraScoreBuffer = 0;
    let sizeMultiplier = 1.0;

    if (unstable) {
      extraScoreBuffer = 10;
      sizeMultiplier = 0.8;
    }

    this._signalStable = !unstable;
    this._scoreBuffer = extraScoreBuffer;
    this._stabilitySizeMultiplier = sizeMultiplier;

    return {
      stable: !unstable,
      scoreVariance: scoreVar,
      evVariance: evVar,
      flipFrequency: flipFreq,
      extraScoreBuffer,
      sizeMultiplier,
    };
  }

  // ── PHASE 5: Capital Utilization Monitor ──

  evaluateUtilization(
    deployedCapital: number,
    totalCapital: number,
    tradesSkipped: number,
    tradesExecuted: number,
    hasPositiveEV: boolean,
    ev?: number,
    sharpe?: number,
    drawdownPct?: number,
  ): CapitalUtilization {
    const deployed = safe(deployedCapital, 0);
    const total = safe(totalCapital, 1);
    const skipped = safe(tradesSkipped, 0);
    const executed = safe(tradesExecuted, 0);

    const deployedPct = total > 0 ? safe(deployed / total, 0) : 0;
    const totalTrades = Math.max(1, skipped + executed);
    const skipRate = safe(skipped / totalTrades, 0);

    const avgPositionSizePct = executed > 0 && total > 0
      ? safe((deployed / executed) / total, 0)
      : 0;

    const underUtilized = deployedPct < 0.30 && hasPositiveEV;

    // V2 Phase 3: Safe utilization relaxation — only relax if edge is strong
    const safeEV = safe(ev ?? 0, 0);
    const safeSharpe = safe(sharpe ?? 0, 0);
    const safeDD = safe(drawdownPct ?? 1, 1);
    const safeToRelax = hasPositiveEV
      && safeEV > 0.5
      && safeSharpe > 0.5
      && safeDD < 0.10;

    if (underUtilized && safeToRelax) {
      this._filterRelaxation = clamp(this._filterRelaxation + 0.01, 0, 0.15);
      this._lastRelaxReason = `relaxing: EV=${safeEV.toFixed(2)} Sharpe=${safeSharpe.toFixed(2)} DD=${(safeDD * 100).toFixed(1)}%`;
    } else if (underUtilized && !safeToRelax) {
      this._lastRelaxReason = `low utilization but weak edge (EV=${safeEV.toFixed(2)} Sharpe=${safeSharpe.toFixed(2)} DD=${(safeDD * 100).toFixed(1)}%) — no relaxation`;
    } else {
      this._filterRelaxation = clamp(this._filterRelaxation - 0.01, 0, 0.15);
      this._lastRelaxReason = '';
    }

    this._utilizationPct = deployedPct;

    return {
      deployedPct,
      avgPositionSizePct,
      tradesSkipped: skipped,
      tradesExecuted: executed,
      skipRate,
      underUtilized,
      filterRelaxation: this._filterRelaxation,
    };
  }

  // ── PHASE 6: Meta-Stability Score ──

  computeMetaStability(
    sharpeHist: number[],
    drawdownHist: number[],
    changeCount: number,
    decisionConsistency: number,
    slippageP90?: number,
    slippageP50?: number,
    fillSuccessRate?: number,
  ): MetaStabilityScore {
    // Store into internal buffers
    for (const s of sharpeHist) this.sharpeHistory.push(safe(s));
    for (const d of drawdownHist) this.drawdownHistory.push(safe(d));

    const sharpes = this.sharpeHistory.toArray().map(v => safe(v));
    const drawdowns = this.drawdownHistory.toArray().map(v => safe(v));
    const changes = safe(changeCount, 0);
    const consistency = clamp(safe(decisionConsistency, 0), 0, 1);

    // Component 1: Sharpe consistency (0-25)
    const sharpeConsistency = sharpes.length >= 2
      ? (() => { const sd = stdDev(sharpes); return sd < 0.3 ? 25 : sd < 0.5 ? 18 : sd < 1.0 ? 10 : 0; })()
      : 25; // Insufficient data, assume stable

    // Component 2: Drawdown smoothness (0-25)
    const drawdownSmoothness = drawdowns.length >= 2
      ? (() => {
          let maxDdChange = 0;
          for (let i = 1; i < drawdowns.length; i++) {
            const change = Math.abs(drawdowns[i] - drawdowns[i - 1]);
            if (change > maxDdChange) maxDdChange = change;
          }
          const pctChange = maxDdChange * 100;
          return pctChange < 2 ? 25 : pctChange < 5 ? 18 : pctChange < 10 ? 10 : 0;
        })()
      : 25;

    // Component 3: Parameter stability (0-25)
    const parameterStability = changes === 0 ? 25 : changes === 1 ? 20 : changes === 2 ? 15 : changes === 3 ? 10 : 0;

    // Component 4: Decision consistency (0-20, reduced from 25 to make room for execution)
    const decisionScore = Math.round(consistency * 20);

    // V2 Phase 4: Execution stability component (0-20)
    let execStability = 20; // default: good
    const p90 = safe(slippageP90 ?? 0, 0);
    const p50 = safe(slippageP50 ?? 0, 0);
    const fillRate = safe(fillSuccessRate ?? 1, 1);
    const slippageSpread = p90 - p50; // variance proxy
    if (slippageSpread > 30 || fillRate < 0.7) {
      execStability = 0;
    } else if (slippageSpread > 20 || fillRate < 0.85) {
      execStability = 8;
    } else if (slippageSpread > 10 || fillRate < 0.95) {
      execStability = 14;
    }
    this._execStabilityScore = execStability;

    const total = sharpeConsistency + drawdownSmoothness + parameterStability + decisionScore + execStability;

    let action: 'none' | 'reduce_size' | 'disable_adaptations' = 'none';
    let globalSizeMultiplier = 1.0;

    if (total < 30) {
      action = 'disable_adaptations';
      globalSizeMultiplier = 0.5;
    } else if (total < 50) {
      action = 'reduce_size';
      globalSizeMultiplier = 0.7;
    }

    // V2: Additional execution instability penalty
    if (execStability < 8) {
      globalSizeMultiplier *= 0.8; // additional 20% reduction
    }

    this._metaStabilityScore = total;
    this._globalSizeOverride = globalSizeMultiplier;
    this._adaptationsEnabled = action !== 'disable_adaptations';

    return {
      score: total,
      components: {
        sharpeConsistency,
        drawdownSmoothness,
        parameterStability,
        decisionConsistency: decisionScore,
      },
      action,
      globalSizeMultiplier,
    };
  }

  // ── PHASE 7: Shadow Mode Validation ──

  recordLiveTrade(pnl: number): void {
    this.livePnls.push(safe(pnl, 0));
    this._shadowActive = true;
  }

  recordShadowTrade(pnl: number): void {
    this.shadowPnls.push(safe(pnl, 0));
    this._shadowActive = true;
  }

  compareShadowVsLive(): ShadowComparison {
    const live = this.livePnls.toArray();
    const shadow = this.shadowPnls.toArray();

    const livePnl = live.reduce((s, v) => s + safe(v), 0);
    const shadowPnl = shadow.reduce((s, v) => s + safe(v), 0);
    const liveSharpe = sharpeFromPnls(live);
    const shadowSharpe = sharpeFromPnls(shadow);
    const liveEV = live.length > 0 ? livePnl / live.length : 0;
    const shadowEV = shadow.length > 0 ? shadowPnl / shadow.length : 0;

    let shadowBetter = false;
    let reason: string;

    const minTrades = Math.min(live.length, shadow.length);

    if (minTrades >= SHADOW_MIN_TRADES) {
      if (shadowSharpe > liveSharpe + 0.2 && shadowEV > liveEV) {
        shadowBetter = true;
        this._shadowBetterCount++;
        reason = `shadow outperforms: Sharpe ${shadowSharpe.toFixed(2)} vs ${liveSharpe.toFixed(2)} (gap ${(shadowSharpe - liveSharpe).toFixed(2)}), EV ${shadowEV.toFixed(2)} vs ${liveEV.toFixed(2)}`;
      } else {
        this._shadowBetterCount = Math.max(0, this._shadowBetterCount - 1);
        reason = `live performing adequately: Sharpe ${liveSharpe.toFixed(2)}, EV ${liveEV.toFixed(2)}`;
      }
    } else {
      reason = `insufficient trades for comparison (${minTrades}/${SHADOW_MIN_TRADES})`;
    }

    const revertRecommended = this._shadowBetterCount >= SHADOW_REVERT_THRESHOLD;
    this._revertRecommended = revertRecommended;

    // V2 Phase 2: HARD ENFORCEMENT — auto-revert + freeze if shadow consistently better
    if (revertRecommended && !this._shadowAutoReverted) {
      this._shadowAutoReverted = true;
      this._shadowRevertFreezeUntil = Date.now() + 50 * 10_000; // freeze refinements ~50 ticks
      reason += ' | AUTO-REVERT EXECUTED + refinements frozen for 50 trades';
    }

    return {
      shadowPnl,
      livePnl,
      shadowSharpe,
      liveSharpe,
      shadowBetter,
      revertRecommended,
      reason,
    };
  }

  /** V2: Check if shadow revert freeze is active (blocks edge refiner) */
  isShadowRevertFrozen(): boolean {
    return this._shadowAutoReverted && Date.now() < this._shadowRevertFreezeUntil;
  }

  /** V2: Acknowledge shadow revert (called after actual revert happens) */
  acknowledgeShadowRevert(): void {
    this._shadowBetterCount = 0;
    this._revertRecommended = false;
  }

  shouldRevert(): boolean {
    return this._shadowBetterCount >= SHADOW_REVERT_THRESHOLD;
  }

  // ── V2 Phase 5: Dual-Lane Execution ──

  /**
   * Determine execution lane based on trade source.
   * FAST LANE: event-driven/prediction trades — bypass stability + utilization + refiner, keep killswitch + slippage.
   * SAFE LANE: full governance applied.
   */
  getExecutionLane(source: 'scan' | 'event' | 'prediction'): ExecutionLane {
    if (source === 'event' || source === 'prediction') {
      this._dualLane = 'fast';
      return 'fast';
    }
    this._dualLane = 'safe';
    return 'safe';
  }

  /** Returns which gates to bypass for the given lane */
  getLaneBypassGates(lane: ExecutionLane): Set<string> {
    if (lane === 'fast') {
      // Fast lane: bypass non-critical gates but keep safety
      return new Set(['signal_stability', 'utilization_filter', 'edge_refiner', 'meta_stability', 'quality_gate']);
    }
    return new Set(); // Safe lane: no bypasses
  }

  // ── V2 Phase 6: Governor Transparency ──

  /** Full transparency report for `agent governor` command */
  getTransparencyReport(): GovernorTransparency {
    const clampAnalytics = this.getClampAnalytics();
    const shadow = this.compareShadowVsLive();

    // Collect active restrictions
    const restrictions: string[] = [];
    if (this._frozen) restrictions.push(`Change freeze active (until trade ${this._frozenUntilTrade})`);
    if (!this._adaptationsEnabled) restrictions.push('Adaptations disabled (meta-stability < 30)');
    if (this._globalSizeOverride < 1.0) restrictions.push(`Global size reduced to ${(this._globalSizeOverride * 100).toFixed(0)}%`);
    if (!this._signalStable) restrictions.push('Signal instability detected (+10 score buffer, 80% size)');
    if (this._clampFrequency > 0.4) restrictions.push(`High clamp frequency (${(this._clampFrequency * 100).toFixed(0)}%) — dominant: ${this._dominantFactor}`);
    if (this._shadowAutoReverted) restrictions.push('Shadow auto-revert executed — refinements frozen');
    if (this._execStabilityScore < 8) restrictions.push('Execution instability — additional 20% size cut');

    return {
      clampAnalytics,
      utilizationState: {
        deployedPct: this._utilizationPct,
        avgPositionSizePct: 0,
        tradesSkipped: 0,
        tradesExecuted: 0,
        skipRate: 0,
        underUtilized: this._utilizationPct < 0.3,
        filterRelaxation: this._filterRelaxation,
        relaxationReason: this._lastRelaxReason,
      },
      shadowDelta: shadow,
      activeRestrictions: restrictions,
      executionLane: this._dualLane,
      metaStabilityComponents: {
        sharpeConsistency: 0, drawdownSmoothness: 0, parameterStability: 0, decisionConsistency: 0,
        executionStability: this._execStabilityScore,
      },
      frozen: this._frozen,
      freezeReason: this._frozen ? `Rate-limited: max ${MAX_CHANGES_PER_100_TRADES} changes per 100 trades exceeded` : '',
    };
  }

  // ── Utility: State / Report / Reset ──

  getState(): GovernorState {
    return {
      lastRawMultiplier: this._lastRawMultiplier, lastNormalizedMultiplier: this._lastNormalizedMultiplier,
      effectiveSizeRatio: this._effectiveSizeRatio, clampEvents: this._clampEvents,
      recentChanges: this.changeHistory.toArray(), frozen: this._frozen, frozenUntilTrade: this._frozenUntilTrade,
      signalStable: this._signalStable, scoreBuffer: this._scoreBuffer, stabilitySizeMultiplier: this._stabilitySizeMultiplier,
      utilizationPct: this._utilizationPct, filterRelaxation: this._filterRelaxation,
      metaStabilityScore: this._metaStabilityScore, globalSizeOverride: this._globalSizeOverride, adaptationsEnabled: this._adaptationsEnabled,
      shadowActive: this._shadowActive, shadowBetterCount: this._shadowBetterCount, revertRecommended: this._revertRecommended,
      clampFrequency: this._clampFrequency, dominantFactor: this._dominantFactor,
      shadowAutoReverted: this._shadowAutoReverted, executionStabilityScore: this._execStabilityScore,
      dualLane: this._dualLane,
    };
  }

  getReport(): string {
    const s = this.getState();
    const sec = (title: string, ...kvs: string[]) => `--- ${title} ---\n` + kvs.map(k => `  ${k}`).join('\n');
    return [
      '=== System Governor Report ===',
      sec('Phase 1: Multiplier Normalization',
        `Raw: ${s.lastRawMultiplier.toFixed(4)}  Normalized: ${s.lastNormalizedMultiplier.toFixed(4)}  Ratio: ${s.effectiveSizeRatio.toFixed(4)}  Clamps: ${s.clampEvents}`),
      sec('Phase 2: Priority Hierarchy',
        `5 levels (SAFETY>EXECUTION>EDGE>LEARNING>OPTIMIZATION), ${Object.keys(PRIORITY_LEVELS).length} systems`),
      sec('Phase 3: Change Rate Limiting',
        `Changes: ${s.recentChanges.length}  Frozen: ${s.frozen}  FrozenUntil: ${s.frozenUntilTrade}`),
      sec('Phase 4: Signal Stability',
        `Stable: ${s.signalStable}  ScoreBuffer: ${s.scoreBuffer}  SizeMult: ${s.stabilitySizeMultiplier.toFixed(2)}`),
      sec('Phase 5: Capital Utilization',
        `Utilization: ${(s.utilizationPct * 100).toFixed(1)}%  FilterRelax: ${(s.filterRelaxation * 100).toFixed(1)}%`),
      sec('Phase 6: Meta-Stability',
        `Score: ${s.metaStabilityScore}/100  SizeOverride: ${s.globalSizeOverride.toFixed(2)}  Adaptations: ${s.adaptationsEnabled}`),
      sec('Phase 7: Shadow Validation',
        `Active: ${s.shadowActive}  BetterCount: ${s.shadowBetterCount}  RevertRec: ${s.revertRecommended}`),
      '=== End Report ===',
    ].join('\n\n');
  }

  reset(): void {
    this._lastRawMultiplier = 1; this._lastNormalizedMultiplier = 1;
    this._effectiveSizeRatio = 1; this._clampEvents = 0;
    this.changeHistory.clear(); this._frozen = false;
    this._frozenUntilTrade = 0; this._freezeBaseTradeCount = 0;
    this._signalStable = true; this._scoreBuffer = 0; this._stabilitySizeMultiplier = 1;
    this.scoreHistory.clear(); this.evHistory.clear(); this.decisionHistory.clear();
    this._utilizationPct = 0; this._filterRelaxation = 0;
    this._metaStabilityScore = 100; this._globalSizeOverride = 1; this._adaptationsEnabled = true;
    this.sharpeHistory.clear(); this.drawdownHistory.clear();
    this.shadowPnls.clear(); this.livePnls.clear();
    this._shadowBetterCount = 0; this._revertRecommended = false; this._shadowActive = false;
    this.clampLog.clear(); this._dominantFactor = 'none'; this._clampFrequency = 0;
    this._shadowAutoReverted = false; this._shadowRevertFreezeUntil = 0;
    this._execStabilityScore = 25; this._dualLane = 'safe'; this._lastRelaxReason = '';
  }
}

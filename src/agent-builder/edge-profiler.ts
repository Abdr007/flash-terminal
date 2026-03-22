// ─── Edge Profiler ───────────────────────────────────────────────────
// Measures REAL edge after all costs, decomposes PnL leaks, optimizes
// capital allocation, enforces trade quality, controls stability, and
// gates scaling readiness.
// Zero external dependencies. Bounded storage throughout.
// ─────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────

export interface RealEdgeMetrics {
  realEV: number;
  evPerDollarRisk: number;
  grossPnl: number;
  totalCosts: number;
  netPnl: number;
  costDragPct: number;
  hasEdge: boolean;
  edgeConfidence: number;
}

export interface PnlLeakBreakdown {
  signalError: { count: number; totalLoss: number; pctOfLosses: number };
  executionLoss: { count: number; totalLoss: number; pctOfLosses: number };
  exitInefficiency: { count: number; totalLoss: number; pctOfLosses: number };
  overtrading: { count: number; totalLoss: number; pctOfLosses: number };
  largestLeakSource: string;
  recommendation: string;
}

export interface StrategyAllocation {
  strategy: string;
  ev: number;
  winRate: number;
  rMultiple: number;
  drawdownContribution: number;
  currentWeight: number;
  suggestedWeight: number;
  action: 'increase' | 'maintain' | 'decrease' | 'disable';
}

export interface RegimeAllocation {
  regime: string;
  ev: number;
  tradeCount: number;
  winRate: number;
  suggestedSizeMultiplier: number;
}

export interface MarketAllocation {
  market: string;
  ev: number;
  tradeCount: number;
  avgSlippageBps: number;
  suggestedSizeMultiplier: number;
}

export interface QualityGate {
  minScorePercentile: number;
  currentThreshold: number;
  evFloor: number;
  maxCostPct: number;
  filtering: boolean;
  tradesPassed: number;
  tradesRejected: number;
  rejectedPnlSaved: number;
}

export interface StabilityReport {
  sharpe7d: number;
  sharpe30d: number;
  returnVariance: number;
  drawdownCurve: number[];
  isStable: boolean;
  instabilityAction: 'none' | 'reduce_size' | 'tighten_filters' | 'halt';
  sizeMultiplier: number;
}

export interface ScaleReadiness {
  ready: boolean;
  score: number;
  checks: {
    sharpe: { value: number; pass: boolean; required: number };
    drawdown: { value: number; pass: boolean; required: number };
    profitFactor: { value: number; pass: boolean; required: number };
    evPositive: { value: boolean; pass: boolean };
    sufficientTrades: { value: number; pass: boolean; required: number };
    regimeStable: { value: boolean; pass: boolean };
  };
  blockers: string[];
}

export interface TradeRecord {
  market: string;
  strategy: string;
  regime: string;
  side: string;
  score: number;
  confidence: number;
  collateral: number;
  leverage: number;
  expectedPnl: number;
  actualPnl: number;
  slippageCost: number;
  feeCost: number;
  executionCost: number;
  netPnl: number;
  exitEfficiency: number;
  holdingTimeMs: number;
  timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_TRADES = 500;
const MAX_STRATEGIES = 20;
const MAX_REGIMES = 10;
const MAX_MARKETS = 50;
const MIN_TRADES_FOR_EDGE = 20;
const MIN_TRADES_FOR_QUALITY_GATE = 50;
const QUALITY_PERCENTILE = 0.80;
const DEFAULT_MAX_COST_PCT = 30;

// ─── Helpers ─────────────────────────────────────────────────────────

function safe(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function safeDiv(a: number, b: number, fallback = 0): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, safe(v, lo)));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return safe(sorted[idx]);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += safe(v);
  return safeDiv(s, arr.length);
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) {
    const d = safe(v) - m;
    s += d * d;
  }
  return safeDiv(s, arr.length - 1);
}

function sharpeRatio(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const sd = Math.sqrt(variance(returns));
  return safeDiv(m, sd);
}

// ─── EdgeProfiler ────────────────────────────────────────────────────

export class EdgeProfiler {
  private trades: TradeRecord[] = [];
  private head = 0;
  private count = 0;

  // Quality gate tracking
  private qualityPassed = 0;
  private qualityRejected = 0;
  private rejectedPnlSaved = 0;

  constructor() {
    this.trades = new Array<TradeRecord>(MAX_TRADES);
    this.head = 0;
    this.count = 0;
    this.qualityPassed = 0;
    this.qualityRejected = 0;
    this.rejectedPnlSaved = 0;
  }

  // ─── Storage ─────────────────────────────────────────────────────

  /** Record a completed trade with all cost data. */
  recordTrade(record: TradeRecord): void {
    // Sanitize all numeric fields
    const sanitized: TradeRecord = {
      market: String(record.market || 'UNKNOWN').slice(0, 20),
      strategy: String(record.strategy || 'UNKNOWN').slice(0, 40),
      regime: String(record.regime || 'UNKNOWN').slice(0, 20),
      side: String(record.side || 'UNKNOWN').slice(0, 10),
      score: safe(record.score),
      confidence: clamp(record.confidence, 0, 1),
      collateral: safe(record.collateral),
      leverage: safe(record.leverage, 1),
      expectedPnl: safe(record.expectedPnl),
      actualPnl: safe(record.actualPnl),
      slippageCost: safe(record.slippageCost),
      feeCost: safe(record.feeCost),
      executionCost: safe(record.executionCost),
      netPnl: safe(record.netPnl),
      exitEfficiency: clamp(record.exitEfficiency, 0, 1),
      holdingTimeMs: safe(record.holdingTimeMs),
      timestamp: safe(record.timestamp, Date.now()),
    };

    // Circular buffer insertion
    this.trades[this.head] = sanitized;
    this.head = (this.head + 1) % MAX_TRADES;
    if (this.count < MAX_TRADES) this.count++;
  }

  /** Return all recorded trades in chronological order. */
  private getAll(): TradeRecord[] {
    if (this.count === 0) return [];
    if (this.count < MAX_TRADES) {
      return this.trades.slice(0, this.count);
    }
    // Circular: head points to oldest
    return [
      ...this.trades.slice(this.head, MAX_TRADES),
      ...this.trades.slice(0, this.head),
    ];
  }

  // ─── PHASE 1: Real Edge Measurement ──────────────────────────────

  /** Compute REAL EV = (actualPnL - costs) / tradeCount, per dollar risk. */
  getRealEdge(): RealEdgeMetrics {
    const all = this.getAll();
    const n = all.length;

    if (n === 0) {
      return {
        realEV: 0, evPerDollarRisk: 0, grossPnl: 0,
        totalCosts: 0, netPnl: 0, costDragPct: 0,
        hasEdge: false, edgeConfidence: 0,
      };
    }

    let grossPnl = 0;
    let totalCosts = 0;
    let totalCollateral = 0;

    for (const t of all) {
      grossPnl += safe(t.actualPnl);
      totalCosts += safe(t.executionCost);
      totalCollateral += safe(t.collateral);
    }

    const netPnl = grossPnl - totalCosts;
    const realEV = safeDiv(netPnl, n);
    const avgCollateral = safeDiv(totalCollateral, n);
    const evPerDollarRisk = safeDiv(realEV, avgCollateral);
    const costDragPct = grossPnl > 0 ? safeDiv(totalCosts, grossPnl) * 100 : 0;

    // Confidence scales with sample size
    let edgeConfidence: number;
    if (n < MIN_TRADES_FOR_EDGE) edgeConfidence = safe(n / MIN_TRADES_FOR_EDGE) * 0.3;
    else if (n < 50) edgeConfidence = 0.3 + ((n - 20) / 30) * 0.3;
    else if (n < 100) edgeConfidence = 0.6 + ((n - 50) / 50) * 0.2;
    else if (n < 200) edgeConfidence = 0.8 + ((n - 100) / 100) * 0.15;
    else edgeConfidence = 0.95;
    edgeConfidence = clamp(edgeConfidence, 0, 1);

    const hasEdge = n >= MIN_TRADES_FOR_EDGE && realEV > 0;

    return {
      realEV: safe(realEV),
      evPerDollarRisk: safe(evPerDollarRisk),
      grossPnl: safe(grossPnl),
      totalCosts: safe(totalCosts),
      netPnl: safe(netPnl),
      costDragPct: safe(costDragPct),
      hasEdge,
      edgeConfidence: safe(edgeConfidence),
    };
  }

  // ─── PHASE 2: PnL Leak Detection ────────────────────────────────

  /** Decompose where PnL is being lost: signal, execution, exits, overtrading. */
  analyzePnlLeaks(): PnlLeakBreakdown {
    const all = this.getAll();

    const result: PnlLeakBreakdown = {
      signalError: { count: 0, totalLoss: 0, pctOfLosses: 0 },
      executionLoss: { count: 0, totalLoss: 0, pctOfLosses: 0 },
      exitInefficiency: { count: 0, totalLoss: 0, pctOfLosses: 0 },
      overtrading: { count: 0, totalLoss: 0, pctOfLosses: 0 },
      largestLeakSource: 'none',
      recommendation: 'Insufficient data',
    };

    if (all.length < 10) return result;

    // Compute median score for overtrading detection
    const scores = all.map(t => safe(t.score)).sort((a, b) => a - b);
    const medianScore = percentile(scores, 0.5);

    let totalLosses = 0;

    for (const t of all) {
      const pnl = safe(t.actualPnl);
      const slip = safe(t.slippageCost);
      const exitEff = safe(t.exitEfficiency);
      const score = safe(t.score);

      // Signal error: direction wrong, but exit was disciplined
      if (pnl < 0 && exitEff > 0.5) {
        result.signalError.count++;
        result.signalError.totalLoss += Math.abs(pnl);
        totalLosses += Math.abs(pnl);
      }

      // Execution loss: slippage ate > 20% of |actualPnl|
      const absPnl = Math.abs(pnl);
      if (absPnl > 0 && safeDiv(slip, absPnl) > 0.2) {
        result.executionLoss.count++;
        result.executionLoss.totalLoss += slip;
        totalLosses += slip;
      }

      // Exit inefficiency: won but captured < 40% of MFE
      if (pnl > 0 && exitEff < 0.4) {
        // Loss = potential not captured
        const leftOnTable = pnl * safeDiv(1 - exitEff, exitEff, 0);
        result.exitInefficiency.count++;
        result.exitInefficiency.totalLoss += safe(leftOnTable);
        totalLosses += safe(leftOnTable);
      }

      // Overtrading: low-score trade that lost
      if (score < medianScore && pnl < 0) {
        result.overtrading.count++;
        result.overtrading.totalLoss += Math.abs(pnl);
        totalLosses += Math.abs(pnl);
      }
    }

    // Compute percentages
    if (totalLosses > 0) {
      result.signalError.pctOfLosses = safe(safeDiv(result.signalError.totalLoss, totalLosses) * 100);
      result.executionLoss.pctOfLosses = safe(safeDiv(result.executionLoss.totalLoss, totalLosses) * 100);
      result.exitInefficiency.pctOfLosses = safe(safeDiv(result.exitInefficiency.totalLoss, totalLosses) * 100);
      result.overtrading.pctOfLosses = safe(safeDiv(result.overtrading.totalLoss, totalLosses) * 100);
    }

    // Determine largest leak
    const leaks = [
      { name: 'signalError', pct: result.signalError.pctOfLosses },
      { name: 'executionLoss', pct: result.executionLoss.pctOfLosses },
      { name: 'exitInefficiency', pct: result.exitInefficiency.pctOfLosses },
      { name: 'overtrading', pct: result.overtrading.pctOfLosses },
    ].sort((a, b) => b.pct - a.pct);

    result.largestLeakSource = leaks[0].pct > 0 ? leaks[0].name : 'none';

    // Actionable recommendation
    const recommendations: Record<string, string> = {
      signalError: 'Improve signal accuracy: tighten entry conditions, add confirmation filters, or reduce position size on lower-confidence signals.',
      executionLoss: 'Reduce slippage: use limit orders, avoid low-liquidity markets, or reduce position size relative to market depth.',
      exitInefficiency: 'Improve exit timing: implement trailing stops, scale out of positions, or extend holding periods to capture more of the move.',
      overtrading: 'Filter low-quality trades: raise minimum score threshold, reduce trade frequency, and only take high-conviction setups.',
      none: 'No significant PnL leaks detected.',
    };
    result.recommendation = recommendations[result.largestLeakSource] || recommendations.none;

    return result;
  }

  // ─── PHASE 3: Strategy Contribution Audit ────────────────────────

  /** Per-strategy EV, WR, R-multiple, drawdown contribution, suggested allocation. */
  getStrategyAllocations(): StrategyAllocation[] {
    const all = this.getAll();
    if (all.length === 0) return [];

    // Group by strategy (bounded)
    const stratMap = new Map<string, TradeRecord[]>();
    for (const t of all) {
      const key = t.strategy;
      if (!stratMap.has(key) && stratMap.size >= MAX_STRATEGIES) continue;
      const arr = stratMap.get(key) || [];
      arr.push(t);
      stratMap.set(key, arr);
    }

    // Compute total drawdown for contribution calc
    let totalDrawdown = 0;
    const stratDrawdowns = new Map<string, number>();
    for (const [strat, trades] of stratMap) {
      let dd = 0;
      for (const t of trades) {
        if (safe(t.netPnl) < 0) dd += Math.abs(safe(t.netPnl));
      }
      stratDrawdowns.set(strat, dd);
      totalDrawdown += dd;
    }

    // Compute EVs for weight allocation
    const evs = new Map<string, number>();
    let positiveEvSum = 0;

    const allocations: StrategyAllocation[] = [];

    for (const [strat, trades] of stratMap) {
      const n = trades.length;
      const wins = trades.filter(t => safe(t.netPnl) > 0);
      const losses = trades.filter(t => safe(t.netPnl) <= 0);
      const winRate = safeDiv(wins.length, n);
      const avgWin = wins.length > 0 ? mean(wins.map(t => safe(t.netPnl))) : 0;
      const avgLoss = losses.length > 0 ? Math.abs(mean(losses.map(t => safe(t.netPnl)))) : 1;
      const rMultiple = safeDiv(avgWin, avgLoss, 0);
      const ev = mean(trades.map(t => safe(t.netPnl)));
      const drawdownContribution = safeDiv(stratDrawdowns.get(strat) || 0, totalDrawdown);

      evs.set(strat, ev);
      if (ev > 0) positiveEvSum += ev;

      // Determine action
      let action: StrategyAllocation['action'];
      if (ev < 0 && n >= 30) action = 'disable';
      else if (winRate < 0.4 && n >= 20) action = 'decrease';
      else if (ev > 0) action = 'increase'; // refined below
      else action = 'maintain';

      allocations.push({
        strategy: strat,
        ev: safe(ev),
        winRate: safe(winRate),
        rMultiple: safe(rMultiple),
        drawdownContribution: safe(drawdownContribution),
        currentWeight: safeDiv(n, all.length),
        suggestedWeight: 0, // filled below
        action,
      });
    }

    // Compute suggested weights proportional to max(0, EV)
    for (const alloc of allocations) {
      if (alloc.ev > 0 && positiveEvSum > 0) {
        alloc.suggestedWeight = safe(safeDiv(alloc.ev, positiveEvSum));
      } else {
        alloc.suggestedWeight = 0;
      }
    }

    // Refine action: 'increase' only if in top quartile of EVs
    const sortedEvs = allocations.map(a => a.ev).sort((a, b) => b - a);
    const topQuartileThreshold = sortedEvs.length >= 4
      ? sortedEvs[Math.floor(sortedEvs.length * 0.25)]
      : sortedEvs[0];

    for (const alloc of allocations) {
      if (alloc.action === 'increase' && alloc.ev < topQuartileThreshold) {
        alloc.action = 'maintain';
      }
    }

    return allocations;
  }

  // ─── PHASE 4: Capital Allocation ─────────────────────────────────

  /** Per-regime sizing: higher EV regime gets higher multiplier (0.5-1.5). */
  getRegimeAllocations(): RegimeAllocation[] {
    const all = this.getAll();
    if (all.length === 0) return [];

    const regimeMap = new Map<string, TradeRecord[]>();
    for (const t of all) {
      const key = t.regime;
      if (!regimeMap.has(key) && regimeMap.size >= MAX_REGIMES) continue;
      const arr = regimeMap.get(key) || [];
      arr.push(t);
      regimeMap.set(key, arr);
    }

    const allocations: RegimeAllocation[] = [];
    let maxEv = -Infinity;
    let minEv = Infinity;

    // First pass: compute EVs
    const evByRegime = new Map<string, number>();
    for (const [regime, trades] of regimeMap) {
      const ev = mean(trades.map(t => safe(t.netPnl)));
      evByRegime.set(regime, ev);
      if (ev > maxEv) maxEv = ev;
      if (ev < minEv) minEv = ev;
    }

    // Second pass: assign multipliers
    const evRange = maxEv - minEv;
    for (const [regime, trades] of regimeMap) {
      const ev = evByRegime.get(regime) || 0;
      const winRate = safeDiv(
        trades.filter(t => safe(t.netPnl) > 0).length,
        trades.length,
      );

      // Normalize EV to 0-1 range, then scale to 0.5-1.5
      let normalizedEv: number;
      if (evRange > 0) {
        normalizedEv = safeDiv(ev - minEv, evRange);
      } else {
        normalizedEv = 0.5;
      }
      // Negative EV regimes get below 1.0, positive get above
      let multiplier: number;
      if (ev <= 0) {
        multiplier = clamp(0.5 + normalizedEv * 0.5, 0.0, 1.0);
      } else {
        multiplier = clamp(0.5 + normalizedEv * 1.0, 1.0, 1.5);
      }

      allocations.push({
        regime,
        ev: safe(ev),
        tradeCount: trades.length,
        winRate: safe(winRate),
        suggestedSizeMultiplier: safe(multiplier),
      });
    }

    return allocations;
  }

  /** Per-market sizing: factor in slippage cost, reduce for expensive markets. */
  getMarketAllocations(): MarketAllocation[] {
    const all = this.getAll();
    if (all.length === 0) return [];

    const marketMap = new Map<string, TradeRecord[]>();
    for (const t of all) {
      const key = t.market;
      if (!marketMap.has(key) && marketMap.size >= MAX_MARKETS) continue;
      const arr = marketMap.get(key) || [];
      arr.push(t);
      marketMap.set(key, arr);
    }

    const allocations: MarketAllocation[] = [];

    for (const [market, trades] of marketMap) {
      const ev = mean(trades.map(t => safe(t.netPnl)));
      const avgSlippage = mean(trades.map(t => safe(t.slippageCost)));
      const avgCollateral = mean(trades.map(t => safe(t.collateral)));
      const avgSlippageBps = avgCollateral > 0
        ? safe(safeDiv(avgSlippage, avgCollateral) * 10000)
        : 0;

      // Reduce size for high-slippage markets
      // Base multiplier from EV, penalized by slippage
      let multiplier: number;
      if (ev <= 0) {
        multiplier = 0.5;
      } else {
        multiplier = 1.0;
        // Penalize: every 10 bps of slippage reduces by 0.1
        const slippagePenalty = clamp(avgSlippageBps / 100, 0, 0.5);
        multiplier = clamp(multiplier - slippagePenalty, 0.5, 1.5);
      }

      allocations.push({
        market,
        ev: safe(ev),
        tradeCount: trades.length,
        avgSlippageBps: safe(avgSlippageBps),
        suggestedSizeMultiplier: safe(multiplier),
      });
    }

    return allocations;
  }

  // ─── PHASE 5: Trade Quality Filter ───────────────────────────────

  /** Compute quality gate parameters from recorded trade distribution. */
  getQualityGate(): QualityGate {
    const all = this.getAll();
    const n = all.length;
    const filtering = n >= MIN_TRADES_FOR_QUALITY_GATE;
    const edge = this.getRealEdge();

    let currentThreshold = 0;
    let evFloor = 0;

    if (filtering) {
      const scores = all.map(t => safe(t.score)).sort((a, b) => a - b);
      currentThreshold = percentile(scores, QUALITY_PERCENTILE);
      evFloor = safe(edge.realEV * 0.5);
    }

    return {
      minScorePercentile: QUALITY_PERCENTILE * 100,
      currentThreshold: safe(currentThreshold),
      evFloor: safe(evFloor),
      maxCostPct: DEFAULT_MAX_COST_PCT,
      filtering,
      tradesPassed: this.qualityPassed,
      tradesRejected: this.qualityRejected,
      rejectedPnlSaved: safe(this.rejectedPnlSaved),
    };
  }

  /** Decide whether a prospective trade should be taken. */
  shouldTrade(
    score: number,
    predictedEV: number,
    executionCostPct: number,
  ): { allowed: boolean; reason: string } {
    const gate = this.getQualityGate();

    // Auto-activate only after enough trades
    if (!gate.filtering) {
      this.qualityPassed++;
      return { allowed: true, reason: 'Quality gate inactive (insufficient history)' };
    }

    const safeScore = safe(score);
    const safeEV = safe(predictedEV);
    const safeCost = safe(executionCostPct);

    // Check 1: score threshold
    if (safeScore < gate.currentThreshold) {
      this.qualityRejected++;
      this.rejectedPnlSaved += Math.max(0, -safeEV); // conservative estimate
      return {
        allowed: false,
        reason: `Score ${safeScore.toFixed(2)} below threshold ${gate.currentThreshold.toFixed(2)} (top ${gate.minScorePercentile}%)`,
      };
    }

    // Check 2: EV floor
    if (safeEV < gate.evFloor) {
      this.qualityRejected++;
      this.rejectedPnlSaved += Math.max(0, -safeEV);
      return {
        allowed: false,
        reason: `Predicted EV $${safeEV.toFixed(2)} below floor $${gate.evFloor.toFixed(2)}`,
      };
    }

    // Check 3: execution cost cap
    if (safeCost > gate.maxCostPct) {
      this.qualityRejected++;
      return {
        allowed: false,
        reason: `Execution cost ${safeCost.toFixed(1)}% exceeds max ${gate.maxCostPct}%`,
      };
    }

    this.qualityPassed++;
    return { allowed: true, reason: 'Trade passes quality gate' };
  }

  // ─── PHASE 6: Stability Control ──────────────────────────────────

  /** Rolling Sharpe, variance, and stability-based size adjustments. */
  getStabilityReport(): StabilityReport {
    const all = this.getAll();
    const returns = all.map(t => safe(t.netPnl));

    // Rolling windows
    const returns7d = returns.slice(-50);
    const returns30d = returns.slice(-200);

    const sharpe7d = sharpeRatio(returns7d);
    const sharpe30d = sharpeRatio(returns30d);
    const returnVariance = variance(returns);

    // Historical variance baseline (use full window)
    const historicalVariance = returns.length >= 100
      ? variance(returns.slice(0, -50))
      : returnVariance;

    // Drawdown curve (last 50 trades)
    const drawdownCurve: number[] = [];
    if (returns.length > 0) {
      let peak = 0;
      let equity = 0;
      const recentReturns = returns.slice(-50);
      for (const r of recentReturns) {
        equity += r;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? safeDiv(peak - equity, peak) : 0;
        drawdownCurve.push(safe(dd));
      }
    }

    // Stability determination
    let instabilityAction: StabilityReport['instabilityAction'] = 'none';
    let sizeMultiplier = 1.0;

    if (returns7d.length >= 10) {
      if (sharpe7d < -1.0) {
        instabilityAction = 'halt';
        sizeMultiplier = 0.0;
      } else if (sharpe7d < 0 || (historicalVariance > 0 && returnVariance > 2 * historicalVariance)) {
        instabilityAction = 'tighten_filters';
        sizeMultiplier = 0.5;
      } else if (sharpe7d < 0.3) {
        instabilityAction = 'reduce_size';
        sizeMultiplier = 0.7;
      }
    }

    const isStable = sharpe7d > 0 && (
      historicalVariance <= 0 || returnVariance <= 2 * historicalVariance
    );

    return {
      sharpe7d: safe(sharpe7d),
      sharpe30d: safe(sharpe30d),
      returnVariance: safe(returnVariance),
      drawdownCurve,
      isStable,
      instabilityAction,
      sizeMultiplier: safe(sizeMultiplier),
    };
  }

  // ─── PHASE 7: Scale Readiness ────────────────────────────────────

  /** Check all 6 criteria for scaling up capital allocation. */
  getScaleReadiness(): ScaleReadiness {
    const all = this.getAll();
    const n = all.length;

    const stability = this.getStabilityReport();
    const edge = this.getRealEdge();
    const regimes = this.getRegimeAllocations();

    // 1. Sharpe > 0.7 (200-trade window)
    const sharpeCheck = {
      value: safe(stability.sharpe30d),
      pass: stability.sharpe30d > 0.7,
      required: 0.7,
    };

    // 2. Max drawdown < 10%
    const maxDD = stability.drawdownCurve.length > 0
      ? Math.max(...stability.drawdownCurve.map(v => safe(v)))
      : 0;
    const drawdownCheck = {
      value: safe(maxDD * 100),
      pass: maxDD < 0.1,
      required: 10,
    };

    // 3. Profit factor > 1.5
    let grossWins = 0;
    let grossLosses = 0;
    for (const t of all) {
      const pnl = safe(t.netPnl);
      if (pnl > 0) grossWins += pnl;
      else grossLosses += Math.abs(pnl);
    }
    const profitFactor = safeDiv(grossWins, grossLosses, 0);
    const pfCheck = {
      value: safe(profitFactor),
      pass: profitFactor > 1.5,
      required: 1.5,
    };

    // 4. Real EV > 0
    const evCheck = {
      value: edge.hasEdge,
      pass: edge.hasEdge && edge.realEV > 0,
    };

    // 5. >= 100 trades
    const tradesCheck = {
      value: n,
      pass: n >= 100,
      required: 100,
    };

    // 6. Positive EV in >= 2 regimes
    const positiveEvRegimes = regimes.filter(r => r.ev > 0 && r.tradeCount >= 5).length;
    const regimeCheck = {
      value: positiveEvRegimes >= 2,
      pass: positiveEvRegimes >= 2,
    };

    // Score: each check contributes proportionally
    const checks = [
      sharpeCheck.pass, drawdownCheck.pass, pfCheck.pass,
      evCheck.pass, tradesCheck.pass, regimeCheck.pass,
    ];
    const passCount = checks.filter(Boolean).length;
    const score = Math.round(safeDiv(passCount, 6) * 100);

    // Blockers
    const blockers: string[] = [];
    if (!sharpeCheck.pass) blockers.push(`Sharpe ratio ${sharpeCheck.value.toFixed(2)} below ${sharpeCheck.required}`);
    if (!drawdownCheck.pass) blockers.push(`Max drawdown ${drawdownCheck.value.toFixed(1)}% exceeds ${drawdownCheck.required}%`);
    if (!pfCheck.pass) blockers.push(`Profit factor ${pfCheck.value.toFixed(2)} below ${pfCheck.required}`);
    if (!evCheck.pass) blockers.push('Real EV is not positive after costs');
    if (!tradesCheck.pass) blockers.push(`Only ${tradesCheck.value} trades completed (need ${tradesCheck.required})`);
    if (!regimeCheck.pass) blockers.push(`Positive EV in only ${positiveEvRegimes} regime(s) (need 2+)`);

    return {
      ready: passCount === 6,
      score: safe(score),
      checks: {
        sharpe: sharpeCheck,
        drawdown: drawdownCheck,
        profitFactor: pfCheck,
        evPositive: evCheck,
        sufficientTrades: tradesCheck,
        regimeStable: regimeCheck,
      },
      blockers,
    };
  }

  // ─── Utility ─────────────────────────────────────────────────────

  /** Full combined report across all phases. */
  getFullReport(): {
    edge: RealEdgeMetrics;
    leaks: PnlLeakBreakdown;
    strategies: StrategyAllocation[];
    regimes: RegimeAllocation[];
    markets: MarketAllocation[];
    qualityGate: QualityGate;
    stability: StabilityReport;
    scaleReadiness: ScaleReadiness;
    stats: ReturnType<EdgeProfiler['getStats']>;
  } {
    return {
      edge: this.getRealEdge(),
      leaks: this.analyzePnlLeaks(),
      strategies: this.getStrategyAllocations(),
      regimes: this.getRegimeAllocations(),
      markets: this.getMarketAllocations(),
      qualityGate: this.getQualityGate(),
      stability: this.getStabilityReport(),
      scaleReadiness: this.getScaleReadiness(),
      stats: this.getStats(),
    };
  }

  /** Summary statistics. */
  getStats(): {
    totalTrades: number;
    uniqueStrategies: number;
    uniqueRegimes: number;
    uniqueMarkets: number;
    oldestTradeTs: number;
    newestTradeTs: number;
    avgHoldingTimeMs: number;
    winRate: number;
    avgLeverage: number;
    avgCollateral: number;
    avgScore: number;
    bufferUtilization: number;
  } {
    const all = this.getAll();
    const n = all.length;

    if (n === 0) {
      return {
        totalTrades: 0, uniqueStrategies: 0, uniqueRegimes: 0,
        uniqueMarkets: 0, oldestTradeTs: 0, newestTradeTs: 0,
        avgHoldingTimeMs: 0, winRate: 0, avgLeverage: 0,
        avgCollateral: 0, avgScore: 0, bufferUtilization: 0,
      };
    }

    const strategies = new Set<string>();
    const regimes = new Set<string>();
    const markets = new Set<string>();
    let wins = 0;
    let holdSum = 0;
    let levSum = 0;
    let collSum = 0;
    let scoreSum = 0;
    let oldest = Infinity;
    let newest = 0;

    for (const t of all) {
      strategies.add(t.strategy);
      regimes.add(t.regime);
      markets.add(t.market);
      if (safe(t.netPnl) > 0) wins++;
      holdSum += safe(t.holdingTimeMs);
      levSum += safe(t.leverage);
      collSum += safe(t.collateral);
      scoreSum += safe(t.score);
      const ts = safe(t.timestamp);
      if (ts < oldest) oldest = ts;
      if (ts > newest) newest = ts;
    }

    return {
      totalTrades: n,
      uniqueStrategies: Math.min(strategies.size, MAX_STRATEGIES),
      uniqueRegimes: Math.min(regimes.size, MAX_REGIMES),
      uniqueMarkets: Math.min(markets.size, MAX_MARKETS),
      oldestTradeTs: oldest === Infinity ? 0 : oldest,
      newestTradeTs: newest,
      avgHoldingTimeMs: safe(safeDiv(holdSum, n)),
      winRate: safe(safeDiv(wins, n)),
      avgLeverage: safe(safeDiv(levSum, n)),
      avgCollateral: safe(safeDiv(collSum, n)),
      avgScore: safe(safeDiv(scoreSum, n)),
      bufferUtilization: safe(safeDiv(n, MAX_TRADES)),
    };
  }

  /** Clear all data and reset state. */
  reset(): void {
    this.trades = new Array<TradeRecord>(MAX_TRADES);
    this.head = 0;
    this.count = 0;
    this.qualityPassed = 0;
    this.qualityRejected = 0;
    this.rejectedPnlSaved = 0;
  }
}

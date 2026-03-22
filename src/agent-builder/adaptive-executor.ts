// ─── Adaptive Execution Strategy Engine ───────────────────────────────
// Dynamically adjusts execution style, sizing, and timing based on
// real-time fill quality feedback. Zero external dependencies.
// ───────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────

export type ExecutionStyle = 'aggressive' | 'passive' | 'hybrid';

export interface ExecutionChunk {
  index: number;
  percent: number;
  collateral: number;
  status: 'pending' | 'executing' | 'filled' | 'failed' | 'cancelled';
  fillPrice?: number;
  slippageBps?: number;
}

export interface ExecutionPlan {
  style: ExecutionStyle;
  chunks: ExecutionChunk[];
  totalCollateral: number;
  adjustedCollateral: number;
  sizeMultiplier: number;
  delayBetweenChunksMs: number;
  reason: string;
  predictedSlippageBps: number;
  viable: boolean;
  createdAt: number;
  market: string;
  side: string;
}

export interface SlippagePrediction {
  expectedBps: number;
  confidence: number;
  components: {
    liquidityImpact: number;
    spreadComponent: number;
    volatilityComponent: number;
  };
  viable: boolean;
  edgeAfterSlippage: number;
}

export interface MarketExecutionStats {
  avgSlippageBps: number;
  p90SlippageBps: number;
  successRate: number;
  timeToFillP90Ms: number;
  tradeCount: number;
  degraded: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────

const MAX_PLAN_HISTORY = 100;

const DEFAULT_SLIPPAGE_THRESHOLD_BPS = 50;
const LIQUIDITY_IMPACT_CAP_BPS = 100;

const STYLE_THRESHOLDS = {
  passiveSlippageMin: 20,
  passiveSuccessRateMin: 0.9,
  aggressiveSlippageMax: 10,
  aggressiveTimeToFillP90Min: 3000,
  hybridSlippageMin: 10,
  hybridSlippageMax: 20,
} as const;

const CHUNK_CONFIGS: Record<ExecutionStyle, { percents: number[]; delayMs: number }> = {
  aggressive: { percents: [100], delayMs: 0 },
  passive: { percents: [30, 30, 40], delayMs: 1000 },
  hybrid: { percents: [50, 50], delayMs: 500 },
};

const SIZE_REDUCTION = {
  p90Above30: 0.7,
  p90Above50: 0.5,
  degraded: 0.6,
} as const;

const COMPONENT_WEIGHTS = {
  liquidity: 0.5,
  spread: 0.3,
  volatility: 0.2,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────

function safe(v: number, fallback: number = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  const s = safe(v, min);
  return Math.max(min, Math.min(max, s));
}

// ─── AdaptiveExecutor ─────────────────────────────────────────────────

export class AdaptiveExecutor {
  private planHistory: Array<{ style: ExecutionStyle; timestamp: number }> = [];
  private slippageThresholdBps: number;

  constructor(slippageThresholdBps?: number) {
    this.slippageThresholdBps = safe(
      slippageThresholdBps ?? DEFAULT_SLIPPAGE_THRESHOLD_BPS,
      DEFAULT_SLIPPAGE_THRESHOLD_BPS,
    );
  }

  // ── Plan ──────────────────────────────────────────────────────────

  plan(
    market: string,
    side: string,
    collateral: number,
    leverage: number,
    confidence: number,
    marketStats?: MarketExecutionStats,
  ): ExecutionPlan {
    const safeCollateral = safe(collateral, 0);
    const safeLeverage = safe(leverage, 1);
    const safeConfidence = clamp(confidence, 0, 1);

    // Style selection
    const style = this.selectStyle(marketStats);
    const reason = this.styleReason(style, marketStats);

    // Size multiplier
    let sizeMultiplier = 1.0;
    if (marketStats) {
      const p90 = safe(marketStats.p90SlippageBps, 0);
      if (p90 > 50) {
        sizeMultiplier = SIZE_REDUCTION.p90Above50;
      } else if (p90 > 30) {
        sizeMultiplier = SIZE_REDUCTION.p90Above30;
      }
      if (marketStats.degraded) {
        sizeMultiplier = Math.min(sizeMultiplier, SIZE_REDUCTION.degraded);
      }
    }

    const adjustedCollateral = safe(safeCollateral * sizeMultiplier, 0);
    const sizeUsd = safe(adjustedCollateral * safeLeverage, 0);

    // Slippage prediction (use safe defaults when no market data)
    const prediction = this.predictSlippage(
      market,
      sizeUsd,
      sizeUsd * 100, // default OI estimate if no real data
      0,
      0.001,
    );

    // Viability: predicted slippage must be less than half the expected edge
    // Edge approximated as confidence * 100 bps
    const edgeBps = safe(safeConfidence * 100, 0);
    const viable = prediction.expectedBps <= edgeBps / 2;

    // Chunk splitting
    const config = CHUNK_CONFIGS[style];
    const chunks: ExecutionChunk[] = config.percents.map((pct, i) => ({
      index: i,
      percent: pct,
      collateral: safe((adjustedCollateral * pct) / 100, 0),
      status: 'pending' as const,
    }));

    // Record in history
    this.recordPlan(style);

    return {
      style,
      chunks,
      totalCollateral: safeCollateral,
      adjustedCollateral,
      sizeMultiplier,
      delayBetweenChunksMs: config.delayMs,
      reason,
      predictedSlippageBps: safe(prediction.expectedBps, 0),
      viable,
      createdAt: Date.now(),
      market,
      side,
    };
  }

  // ── Style Selection ───────────────────────────────────────────────

  private selectStyle(stats?: MarketExecutionStats): ExecutionStyle {
    if (!stats || stats.tradeCount === 0) {
      return 'aggressive';
    }

    const avgSlip = safe(stats.avgSlippageBps, 0);
    const successRate = safe(stats.successRate, 0);
    const p90Time = safe(stats.timeToFillP90Ms, 0);

    // High slippage but good success rate -> go passive to reduce impact
    if (avgSlip > STYLE_THRESHOLDS.passiveSlippageMin && successRate > STYLE_THRESHOLDS.passiveSuccessRateMin) {
      return 'passive';
    }

    // Low slippage but slow fills -> go aggressive to speed up
    if (avgSlip < STYLE_THRESHOLDS.aggressiveSlippageMax && p90Time > STYLE_THRESHOLDS.aggressiveTimeToFillP90Min) {
      return 'aggressive';
    }

    // Middle ground
    if (avgSlip >= STYLE_THRESHOLDS.hybridSlippageMin && avgSlip <= STYLE_THRESHOLDS.hybridSlippageMax) {
      return 'hybrid';
    }

    return 'aggressive';
  }

  private styleReason(style: ExecutionStyle, stats?: MarketExecutionStats): string {
    if (!stats || stats.tradeCount === 0) {
      return 'No execution stats available, defaulting to aggressive';
    }
    switch (style) {
      case 'passive':
        return `High avg slippage (${safe(stats.avgSlippageBps, 0).toFixed(1)}bps) with good success rate (${(safe(stats.successRate, 0) * 100).toFixed(0)}%), splitting into chunks`;
      case 'aggressive':
        return `Low slippage (${safe(stats.avgSlippageBps, 0).toFixed(1)}bps) but slow fills (p90: ${safe(stats.timeToFillP90Ms, 0).toFixed(0)}ms), using single chunk`;
      case 'hybrid':
        return `Moderate slippage (${safe(stats.avgSlippageBps, 0).toFixed(1)}bps), using 2-chunk hybrid approach`;
      default:
        return 'Default execution style';
    }
  }

  // ── Slippage Prediction ───────────────────────────────────────────

  predictSlippage(
    _market: string,
    sizeUsd: number,
    totalOi: number,
    priceVelocity: number,
    spreadEstimate: number,
  ): SlippagePrediction {
    const safeSizeUsd = safe(sizeUsd, 0);
    const safeTotalOi = safe(totalOi, 1); // avoid division by zero
    const safeVelocity = safe(priceVelocity, 0);
    const safeSpread = safe(spreadEstimate, 0);

    // Component calculations
    const rawLiqImpact = safeTotalOi > 0 ? (safeSizeUsd / safeTotalOi) * 10000 : 0;
    const liquidityImpact = clamp(rawLiqImpact, 0, LIQUIDITY_IMPACT_CAP_BPS);
    const spreadComponent = safe(Math.abs(safeSpread) * 100, 0);
    const volatilityComponent = safe(Math.abs(safeVelocity) * 50, 0);

    // Weighted total
    const expectedBps = safe(
      COMPONENT_WEIGHTS.liquidity * liquidityImpact +
      COMPONENT_WEIGHTS.spread * spreadComponent +
      COMPONENT_WEIGHTS.volatility * volatilityComponent,
      0,
    );

    // Confidence: inverse of component variance
    const components = [liquidityImpact, spreadComponent, volatilityComponent];
    const mean = components.reduce((s, c) => s + c, 0) / 3;
    const variance = components.reduce((s, c) => s + (c - mean) ** 2, 0) / 3;
    const maxVariance = 10000; // normalization factor
    const confidence = clamp(1 - safe(variance / maxVariance, 0), 0, 1);

    // Viability
    const viable = expectedBps < this.slippageThresholdBps;
    const edgeAfterSlippage = safe(-expectedBps, 0); // caller adds their edge to this

    return {
      expectedBps,
      confidence,
      components: {
        liquidityImpact,
        spreadComponent,
        volatilityComponent,
      },
      viable,
      edgeAfterSlippage,
    };
  }

  // ── Chunk Result Update ───────────────────────────────────────────

  updateChunkResult(
    plan: ExecutionPlan,
    chunkIndex: number,
    fillPrice: number,
    expectedPrice: number,
    success: boolean,
  ): ExecutionPlan {
    if (chunkIndex < 0 || chunkIndex >= plan.chunks.length) {
      return plan;
    }

    const safeFill = safe(fillPrice, 0);
    const safeExpected = safe(expectedPrice, 0);

    const chunk = plan.chunks[chunkIndex];

    if (!success) {
      chunk.status = 'failed';
      // Cancel all remaining chunks on failure
      for (let i = chunkIndex + 1; i < plan.chunks.length; i++) {
        if (plan.chunks[i].status === 'pending') {
          plan.chunks[i].status = 'cancelled';
        }
      }
      return plan;
    }

    // Calculate slippage in bps
    let slippageBps = 0;
    if (safeExpected > 0 && safeFill > 0) {
      const rawSlippage = ((safeFill - safeExpected) / safeExpected) * 10000;
      // For buys, positive slippage is bad (paid more); for sells, negative is bad (received less)
      slippageBps = safe(Math.abs(rawSlippage), 0);
    }

    chunk.status = 'filled';
    chunk.fillPrice = safeFill;
    chunk.slippageBps = slippageBps;

    // If chunk slippage is 2x or worse than predicted -> cancel remaining
    const predicted = safe(plan.predictedSlippageBps, 1);
    if (slippageBps > predicted * 2 && predicted > 0) {
      for (let i = chunkIndex + 1; i < plan.chunks.length; i++) {
        if (plan.chunks[i].status === 'pending') {
          plan.chunks[i].status = 'cancelled';
        }
      }
    }

    return plan;
  }

  // ── Cancel Check ──────────────────────────────────────────────────

  shouldCancelRemaining(plan: ExecutionPlan, currentPrice?: number): boolean {
    const predicted = safe(plan.predictedSlippageBps, 1);

    // Check first filled chunk: if slippage > 3x predicted -> cancel
    const firstFilled = plan.chunks.find((c) => c.status === 'filled');
    if (firstFilled && Number.isFinite(firstFilled.slippageBps)) {
      if (firstFilled.slippageBps! > predicted * 3 && predicted > 0) {
        return true;
      }
    }

    // Check price movement since plan creation
    if (Number.isFinite(currentPrice) && currentPrice! > 0 && firstFilled?.fillPrice) {
      const safeFillPrice = safe(firstFilled.fillPrice, 0);
      if (safeFillPrice > 0) {
        const priceMovePercent = Math.abs((currentPrice! - safeFillPrice) / safeFillPrice) * 100;
        if (priceMovePercent > 0.3) {
          return true;
        }
      }
    }

    return false;
  }

  // ── Style Distribution ────────────────────────────────────────────

  getStyleDistribution(): { aggressive: number; passive: number; hybrid: number } {
    const dist = { aggressive: 0, passive: 0, hybrid: 0 };
    for (const entry of this.planHistory) {
      dist[entry.style]++;
    }
    return dist;
  }

  // ── Adaptive Parameters ───────────────────────────────────────────

  getAdaptiveParams(): {
    slippageThresholdBps: number;
    styleThresholds: typeof STYLE_THRESHOLDS;
    sizeReduction: typeof SIZE_REDUCTION;
    componentWeights: typeof COMPONENT_WEIGHTS;
    chunkConfigs: typeof CHUNK_CONFIGS;
    planHistorySize: number;
  } {
    return {
      slippageThresholdBps: this.slippageThresholdBps,
      styleThresholds: { ...STYLE_THRESHOLDS },
      sizeReduction: { ...SIZE_REDUCTION },
      componentWeights: { ...COMPONENT_WEIGHTS },
      chunkConfigs: {
        aggressive: { ...CHUNK_CONFIGS.aggressive, percents: [...CHUNK_CONFIGS.aggressive.percents] },
        passive: { ...CHUNK_CONFIGS.passive, percents: [...CHUNK_CONFIGS.passive.percents] },
        hybrid: { ...CHUNK_CONFIGS.hybrid, percents: [...CHUNK_CONFIGS.hybrid.percents] },
      },
      planHistorySize: this.planHistory.length,
    };
  }

  // ── Reset ─────────────────────────────────────────────────────────

  reset(): void {
    this.planHistory = [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private recordPlan(style: ExecutionStyle): void {
    this.planHistory.push({ style, timestamp: Date.now() });
    // Bounded storage: keep only the last MAX_PLAN_HISTORY entries
    if (this.planHistory.length > MAX_PLAN_HISTORY) {
      this.planHistory = this.planHistory.slice(this.planHistory.length - MAX_PLAN_HISTORY);
    }
  }
}

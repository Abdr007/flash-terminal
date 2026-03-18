/**
 * Execution Model — Simulate real-world execution costs.
 *
 * Adjusts expected value for:
 * 1. Slippage (price impact based on position size vs liquidity)
 * 2. Spread (bid-ask cost)
 * 3. Fees (exchange trading fees)
 *
 * This prevents the agent from taking trades where edge < execution cost.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionCost {
  /** Estimated slippage in % */
  slippagePct: number;
  /** Estimated spread cost in % */
  spreadPct: number;
  /** Trading fee in % (one way) */
  feePct: number;
  /** Total round-trip cost in % (entry + exit) */
  totalCostPct: number;
  /** Whether trade is viable after costs */
  viable: boolean;
  /** Adjusted R:R after costs */
  adjustedRR: number;
}

// ─── Flash Trade Fee Structure ───────────────────────────────────────────────

const BASE_FEE_BPS = 8; // 0.08% per trade (Flash Trade)
const BASE_SPREAD_BPS = 5; // ~0.05% estimated spread

// ─── Execution Model ─────────────────────────────────────────────────────────

export class ExecutionModel {

  /**
   * Estimate total execution costs for a trade.
   */
  estimate(
    positionSizeUsd: number,
    marketOiUsd: number,
    rrRatio: number,
    entryPrice: number,
    slPrice: number,
  ): ExecutionCost {
    // Slippage: scales with size relative to market OI
    // Small trade vs large OI = negligible slippage
    // Large trade vs small OI = significant slippage
    let slippagePct = 0;
    if (marketOiUsd > 0 && Number.isFinite(marketOiUsd)) {
      const sizeRatio = positionSizeUsd / marketOiUsd;
      // Estimate: 0.01% slippage per 1% of OI
      slippagePct = sizeRatio * 100 * 0.01;
    }
    slippagePct = Math.min(0.5, slippagePct); // Cap at 0.5%

    // Spread cost
    const spreadPct = BASE_SPREAD_BPS / 100;

    // Fee cost (one way)
    const feePct = BASE_FEE_BPS / 100;

    // Total round-trip: (slippage + spread + fee) × 2 for entry and exit
    const oneWayCost = slippagePct + spreadPct + feePct;
    const totalCostPct = oneWayCost * 2;

    // Adjusted R:R: reduce reward by costs, increase risk by costs
    const riskPct = entryPrice > 0 ? Math.abs(entryPrice - slPrice) / entryPrice * 100 : 1;
    const adjustedRiskPct = riskPct + totalCostPct;
    const adjustedRewardPct = riskPct * rrRatio - totalCostPct;
    const adjustedRR = adjustedRiskPct > 0 ? adjustedRewardPct / adjustedRiskPct : 0;

    // Viable if adjusted R:R still positive and costs < 30% of expected reward
    const viable = adjustedRR > 1.0 && totalCostPct < (riskPct * rrRatio * 0.3);

    return {
      slippagePct,
      spreadPct,
      feePct,
      totalCostPct,
      viable,
      adjustedRR: Math.max(0, adjustedRR),
    };
  }
}

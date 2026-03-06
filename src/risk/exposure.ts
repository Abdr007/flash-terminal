import { Portfolio, ExposureSummary, TradeSide } from '../types/index.js';

/**
 * Compute portfolio exposure summary.
 */
export function computeExposure(portfolio: Portfolio): ExposureSummary {
  let totalLongExposure = 0;
  let totalShortExposure = 0;
  const marketExposure = new Map<string, number>();

  for (const pos of portfolio.positions) {
    const size = Number.isFinite(pos.sizeUsd) ? pos.sizeUsd : 0;
    if (pos.side === TradeSide.Long) {
      totalLongExposure += size;
    } else {
      totalShortExposure += size;
    }

    const current = marketExposure.get(pos.market) ?? 0;
    marketExposure.set(pos.market, current + size);
  }

  const netExposure = totalLongExposure - totalShortExposure;
  const totalExposure = totalLongExposure + totalShortExposure;
  const totalCollateral = Number.isFinite(portfolio.totalCollateralUsd) ? portfolio.totalCollateralUsd : 0;
  const rawUtilization = totalCollateral > 0
    ? (totalExposure / totalCollateral) * 100
    : 0;
  const collateralUtilization = Number.isFinite(rawUtilization) ? rawUtilization : 0;

  const concentrationRisk = Array.from(marketExposure.entries())
    .map(([market, exposure]) => ({
      market,
      percentage: totalExposure > 0 ? (exposure / totalExposure) * 100 : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  return {
    totalLongExposure,
    totalShortExposure,
    netExposure,
    totalCollateral,
    collateralUtilization,
    concentrationRisk,
  };
}

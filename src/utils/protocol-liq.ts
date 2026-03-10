/**
 * Protocol Liquidation Utilities
 *
 * All liquidation price calculations MUST use getLiquidationPriceContractHelper()
 * from the Flash SDK. This module provides a unified wrapper.
 *
 * Reference: https://github.com/flash-trade/flash-trade-sdk/blob/main/SDK/src/PerpetualsClient.ts#L2244
 *
 * Data sources:
 * - CustodyAccount (on-chain) — maintenance margin, fee config
 * - PositionAccount (on-chain) — collateral, size, entry price
 * - OraclePrice (Pyth) — entry price representation
 */

import { TradeSide } from '../types/index.js';

const RATE_POWER = 1_000_000_000;
const BPS_POWER = 10_000;

/**
 * Compute liquidation price using Flash SDK's getLiquidationPriceContractHelper().
 *
 * This mirrors the exact on-chain logic:
 *   liabilities = sizeUsd * BPS_POWER / maxLeverage
 *   liq price = entry ± (collateral - liabilities - unsettledFees) / size * entryPrice
 *
 * @param perpClient - Flash SDK PerpetualsClient
 * @param entryOraclePrice - OraclePrice from position entry
 * @param unsettledFees - BN of accumulated fees (USD, 6 decimals)
 * @param side - SDK Side enum value
 * @param custodyAcct - CustodyAccount (fetched from on-chain)
 * @param posAcct - PositionAccount (or modified clone)
 * @returns Liquidation price as a UI number, or 0 if unavailable
 */
export function computeLiquidationPrice(
  perpClient: any,
  entryOraclePrice: any,
  unsettledFees: any,
  side: any,
  custodyAcct: any,
  posAcct: any,
): number {
  try {
    const liqOraclePrice = perpClient.getLiquidationPriceContractHelper(
      entryOraclePrice, unsettledFees, side, custodyAcct, posAcct,
    );
    const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
    if (Number.isFinite(liqUi) && liqUi > 0) {
      return liqUi;
    }
  } catch {
    // SDK call failed — return 0
  }
  return 0;
}

/**
 * Compute liquidation price for simulation mode using the same protocol formula
 * as getLiquidationPriceContractHelper but with known constants.
 *
 * Formula from Flash SDK PerpetualsClient.ts:
 *   liabilities = sizeUsd * maintenanceMarginRate  (from custodyAcct.pricing.maintenanceMargin / BPS_POWER)
 *   exitFee = sizeUsd * closeFeeRate
 *   availableCollateral = collateral - liabilities - unsettledFees - exitFee
 *   priceMove = availableCollateral / sizeUsd * entryPrice
 *   liqPrice = entryPrice - priceMove (long) or entryPrice + priceMove (short)
 *
 * Protocol parameter sources:
 *   maintenanceMarginRate: 1 / (custodyAcct.pricing.maxLeverage / BPS_POWER) (default 1% = 1/100)
 *   closeFeeRate: custodyAcct.fees.closePosition / RATE_POWER (default 0.08%)
 *
 * @param maintenanceMarginRate - Derived as 1 / maxLeverage from custodyAcct.pricing.maxLeverage.
 *                                 Defaults to 0.01 (1%), equivalent to maxLeverage=100.
 */
export function computeSimulationLiquidationPrice(
  entryPrice: number,
  sizeUsd: number,
  collateralUsd: number,
  side: TradeSide,
  maintenanceMarginRate: number = 0.01,
  closeFeeRate: number = 0.0008,
  unsettledFeesUsd: number = 0,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(sizeUsd) || sizeUsd <= 0 ||
      !Number.isFinite(collateralUsd) || collateralUsd <= 0) {
    return 0;
  }

  // Maintenance margin from custodyAcct.pricing.maintenanceMargin / BPS_POWER
  const maintenanceMargin = sizeUsd * maintenanceMarginRate;
  // Exit fee: sizeUsd * closeFeeRate
  const exitFee = sizeUsd * closeFeeRate;
  // Available collateral after liabilities
  const availableCollateral = collateralUsd - maintenanceMargin - exitFee - unsettledFeesUsd;

  if (availableCollateral <= 0) {
    // Position is at or beyond liquidation
    return entryPrice;
  }

  // Price distance to liquidation
  const priceMove = (availableCollateral / sizeUsd) * entryPrice;

  if (side === TradeSide.Long) {
    const liqPrice = entryPrice - priceMove;
    return liqPrice > 0 ? liqPrice : 0;
  } else {
    return entryPrice + priceMove;
  }
}

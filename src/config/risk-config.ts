import { AutopilotConfig } from '../types/index.js';

/**
 * Default autopilot risk configuration.
 * These limits are enforced before any autopilot trade executes.
 */
export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  maxPositionSize: 1000,     // Max $1000 per position
  maxExposure: 2000,         // Max $2000 total exposure
  maxLeverage: 5,            // Max 5x leverage in autopilot
  intervalMs: 30_000,        // 30 second cycle
  markets: ['SOL', 'BTC', 'ETH'],
};

export interface AutopilotRiskCheck {
  passed: boolean;
  reason?: string;
}

/**
 * Run all safety checks before an autopilot trade.
 */
export function checkAutopilotRisk(params: {
  collateral: number;
  leverage: number;
  balance: number;
  currentExposure: number;
  config: AutopilotConfig;
}): AutopilotRiskCheck {
  const { collateral, leverage, balance, currentExposure, config } = params;

  // Guard against NaN/Infinity and negative values which would bypass all comparisons
  if (!Number.isFinite(collateral) || !Number.isFinite(leverage) || !Number.isFinite(balance) || !Number.isFinite(currentExposure)) {
    return { passed: false, reason: 'Invalid numeric input (NaN or Infinity)' };
  }
  if (collateral < 0 || leverage < 0 || balance < 0 || currentExposure < 0) {
    return { passed: false, reason: 'Negative numeric input rejected' };
  }

  if (collateral > config.maxPositionSize) {
    return { passed: false, reason: `Position size $${collateral} exceeds max $${config.maxPositionSize}` };
  }

  if (leverage > config.maxLeverage) {
    return { passed: false, reason: `Leverage ${leverage}x exceeds max ${config.maxLeverage}x` };
  }

  if (collateral > balance * 0.25) {
    return { passed: false, reason: `Collateral $${collateral} exceeds 25% of balance $${balance.toFixed(2)}` };
  }

  const newExposure = currentExposure + (collateral * leverage);
  if (newExposure > config.maxExposure) {
    return { passed: false, reason: `New exposure $${newExposure.toFixed(2)} exceeds max $${config.maxExposure}` };
  }

  if (balance < collateral) {
    return { passed: false, reason: `Insufficient balance: $${balance.toFixed(2)} < $${collateral}` };
  }

  return { passed: true };
}

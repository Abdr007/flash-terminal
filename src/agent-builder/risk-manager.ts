/**
 * Risk Manager — Capital protection and trade gating.
 *
 * Enforces hard rules:
 * - Max concurrent positions
 * - Max leverage
 * - Position sizing (% of capital)
 * - Daily loss limit
 * - Cooldown after losses
 * - No averaging down
 */

import type { RiskLimits, AgentState, TradeDecision, DecisionAction } from './types.js';
import { DEFAULT_RISK_LIMITS } from './types.js';

export class RiskManager {
  private readonly limits: RiskLimits;

  constructor(limits: Partial<RiskLimits> = {}) {
    this.limits = { ...DEFAULT_RISK_LIMITS, ...limits };
  }

  // ─── Trade Gating ──────────────────────────────────────────────────

  /**
   * Check if a proposed trade is allowed given current state.
   * Returns { allowed, reason } — reason explains the block if not allowed.
   */
  checkTradeAllowed(
    state: AgentState,
    market: string,
    side: 'long' | 'short',
    leverage: number,
  ): { allowed: boolean; reason: string } {
    // 1. Check daily loss limit
    const dailyLossPct = state.startingCapital > 0
      ? Math.abs(Math.min(0, state.dailyPnl)) / state.startingCapital
      : 0;
    if (dailyLossPct >= this.limits.maxDailyLossPct) {
      return { allowed: false, reason: `Daily loss limit reached (${(dailyLossPct * 100).toFixed(1)}% >= ${(this.limits.maxDailyLossPct * 100).toFixed(0)}%)` };
    }

    // 2. Check cooldown
    if (state.inCooldown && Date.now() < state.cooldownUntil) {
      const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
      return { allowed: false, reason: `In cooldown (${remaining}s remaining)` };
    }

    // 3. Check max positions
    if (state.positions.length >= this.limits.maxPositions) {
      return { allowed: false, reason: `Max positions reached (${state.positions.length}/${this.limits.maxPositions})` };
    }

    // 4. Check leverage
    if (leverage > this.limits.maxLeverage) {
      return { allowed: false, reason: `Leverage ${leverage}x exceeds max ${this.limits.maxLeverage}x` };
    }

    // 5. Check allowed markets
    if (this.limits.allowedMarkets.length > 0 && !this.limits.allowedMarkets.includes(market.toUpperCase())) {
      return { allowed: false, reason: `Market ${market} not in allowed list` };
    }

    // 6. No averaging down — check for existing position on same market/side
    const existing = state.positions.find(
      (p) => p.market.toUpperCase() === market.toUpperCase() && p.side === side,
    );
    if (existing) {
      return { allowed: false, reason: `Already have ${side} position on ${market} (no averaging down)` };
    }

    return { allowed: true, reason: 'Trade allowed' };
  }

  // ─── Position Sizing ───────────────────────────────────────────────

  /**
   * Calculate safe collateral amount based on capital and risk limits.
   */
  calculatePositionSize(capital: number): number {
    const raw = capital * this.limits.positionSizePct;
    // Floor to 2 decimals, minimum $1
    return Math.max(1, Math.floor(raw * 100) / 100);
  }

  /**
   * Clamp leverage to the configured maximum.
   */
  clampLeverage(requested: number): number {
    return Math.min(Math.max(1, requested), this.limits.maxLeverage);
  }

  // ─── State Updates ─────────────────────────────────────────────────

  /**
   * Process a completed trade and update agent state.
   * Returns updated state with cooldown/loss tracking.
   */
  processTradeResult(state: AgentState, pnl: number): AgentState {
    const updated = { ...state };
    updated.dailyPnl += pnl;
    updated.dailyTradeCount++;
    updated.lastTradeTimestamp = Date.now();

    if (pnl < 0) {
      updated.consecutiveLosses++;
      // Enter cooldown after any loss
      updated.inCooldown = true;
      updated.cooldownUntil = Date.now() + this.limits.cooldownAfterLossMs;
    } else {
      updated.consecutiveLosses = 0;
      updated.inCooldown = false;
      updated.cooldownUntil = 0;
    }

    return updated;
  }

  /**
   * Check if daily loss limit has been breached — agent should stop.
   */
  isDailyLossBreached(state: AgentState): boolean {
    if (state.startingCapital <= 0) return false;
    const lossPct = Math.abs(Math.min(0, state.dailyPnl)) / state.startingCapital;
    return lossPct >= this.limits.maxDailyLossPct;
  }

  /**
   * Assess risk level for a proposed decision.
   */
  assessRisk(
    decision: Omit<TradeDecision, 'riskLevel' | 'blockReason'>,
    state: AgentState,
  ): { riskLevel: 'safe' | 'elevated' | 'blocked'; blockReason?: string } {
    if (decision.action !== 'open' as DecisionAction) {
      return { riskLevel: 'safe' };
    }

    const check = this.checkTradeAllowed(
      state,
      decision.market,
      decision.side ?? 'long',
      decision.leverage ?? 1,
    );

    if (!check.allowed) {
      return { riskLevel: 'blocked', blockReason: check.reason };
    }

    // Elevated risk conditions
    const leverageRatio = (decision.leverage ?? 1) / this.limits.maxLeverage;
    const capitalUsage = (decision.collateral ?? 0) / (state.currentCapital || 1);
    const dailyLossRatio = state.startingCapital > 0
      ? Math.abs(Math.min(0, state.dailyPnl)) / state.startingCapital / this.limits.maxDailyLossPct
      : 0;

    if (leverageRatio > 0.8 || capitalUsage > 0.05 || dailyLossRatio > 0.5 || state.consecutiveLosses >= 2) {
      return { riskLevel: 'elevated' };
    }

    return { riskLevel: 'safe' };
  }

  // ─── Getters ───────────────────────────────────────────────────────

  get config(): Readonly<RiskLimits> {
    return this.limits;
  }
}

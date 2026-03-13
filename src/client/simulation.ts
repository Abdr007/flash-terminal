import { randomUUID } from 'crypto';
import {
  SimulationState,
  SimulatedPosition,
  SimulatedTrade,
  TradeSide,
  Position,
  MarketData,
  Portfolio,
  IFlashClient,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
  DryRunPreview,
  validateTrade,
} from '../types/index.js';
import { PriceService } from '../data/prices.js';
import { FStatsClient } from '../data/fstats.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getProtocolFeeRates, calcFeeUsd } from '../utils/protocol-fees.js';
import { computeSimulationLiquidationPrice } from '../utils/protocol-liq.js';

const MAX_TRADE_HISTORY = 500;
const MAX_LIVE_PRICE_ENTRIES = 100;

// Feed IDs are centralized in PriceService (src/data/prices.ts).
// Simulation delegates all price fetching to PriceService (Pyth Hermes).

/**
 * SimulatedFlashClient implements IFlashClient for paper trading.
 * Uses Pyth Hermes as price source (same oracle as Flash Trade on-chain).
 * No real transactions are ever submitted.
 */
export class SimulatedFlashClient implements IFlashClient {
  private state: SimulationState;
  private priceService: PriceService;
  private fstats: FStatsClient;
  private livePrices: Map<string, number> = new Map();
  private priceChanges24h: Map<string, number> = new Map();
  readonly walletAddress: string;
  /** Trade mutex — prevents concurrent state mutations from corrupting balance/positions */
  private tradeLock: Promise<void> = Promise.resolve();

  private async withTradeLock<T>(fn: () => Promise<T>): Promise<T> {
    let releasePrev: () => void;
    const prev = this.tradeLock;
    this.tradeLock = new Promise<void>(resolve => { releasePrev = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      releasePrev!();
    }
  }

  constructor(initialBalance = 10_000) {
    this.walletAddress = `SIM_${randomUUID().slice(0, 8).toUpperCase()}`;
    this.state = {
      balance: initialBalance,
      positions: [],
      tradeHistory: [],
      totalRealizedPnl: 0,
      totalFeesPaid: 0,
    };
    this.priceService = new PriceService();
    this.fstats = new FStatsClient();
    // SECURITY: No hardcoded seed prices. Live prices are fetched on first
    // trade or market data request via refreshPrices(). If all APIs fail,
    // getPrice() throws an error — preventing trades at stale prices.
  }

  private async refreshPrices(): Promise<void> {
    const logger = getLogger();

    // Bound livePrices map to prevent unbounded growth during long sessions
    if (this.livePrices.size > MAX_LIVE_PRICE_ENTRIES) {
      const excess = Array.from(this.livePrices.keys()).slice(0, 20);
      for (const k of excess) {
        this.livePrices.delete(k);
        this.priceChanges24h.delete(k);
      }
    }

    // ── PRIMARY: PriceService (Pyth Hermes) — same oracle Flash Trade uses on-chain ──
    try {
      const { getAllMarkets } = await import('../config/index.js');
      const symbols = getAllMarkets();
      const prices = await this.priceService.getPrices(symbols);
      for (const [sym, tp] of prices) {
        if (tp.price > 0 && Number.isFinite(tp.price)) {
          this.livePrices.set(sym, tp.price);
        }
        if (tp.priceChange24h !== 0) {
          this.priceChanges24h.set(sym, tp.priceChange24h);
        }
      }
      logger.debug('SIM', `PriceService: updated ${prices.size}/${symbols.length} prices`);
    } catch (error: unknown) {
      logger.info('SIM', `Price fetch failed: ${getErrorMessage(error)}`);
    }

    // ── SECONDARY: fstats — fallback for any remaining gaps ──
    try {
      const positions = await this.fstats.getOpenPositions();
      const priceMap = new Map<string, number[]>();
      for (const p of positions) {
        const sym = (p.market_symbol ?? p.market ?? '').toUpperCase();
        const price = p.mark_price ?? p.entry_price;
        if (sym && price && typeof price === 'number' && price > 0) {
          if (!priceMap.has(sym)) priceMap.set(sym, []);
          priceMap.get(sym)!.push(price);
        }
      }
      for (const [sym, prices] of priceMap) {
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        if (!this.livePrices.has(sym) || this.livePrices.get(sym) === 0) {
          this.livePrices.set(sym, avg);
        }
      }
    } catch (error: unknown) {
      logger.debug('SIM', `fstats enrichment failed: ${getErrorMessage(error)}`);
    }

    logger.debug('SIM', `Price data available for ${this.livePrices.size} markets`);
  }

  private getPrice(market: string): number {
    const price = this.livePrices.get(market.toUpperCase());
    if (!price || price <= 0) {
      throw new Error(`No price data for ${market}. Try again in a moment.`);
    }
    return price;
  }

  /**
   * Compute liquidation price using the same formula as Flash SDK's
   * getLiquidationPriceContractHelper(). Uses protocol constants
   * (maxLeverage, closeFeeRate) derived from CustodyAccount parameters.
   *
   * Reference: flash-sdk/src/PerpetualsClient.ts#L2244
   */
  private calcLiquidationPrice(
    entryPrice: number,
    leverage: number,
    side: TradeSide,
    maintenanceMarginRate: number = 0.01,
    closeFeeRate: number = 0.0008,
  ): number {
    if (!Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return 0;
    }
    const sizeUsd = 1; // normalized
    const collateralUsd = sizeUsd / leverage;
    return computeSimulationLiquidationPrice(
      entryPrice, sizeUsd, collateralUsd, side, maintenanceMarginRate, closeFeeRate,
    );
  }

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<OpenPositionResult> {
    return this.withTradeLock(() => this._openPosition(market, side, collateralAmount, leverage));
  }

  private async _openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<OpenPositionResult> {
    const logger = getLogger();
    await this.refreshPrices();

    // Per-market leverage limit (from Flash Trade protocol)
    const { getMaxLeverage } = await import('../config/index.js');
    const maxLev = getMaxLeverage(market, true); // allow up to degen max; tool layer enforces degen flag
    if (leverage > maxLev) {
      throw new Error(`Maximum leverage for ${market}: ${maxLev}x`);
    }

    // Validate
    const validation = validateTrade(market, side, collateralAmount, leverage, this.state.balance);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    const price = this.getPrice(market);
    const sizeUsd = collateralAmount * leverage;

    // Fetch fee rates from protocol (CustodyAccount via Flash SDK)
    const feeRates = await getProtocolFeeRates(market, null);
    const openFee = calcFeeUsd(sizeUsd, feeRates.openFeeRate);

    const liquidationPrice = this.calcLiquidationPrice(price, leverage, side, feeRates.maintenanceMarginRate, feeRates.closeFeeRate);

    // Reject positions where liquidation price equals entry (instant liquidation)
    if (liquidationPrice === price || liquidationPrice <= 0) {
      throw new Error(`Leverage ${leverage}x is too high — position would be immediately liquidated. Reduce leverage.`);
    }

    if (collateralAmount + openFee > this.state.balance) {
      throw new Error(`Insufficient balance for collateral + fee: need $${(collateralAmount + openFee).toFixed(2)}, have $${this.state.balance.toFixed(2)}`);
    }

    this.state.balance -= collateralAmount + openFee;
    this.state.totalFeesPaid += openFee;

    // Check for existing same-side position — merge if exists (matches Flash Trade protocol)
    const existing = this.state.positions.find(
      p => p.market === market.toUpperCase() && p.side === side,
    );

    let txSig: string;
    let finalEntryPrice: number;

    if (existing) {
      // Merge: weighted average entry price, sum collateral and size
      const totalSize = existing.sizeUsd + sizeUsd;
      finalEntryPrice = totalSize > 0
        ? (existing.entryPrice * existing.sizeUsd + price * sizeUsd) / totalSize
        : price;
      existing.sizeUsd = totalSize;
      existing.collateralUsd += collateralAmount;
      existing.leverage = existing.collateralUsd > 0 ? existing.sizeUsd / existing.collateralUsd : leverage;
      existing.entryPrice = finalEntryPrice;
      existing.openFee += openFee;
      txSig = `SIM_ADD_${existing.id}`;
    } else {
      const position: SimulatedPosition = {
        id: randomUUID().slice(0, 8),
        market: market.toUpperCase(),
        side,
        entryPrice: price,
        sizeUsd,
        collateralUsd: collateralAmount,
        leverage,
        openFee,
        openedAt: Date.now(),
        maintenanceMarginRate: feeRates.maintenanceMarginRate,
        closeFeeRate: feeRates.closeFeeRate,
      };
      this.state.positions.push(position);
      finalEntryPrice = price;
      txSig = `SIM_${position.id}`;
    }

    this.state.tradeHistory.push({
      id: existing?.id ?? randomUUID().slice(0, 8),
      action: 'open',
      market: market.toUpperCase(),
      side,
      sizeUsd,
      collateralUsd: collateralAmount,
      leverage,
      price,
      timestamp: Date.now(),
    });
    this.trimHistory();

    logger.trade('OPEN', { market, side, collateral: collateralAmount, leverage, price, tx: txSig });

    return { txSignature: txSig, entryPrice: finalEntryPrice, liquidationPrice, sizeUsd };
  }

  async closePosition(market: string, side: TradeSide): Promise<ClosePositionResult> {
    return this.withTradeLock(() => this._closePosition(market, side));
  }

  private async _closePosition(market: string, side: TradeSide): Promise<ClosePositionResult> {
    const logger = getLogger();
    await this.refreshPrices();

    const upperMarket = market.toUpperCase();
    const idx = this.state.positions.findIndex(
      (p) => p.market === upperMarket && p.side === side
    );
    if (idx === -1) throw new Error(`No open ${side} position on ${market}`);

    const position = this.state.positions[idx];
    const price = this.getPrice(market);
    const priceDelta = price - position.entryPrice;
    const pnlMultiplier = side === TradeSide.Long ? 1 : -1;
    const pnl = position.entryPrice > 0
      ? (priceDelta / position.entryPrice) * position.sizeUsd * pnlMultiplier
      : 0;

    // Close fee from protocol
    const closeFeeRates = await getProtocolFeeRates(market, null);
    const closeFee = calcFeeUsd(position.sizeUsd, closeFeeRates.closeFeeRate);
    this.state.totalFeesPaid += closeFee;
    this.state.totalRealizedPnl += pnl;

    // Floor balance at zero (liquidation scenario: collateral + PnL - fee < 0)
    const returnAmount = position.collateralUsd + pnl - closeFee;
    this.state.balance += Math.max(returnAmount, 0);
    this.state.positions.splice(idx, 1);
    this.state.tradeHistory.push({
      id: position.id,
      action: 'close',
      market: position.market,
      side,
      sizeUsd: position.sizeUsd,
      collateralUsd: position.collateralUsd,
      leverage: position.leverage,
      price,
      entryPrice: position.entryPrice,
      pnl,
      timestamp: Date.now(),
    });
    this.trimHistory();

    const txSig = `SIM_CLOSE_${position.id}`;
    logger.trade('CLOSE', { market, side, pnl, price, tx: txSig });

    return { txSignature: txSig, exitPrice: price, pnl };
  }

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    return this.withTradeLock(() => this._addCollateral(market, side, amount));
  }

  private async _addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Collateral amount must be a positive number');
    }
    if (amount > this.state.balance) {
      throw new Error(`Insufficient balance: $${this.state.balance.toFixed(2)} available`);
    }
    const pos = this.state.positions.find(
      (p) => p.market === market.toUpperCase() && p.side === side
    );
    if (!pos) throw new Error(`No open ${side} position on ${market}`);

    this.state.balance -= amount;
    pos.collateralUsd += amount;
    const newLev = pos.collateralUsd > 0 ? pos.sizeUsd / pos.collateralUsd : 0;
    pos.leverage = Number.isFinite(newLev) ? newLev : 0;

    getLogger().trade('ADD_COLLATERAL', { market, side, amount, newLeverage: pos.leverage });
    this.state.tradeHistory.push({
      id: pos.id,
      action: 'add_collateral',
      market: pos.market,
      side,
      sizeUsd: pos.sizeUsd,
      collateralUsd: amount,
      leverage: pos.leverage,
      price: this.livePrices.get(pos.market) ?? pos.entryPrice,
      timestamp: Date.now(),
    });
    this.trimHistory();
    return { txSignature: `SIM_ADD_${pos.id}`, newLeverage: pos.leverage };
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    return this.withTradeLock(() => this._removeCollateral(market, side, amount));
  }

  private async _removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Collateral amount must be a positive number');
    }
    // Refresh prices before liquidation safety check
    await this.refreshPrices();
    const pos = this.state.positions.find(
      (p) => p.market === market.toUpperCase() && p.side === side
    );
    if (!pos) throw new Error(`No open ${side} position on ${market}`);
    if (amount >= pos.collateralUsd) throw new Error('Cannot remove all collateral — close position instead');

    // Check that removal won't cause instant liquidation
    const newCollateral = pos.collateralUsd - amount;
    const newLev = newCollateral > 0 ? pos.sizeUsd / newCollateral : 0;
    if (newLev > 0) {
      const currentPrice = this.livePrices.get(pos.market) ?? pos.entryPrice;
      const newLiqPrice = this.calcLiquidationPrice(pos.entryPrice, newLev, side, pos.maintenanceMarginRate, pos.closeFeeRate);
      const wouldLiquidate = side === TradeSide.Long
        ? newLiqPrice >= currentPrice
        : newLiqPrice <= currentPrice;
      if (wouldLiquidate || newLiqPrice <= 0 || newLiqPrice === pos.entryPrice) {
        throw new Error(
          `Removing $${amount.toFixed(2)} would push leverage to ${newLev.toFixed(1)}x — position would be liquidated. Reduce the amount.`
        );
      }
    }

    pos.collateralUsd = newCollateral;
    pos.leverage = Number.isFinite(newLev) ? newLev : 0;
    this.state.balance += amount;

    getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, newLeverage: pos.leverage });
    this.state.tradeHistory.push({
      id: pos.id,
      action: 'remove_collateral',
      market: pos.market,
      side,
      sizeUsd: pos.sizeUsd,
      collateralUsd: amount,
      leverage: pos.leverage,
      price: this.livePrices.get(pos.market) ?? pos.entryPrice,
      timestamp: Date.now(),
    });
    this.trimHistory();
    return { txSignature: `SIM_RM_${pos.id}`, newLeverage: pos.leverage };
  }

  async getPositions(): Promise<Position[]> {
    await this.refreshPrices();
    return this.state.positions.map((p) => {
      const currentPrice = this.livePrices.get(p.market) ?? p.entryPrice;
      const priceDelta = currentPrice - p.entryPrice;
      const pnlMultiplier = p.side === TradeSide.Long ? 1 : -1;
      const unrealizedPnl = p.entryPrice > 0
        ? (priceDelta / p.entryPrice) * p.sizeUsd * pnlMultiplier
        : 0;
      const liquidationPrice = this.calcLiquidationPrice(p.entryPrice, p.leverage, p.side, p.maintenanceMarginRate, p.closeFeeRate);

      return {
        pubkey: `SIM_${p.id}`,
        market: p.market,
        side: p.side,
        entryPrice: p.entryPrice,
        currentPrice,
        markPrice: currentPrice,
        sizeUsd: p.sizeUsd,
        collateralUsd: p.collateralUsd,
        leverage: p.leverage,
        unrealizedPnl,
        unrealizedPnlPercent: p.collateralUsd > 0 ? (unrealizedPnl / p.collateralUsd) * 100 : 0,
        liquidationPrice,
        openFee: p.openFee,
        totalFees: p.openFee,
        fundingRate: 0,
        timestamp: p.openedAt / 1000,
      };
    });
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    await this.refreshPrices();

    // If no live prices available yet, request common markets
    if (this.livePrices.size === 0) {
      const defaultSymbols = ['SOL', 'BTC', 'ETH', 'BNB', 'JUP', 'PYTH', 'RAY', 'BONK', 'WIF'];
      try {
        const prices = await this.priceService.getPrices(defaultSymbols);
        for (const [sym, tp] of prices) {
          if (tp.price > 0) this.livePrices.set(sym, tp.price);
        }
      } catch {
        // If all APIs fail, return empty — no fabricated data
      }
    }

    const symbols = market
      ? [market.toUpperCase()]
      : Array.from(this.livePrices.keys());

    return symbols
      .filter((s) => this.livePrices.has(s) && this.livePrices.get(s)! > 0)
      .map((symbol) => ({
        symbol,
        price: this.livePrices.get(symbol)!,
        priceChange24h: this.priceChanges24h.get(symbol) ?? 0,
        openInterestLong: 0,
        openInterestShort: 0,
        maxLeverage: 100,
        fundingRate: 0,
      }));
  }

  async getPortfolio(): Promise<Portfolio> {
    const positions = await this.getPositions();
    const totalCollateralUsd = positions.reduce((s, p) => s + p.collateralUsd, 0);
    const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalPositionValue = positions.reduce((s, p) => s + p.sizeUsd, 0);

    return {
      walletAddress: this.walletAddress,
      balance: this.state.balance,
      balanceLabel: `Balance: $${this.state.balance.toFixed(2)}`,
      totalCollateralUsd,
      totalUnrealizedPnl,
      totalRealizedPnl: this.state.totalRealizedPnl,
      totalFees: this.state.totalFeesPaid,
      positions,
      totalPositionValue,
      usdcBalance: this.state.balance, // Simulation balance is USDC
    };
  }

  getBalance(): number {
    return this.state.balance;
  }

  async previewOpenPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<DryRunPreview> {
    await this.refreshPrices();

    const validation = validateTrade(market, side, collateralAmount, leverage, this.state.balance);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    const price = this.getPrice(market);
    const sizeUsd = collateralAmount * leverage;
    const previewFeeRates = await getProtocolFeeRates(market, null);
    const liqPrice = this.calcLiquidationPrice(price, leverage, side, previewFeeRates.maintenanceMarginRate, previewFeeRates.closeFeeRate);
    const fee = calcFeeUsd(sizeUsd, previewFeeRates.openFeeRate);

    return {
      market: market.toUpperCase(),
      side,
      collateral: collateralAmount,
      leverage,
      positionSize: sizeUsd,
      entryPrice: price,
      liquidationPrice: liqPrice,
      estimatedFee: fee,
      simulationSuccess: true,
      simulationLogs: ['[Simulation mode — no on-chain transaction compiled]'],
    };
  }

  getTradeHistory(): SimulatedTrade[] {
    return [...this.state.tradeHistory];
  }

  /** Trim trade history to prevent unbounded memory growth. */
  private trimHistory(): void {
    if (this.state.tradeHistory.length > MAX_TRADE_HISTORY) {
      this.state.tradeHistory = this.state.tradeHistory.slice(-MAX_TRADE_HISTORY);
    }
  }
}

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
  validateTrade,
} from '../types/index.js';
import { PriceService } from '../data/prices.js';
import { FStatsClient } from '../data/fstats.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const MAX_TRADE_HISTORY = 500;

// Simulated trading fee: 0.08% of position size (Flash Trade typical)
const SIM_FEE_BPS = 8;

/**
 * SimulatedFlashClient implements IFlashClient for paper trading.
 * Uses CoinGecko prices as primary, fstats as enrichment. No hardcoded fallbacks.
 * No real transactions are ever submitted.
 */
export class SimulatedFlashClient implements IFlashClient {
  private state: SimulationState;
  private priceService: PriceService;
  private fstats: FStatsClient;
  private livePrices: Map<string, number> = new Map();
  private priceChanges24h: Map<string, number> = new Map();
  readonly walletAddress: string;

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

    // Primary: CoinGecko via PriceService
    try {
      const defaultSymbols = ['SOL', 'BTC', 'ETH', 'BNB', 'JUP', 'PYTH', 'RAY', 'BONK', 'WIF'];
      const symbols = this.livePrices.size > 0
        ? Array.from(this.livePrices.keys())
        : defaultSymbols;
      const prices = await this.priceService.getPrices(symbols);
      let updated = 0;
      for (const [sym, tp] of prices) {
        if (tp.price > 0) {
          this.livePrices.set(sym, tp.price);
          this.priceChanges24h.set(sym, tp.priceChange24h);
          updated++;
        }
      }
      if (updated > 0) {
        logger.debug('SIM', `Updated ${updated} prices from PriceService`);
      }
    } catch (error: unknown) {
      logger.warn('SIM', `PriceService failed: ${getErrorMessage(error)}`);
    }

    // Secondary: enrich with fstats open positions (may have additional markets)
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
        // Only use fstats price if we don't have a CoinGecko price or fstats is likely fresher
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

  private calcLiquidationPrice(entryPrice: number, leverage: number, side: TradeSide): number {
    if (!Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return 0;
    }
    const liqDistance = (1 / leverage) * 0.9;
    return side === TradeSide.Long
      ? entryPrice * (1 - liqDistance)
      : entryPrice * (1 + liqDistance);
  }

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<OpenPositionResult> {
    const logger = getLogger();
    await this.refreshPrices();

    // Validate
    const validation = validateTrade(market, side, collateralAmount, leverage, this.state.balance);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    const price = this.getPrice(market);
    const sizeUsd = collateralAmount * leverage;
    const liquidationPrice = this.calcLiquidationPrice(price, leverage, side);

    // Trading fee: 0.08% of position size
    const openFee = (sizeUsd * SIM_FEE_BPS) / 10_000;

    if (collateralAmount + openFee > this.state.balance) {
      throw new Error(`Insufficient balance for collateral + fee: need $${(collateralAmount + openFee).toFixed(2)}, have $${this.state.balance.toFixed(2)}`);
    }

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
    };

    this.state.balance -= collateralAmount + openFee;
    this.state.totalFeesPaid += openFee;
    this.state.positions.push(position);
    this.state.tradeHistory.push({
      id: position.id,
      action: 'open',
      market: position.market,
      side,
      sizeUsd,
      collateralUsd: collateralAmount,
      leverage,
      price,
      timestamp: Date.now(),
    });
    this.trimHistory();

    const txSig = `SIM_${position.id}`;
    logger.trade('OPEN', { market, side, collateral: collateralAmount, leverage, price, tx: txSig });

    return { txSignature: txSig, entryPrice: price, liquidationPrice, sizeUsd };
  }

  async closePosition(market: string, side: TradeSide): Promise<ClosePositionResult> {
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

    // Close fee: 0.08% of position size
    const closeFee = (position.sizeUsd * SIM_FEE_BPS) / 10_000;
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
      pnl,
      timestamp: Date.now(),
    });
    this.trimHistory();

    const txSig = `SIM_CLOSE_${position.id}`;
    logger.trade('CLOSE', { market, side, pnl, price, tx: txSig });

    return { txSignature: txSig, exitPrice: price, pnl };
  }

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
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
    return { txSignature: `SIM_ADD_${pos.id}`, newLeverage: pos.leverage };
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const pos = this.state.positions.find(
      (p) => p.market === market.toUpperCase() && p.side === side
    );
    if (!pos) throw new Error(`No open ${side} position on ${market}`);
    if (amount >= pos.collateralUsd) throw new Error('Cannot remove all collateral — close position instead');

    pos.collateralUsd -= amount;
    const newLev = pos.collateralUsd > 0 ? pos.sizeUsd / pos.collateralUsd : 0;
    pos.leverage = Number.isFinite(newLev) ? newLev : 0;
    this.state.balance += amount;

    getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, newLeverage: pos.leverage });
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
      const liquidationPrice = this.calcLiquidationPrice(p.entryPrice, p.leverage, p.side);

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
    };
  }

  getBalance(): number {
    return this.state.balance;
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

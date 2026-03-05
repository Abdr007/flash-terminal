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
import { FStatsClient } from '../data/fstats.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

/**
 * SimulatedFlashClient implements IFlashClient for paper trading.
 * Uses live price feeds from fstats.io open positions.
 * No real transactions are ever submitted.
 */
export class SimulatedFlashClient implements IFlashClient {
  private state: SimulationState;
  private fstats: FStatsClient;
  private livePrices: Map<string, number> = new Map();
  readonly walletAddress: string;

  constructor(initialBalance = 10_000) {
    this.walletAddress = `SIM_${randomUUID().slice(0, 8).toUpperCase()}`;
    this.state = {
      balance: initialBalance,
      positions: [],
      tradeHistory: [],
    };
    this.fstats = new FStatsClient();
  }

  private async refreshPrices(): Promise<void> {
    const logger = getLogger();
    try {
      const raw = await this.fstats.getOpenPositions();
      const positions = Array.isArray(raw) ? raw : [];
      const priceMap = new Map<string, number[]>();
      for (const p of positions) {
        const sym = p.market_symbol ?? p.market;
        const price = p.mark_price ?? p.entry_price;
        if (sym && price && typeof price === 'number' && price > 0) {
          if (!priceMap.has(sym)) priceMap.set(sym, []);
          priceMap.get(sym)!.push(price);
        }
      }
      for (const [sym, prices] of priceMap) {
        this.livePrices.set(sym, prices.reduce((a, b) => a + b, 0) / prices.length);
      }
      logger.debug('SIM', `Refreshed ${priceMap.size} market prices`);
    } catch (error: unknown) {
      logger.warn('SIM', `Price refresh failed: ${getErrorMessage(error)}`);
      // Seed fallback prices only if we have no data at all
      if (this.livePrices.size === 0) {
        this.livePrices.set('SOL', 140);
        this.livePrices.set('BTC', 95000);
        this.livePrices.set('ETH', 3200);
      }
    }
  }

  private getPrice(market: string): number {
    const price = this.livePrices.get(market.toUpperCase());
    if (!price || price <= 0) {
      throw new Error(`No price data for ${market}. Try again in a moment.`);
    }
    return price;
  }

  private calcLiquidationPrice(entryPrice: number, leverage: number, side: TradeSide): number {
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

    const position: SimulatedPosition = {
      id: randomUUID().slice(0, 8),
      market: market.toUpperCase(),
      side,
      entryPrice: price,
      sizeUsd,
      collateralUsd: collateralAmount,
      leverage,
      openedAt: Date.now(),
    };

    this.state.balance -= collateralAmount;
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

    this.state.balance += position.collateralUsd + pnl;
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
    pos.leverage = pos.sizeUsd / pos.collateralUsd;

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
    pos.leverage = pos.sizeUsd / pos.collateralUsd;
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
        sizeUsd: p.sizeUsd,
        collateralUsd: p.collateralUsd,
        leverage: p.leverage,
        unrealizedPnl,
        unrealizedPnlPercent: p.collateralUsd > 0 ? (unrealizedPnl / p.collateralUsd) * 100 : 0,
        liquidationPrice,
        timestamp: p.openedAt / 1000,
      };
    });
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    await this.refreshPrices();
    const symbols = market
      ? [market.toUpperCase()]
      : Array.from(this.livePrices.keys());

    return symbols
      .filter((s) => this.livePrices.has(s))
      .map((symbol) => ({
        symbol,
        price: this.livePrices.get(symbol)!,
        priceChange24h: 0,
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
}

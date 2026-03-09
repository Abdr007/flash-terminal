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

const MAX_TRADE_HISTORY = 500;
const MAX_LIVE_PRICE_ENTRIES = 100;

// Pyth Hermes price feed IDs for ALL Flash Trade markets.
// This is the PRIMARY price source — same oracle Flash Trade uses on-chain.
// Feed IDs sourced from hermes.pyth.network & Flash SDK PoolConfig.json pythPriceId.
const PYTH_HERMES_FEEDS: Record<string, string> = {
  // ── Crypto.1 ──
  SOL:      '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC:      '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH:      '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  ZEC:      '0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24',
  BNB:      '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  // ── Governance.1 ──
  JTO:      '0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
  JUP:      '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  PYTH:     '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
  RAY:      '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a',
  HYPE:     '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
  MET:      '0x0292e0f405bcd4a496d34e48307f6787349ad2bcd8505c3d3a9f77d81a67a682',
  KMNO:     '0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0',
  // ── Community.1 / Community.2 / Trump.1 / Ore.1 ──
  PUMP:     '0x7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9',
  BONK:     '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  PENGU:    '0xbed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61',
  WIF:      '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  FARTCOIN: '0x58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608',
  ORE:      '0x142b804c658e14ff60886783e46e5a51bdf398b4871d9d8f7c28aa1585cad504',
  // ── Virtual.1 (commodities, forex) ──
  XAU:      '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  XAG:      '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  CRUDEOIL: '0x6a60b0d1ea6809b47dbe599f24a71c8bda335aa5c77e503e7260cde5ba2f4694',
  EUR:      '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
  GBP:      '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1',
  USDJPY:   '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52',
  USDCNH:   '0xeef52e09c878ad41f6a81803e3640fe04dceea727de894edd4ea117e2e332e66',
};
const PYTH_HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

// Simulated trading fee: 0.08% of position size (Flash Trade typical)
const SIM_FEE_BPS = 8;

/**
 * SimulatedFlashClient implements IFlashClient for paper trading.
 * Uses Pyth Hermes as primary price source (same oracle as Flash Trade on-chain).
 * CoinGecko is secondary — used only for 24h change % stats.
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

    // Bound livePrices map to prevent unbounded growth during long sessions
    if (this.livePrices.size > MAX_LIVE_PRICE_ENTRIES) {
      const excess = Array.from(this.livePrices.keys()).slice(0, 20);
      for (const k of excess) {
        this.livePrices.delete(k);
        this.priceChanges24h.delete(k);
      }
    }

    // ── PRIMARY: Pyth Hermes — same oracle Flash Trade uses on-chain ──
    // Real-time (~400ms), free, no API key, no rate limits, covers ALL 25 markets
    try {
      const allFeeds = Object.entries(PYTH_HERMES_FEEDS);
      const idsParam = allFeeds.map(([, id]) => `ids[]=${id}`).join('&');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const resp = await fetch(`${PYTH_HERMES_URL}?${idsParam}&parsed=true`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json() as { parsed?: Array<{ id: string; price: { price: string; expo: number } }> };
        const feedToSymbol = new Map(allFeeds.map(([sym, id]) => [id.replace('0x', ''), sym]));
        let updated = 0;
        for (const item of data.parsed ?? []) {
          const sym = feedToSymbol.get(item.id);
          if (sym && item.price) {
            const price = Number(item.price.price) * Math.pow(10, item.price.expo);
            if (price > 0 && Number.isFinite(price)) {
              this.livePrices.set(sym, price);
              updated++;
            }
          }
        }
        logger.debug('SIM', `Pyth Hermes: updated ${updated}/${allFeeds.length} prices`);
      }
    } catch (error: unknown) {
      logger.info('SIM', `Pyth Hermes fetch failed: ${getErrorMessage(error)}`);
    }

    // ── SECONDARY: CoinGecko — only for 24h change % (supplementary stats) ──
    try {
      const defaultSymbols = ['SOL', 'BTC', 'ETH', 'BNB', 'JUP', 'PYTH', 'RAY', 'BONK', 'WIF'];
      const symbols = this.livePrices.size > 0
        ? Array.from(this.livePrices.keys())
        : defaultSymbols;
      const prices = await this.priceService.getPrices(symbols);
      for (const [sym, tp] of prices) {
        // Only take 24h change stats — Pyth Hermes prices are authoritative
        if (tp.priceChange24h !== 0) {
          this.priceChanges24h.set(sym, tp.priceChange24h);
        }
        // Fallback: if Pyth missed a market, use CoinGecko price
        if ((!this.livePrices.has(sym) || this.livePrices.get(sym) === 0) && tp.price > 0) {
          this.livePrices.set(sym, tp.price);
        }
      }
    } catch (error: unknown) {
      logger.debug('SIM', `CoinGecko stats fetch failed: ${getErrorMessage(error)}`);
    }

    // ── TERTIARY: fstats — fallback for any remaining gaps ──
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
   * Calculate liquidation price using the same formula structure as the Flash Trade protocol.
   *
   * Protocol formula:
   *   exitFee = sizeUsd × closeFeeBps / RATE_POWER
   *   maintenanceMargin = sizeUsd × BPS_POWER / maxLeverage
   *   liabilities = maintenanceMargin + exitFee
   *   priceDist = (collateral - liabilities) / sizeUsd × entryPrice
   *
   * In simulation we approximate with:
   *   closeFeeBps = 0.08% (8/10000)
   *   maxLeverage = 100x → maintenanceMargin = 1% of size
   */
  private calcLiquidationPrice(entryPrice: number, leverage: number, side: TradeSide): number {
    if (!Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return 0;
    }
    // Simulate the protocol's liability calculation
    const collateralRatio = 1 / leverage;                  // collateral / size
    const maintenanceMarginRatio = 1 / 100;                // sizeUsd / maxLeverage (100x)
    const closeFeeRatio = 8 / 10_000;                      // 0.08% close fee
    const liabilityRatio = maintenanceMarginRatio + closeFeeRatio; // ~1.08%
    const priceDist = (collateralRatio - liabilityRatio) * entryPrice;

    if (priceDist <= 0) {
      // Collateral doesn't cover liabilities — position at immediate risk
      return side === TradeSide.Long ? entryPrice : entryPrice;
    }

    return side === TradeSide.Long
      ? entryPrice - priceDist
      : entryPrice + priceDist;
  }

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
  ): Promise<OpenPositionResult> {
    const logger = getLogger();
    await this.refreshPrices();

    // Reject duplicate positions (same market + side) — matches Flash Trade protocol
    const existing = this.state.positions.find(
      p => p.market === market.toUpperCase() && p.side === side,
    );
    if (existing) {
      throw new Error(`Already have an open ${side} position on ${market}. Close it first or adjust collateral.`);
    }

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
    const liquidationPrice = this.calcLiquidationPrice(price, leverage, side);

    // Reject positions where liquidation price equals entry (instant liquidation)
    if (liquidationPrice === price || liquidationPrice <= 0) {
      throw new Error(`Leverage ${leverage}x is too high — position would be immediately liquidated. Reduce leverage.`);
    }

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
    return { txSignature: `SIM_ADD_${pos.id}`, newLeverage: pos.leverage };
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Collateral amount must be a positive number');
    }
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
      const newLiqPrice = this.calcLiquidationPrice(pos.entryPrice, newLev, side);
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
    const liqPrice = this.calcLiquidationPrice(price, leverage, side);
    const fee = (sizeUsd * SIM_FEE_BPS) / 10_000;

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

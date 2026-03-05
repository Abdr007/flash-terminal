import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import {
  PerpetualsClient,
  PoolConfig,
  CustodyAccount,
  Side,
  Privilege,
  Token,
  uiDecimalsToNative,
  BN_ZERO,
} from 'flash-sdk';
import { readFileSync, existsSync } from 'fs';
import {
  Position,
  TradeSide,
  FlashConfig,
  MarketData,
  Portfolio,
  IFlashClient,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
} from '../types/index.js';
import { PriceService, TokenPrice } from '../data/prices.js';
import { getPoolForMarket } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

function toSdkSide(side: TradeSide): typeof Side.Long | typeof Side.Short {
  return side === TradeSide.Long ? Side.Long : Side.Short;
}

export class FlashClient implements IFlashClient {
  private connection: Connection;
  private wallet: Keypair;
  private provider: AnchorProvider;
  private perpClient: PerpetualsClient;
  private poolConfig: PoolConfig;
  private priceService: PriceService;
  private config: FlashConfig;
  private altCache: AddressLookupTableAccount[] | null = null;
  private solBalance = 0;

  constructor(config: FlashConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, { commitment: 'processed' });

    // Load wallet with error handling
    if (!existsSync(config.walletPath)) {
      throw new Error(
        `Wallet file not found: ${config.walletPath}\n` +
        `Run 'solana-keygen new' to create one, or set WALLET_PATH in .env`
      );
    }

    let secretKeyData: unknown;
    try {
      secretKeyData = JSON.parse(readFileSync(config.walletPath, 'utf-8'));
    } catch {
      throw new Error(`Invalid wallet file at ${config.walletPath} — must be a JSON array of numbers`);
    }

    if (!Array.isArray(secretKeyData) || secretKeyData.length !== 64) {
      throw new Error(`Wallet file must contain a 64-byte secret key array`);
    }

    this.wallet = Keypair.fromSecretKey(Uint8Array.from(secretKeyData as number[]));

    const walletAdapter = new Wallet(this.wallet);
    this.provider = new AnchorProvider(this.connection, walletAdapter, {
      commitment: 'processed',
      preflightCommitment: 'processed',
    });

    try {
      this.poolConfig = PoolConfig.fromIdsByName(config.defaultPool, config.network);
    } catch {
      throw new Error(
        `Unknown pool: ${config.defaultPool}. ` +
        `Valid pools: Crypto.1, Virtual.1, Governance.1, Community.1, Community.2, Trump.1, Ore.1, Remora.1`
      );
    }

    this.perpClient = new PerpetualsClient(
      this.provider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: 0 }
    );

    this.priceService = new PriceService(config.pythnetUrl);
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  // ─── Pool Management ─────────────────────────────────────────────────────

  private getPoolConfigForMarket(market: string): PoolConfig {
    const poolName = getPoolForMarket(market);
    if (!poolName) throw new Error(`Unknown market: ${market}`);
    if (poolName !== this.poolConfig.poolName) {
      return PoolConfig.fromIdsByName(poolName, this.config.network);
    }
    return this.poolConfig;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getPriceMap(poolConfig: PoolConfig): Promise<Map<string, TokenPrice>> {
    const tokens = (poolConfig.tokens as Array<{ symbol: string; pythTicker: string }>).map((t) => ({
      symbol: t.symbol,
      pythTicker: t.pythTicker,
    }));
    return this.priceService.getPrices(tokens);
  }

  private async getALTs(poolConfig: PoolConfig): Promise<AddressLookupTableAccount[]> {
    if (this.altCache && poolConfig === this.poolConfig) return this.altCache;
    const result = await this.perpClient.getOrLoadAddressLookupTable(poolConfig);
    const tables = result.addressLookupTables;
    if (poolConfig === this.poolConfig) this.altCache = tables;
    return tables;
  }

  private findToken(poolConfig: PoolConfig, symbol: string) {
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey; decimals: number; pythTicker: string }>;
    const token = tokens.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`Token ${symbol} not found in pool`);
    return token;
  }

  private findCustody(poolConfig: PoolConfig, symbol: string) {
    const custodies = poolConfig.custodies as Array<{ symbol: string; custodyAccount: PublicKey }>;
    const custody = custodies.find((c) => c.symbol === symbol);
    if (!custody) throw new Error(`Custody for ${symbol} not found`);
    return custody;
  }

  private async findUserPosition(
    poolConfig: PoolConfig,
    market: string,
    side: TradeSide
  ): Promise<{ position: { pubkey: PublicKey; market: PublicKey }; marketConfig: { marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short } }> {
    const sdkSide = toSdkSide(side);
    const positions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    const token = this.findToken(poolConfig, market);
    const markets = poolConfig.markets as unknown as Array<{ marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short }>;

    const marketConfig = markets.find(
      (m) => m.targetMint.equals(token.mintKey) && m.side === sdkSide
    );
    if (!marketConfig) throw new Error(`Market config for ${market} ${side} not found`);

    const position = (positions as Array<{ pubkey: PublicKey; market: PublicKey }>).find(
      (p) => p.market.equals(marketConfig.marketAccount)
    );
    if (!position) throw new Error(`No open ${side} position on ${market}`);

    return { position, marketConfig };
  }

  private async sendTx(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    poolConfig: PoolConfig
  ): Promise<string> {
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });
    const alts = await this.getALTs(poolConfig);

    return this.perpClient.sendTransaction([cuLimitIx, cuPriceIx, ...instructions], {
      alts,
      additionalSigners,
    });
  }

  // ─── Open Position ────────────────────────────────────────────────────────

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string
  ): Promise<OpenPositionResult> {
    const logger = getLogger();
    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);

    const targetToken = this.findToken(poolConfig, market);
    const inputToken = collateralToken
      ? this.findToken(poolConfig, collateralToken)
      : targetToken;

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    const inputPrice = priceMap.get(inputToken.symbol);
    if (!targetPrice || !inputPrice) throw new Error('Could not fetch prices');

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide
    );

    const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
    const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
    const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

    const custodyAccounts = await this.perpClient.program.account.custody.fetchMultiple([
      inputCustody.custodyAccount, outputCustody.custodyAccount,
    ]);

    if (!custodyAccounts[0] || !custodyAccounts[1]) {
      throw new Error('Failed to fetch custody accounts from chain');
    }

    const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
      collateralNative, leverage.toString(), targetToken as unknown as Token, inputToken as unknown as Token, sdkSide,
      targetPrice.price, targetPrice.emaPrice,
      CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
      inputPrice.price, inputPrice.emaPrice,
      CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
      BN_ZERO
    );

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (inputToken.symbol === targetToken.symbol) {
      result = await this.perpClient.openPosition(
        targetToken.symbol, inputToken.symbol, priceAfterSlippage,
        collateralNative, sizeAmount, sdkSide, poolConfig, Privilege.None
      );
    } else {
      result = await this.perpClient.swapAndOpen(
        targetToken.symbol, targetToken.symbol, inputToken.symbol,
        collateralNative, priceAfterSlippage, sizeAmount, sdkSide,
        poolConfig, Privilege.None
      );
    }

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade('OPEN', {
      market, side, collateral: collateralAmount, leverage,
      price: targetPrice.uiPrice, tx: txSignature,
    });

    return {
      txSignature,
      entryPrice: targetPrice.uiPrice,
      liquidationPrice: 0, // TODO: call getLiquidationPriceView post-open
      sizeUsd: collateralAmount * leverage,
    };
  }

  // ─── Close Position ───────────────────────────────────────────────────────

  async closePosition(market: string, side: TradeSide, receiveToken?: string): Promise<ClosePositionResult> {
    const logger = getLogger();
    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);

    const targetToken = this.findToken(poolConfig, market);
    const receivingToken = receiveToken ? this.findToken(poolConfig, receiveToken) : targetToken;

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    if (!targetPrice) throw new Error('Could not fetch price');

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      false, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide
    );

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (receivingToken.symbol === targetToken.symbol) {
      result = await this.perpClient.closePosition(
        targetToken.symbol, receivingToken.symbol, priceAfterSlippage,
        sdkSide, poolConfig, Privilege.None
      );
    } else {
      result = await this.perpClient.closeAndSwap(
        targetToken.symbol, receivingToken.symbol, targetToken.symbol,
        priceAfterSlippage, sdkSide, poolConfig, Privilege.None
      );
    }

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade('CLOSE', { market, side, price: targetPrice.uiPrice, tx: txSignature });
    return { txSignature, exitPrice: targetPrice.uiPrice, pnl: 0 };
  }

  // ─── Collateral Management ────────────────────────────────────────────────

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const poolConfig = this.getPoolConfigForMarket(market);
    const token = this.findToken(poolConfig, market);
    const amountNative = uiDecimalsToNative(amount.toString(), token.decimals);
    const { position } = await this.findUserPosition(poolConfig, market, side);

    const result = await this.perpClient.addCollateral(
      amountNative, market, token.symbol, toSdkSide(side), position.pubkey, poolConfig
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
    getLogger().trade('ADD_COLLATERAL', { market, side, amount, tx: txSignature });
    return { txSignature };
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const poolConfig = this.getPoolConfigForMarket(market);
    const token = this.findToken(poolConfig, market);
    const amountNative = uiDecimalsToNative(amount.toString(), token.decimals);
    const { position } = await this.findUserPosition(poolConfig, market, side);

    const result = await this.perpClient.removeCollateral(
      amountNative, market, token.symbol, toSdkSide(side), position.pubkey, poolConfig
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
    getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, tx: txSignature });
    return { txSignature };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const rawPositions = await this.perpClient.getUserPositions(this.wallet.publicKey, this.poolConfig);
    if (rawPositions.length === 0) return [];

    const priceMap = await this.getPriceMap(this.poolConfig);
    const positions: Position[] = [];
    const markets = this.poolConfig.markets as unknown as Array<{
      marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey;
      side: typeof Side.Long | typeof Side.Short;
    }>;
    const tokens = this.poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey }>;

    for (const raw of rawPositions as Array<{
      pubkey: PublicKey; market: PublicKey;
      entryPrice?: BN; sizeUsd?: BN; collateralUsd?: BN; openTime?: BN;
    }>) {
      try {
        const marketConfig = markets.find((m) => m.marketAccount.equals(raw.market));
        if (!marketConfig) continue;

        const targetToken = tokens.find((t) => t.mintKey.equals(marketConfig.targetMint));
        if (!targetToken) continue;

        const tokenPrice = priceMap.get(targetToken.symbol);
        if (!tokenPrice) continue;

        const entryPrice = raw.entryPrice ? parseFloat(raw.entryPrice.toString()) / 1e6 : 0;
        const sizeUsd = raw.sizeUsd ? parseFloat(raw.sizeUsd.toString()) / 1e6 : 0;
        const collateralUsd = raw.collateralUsd ? parseFloat(raw.collateralUsd.toString()) / 1e6 : 0;
        const currentPrice = tokenPrice.uiPrice;
        const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;
        const side = marketConfig.side === Side.Long ? TradeSide.Long : TradeSide.Short;
        const priceDelta = currentPrice - entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        const unrealizedPnl = entryPrice > 0 ? (priceDelta / entryPrice) * sizeUsd * pnlMult : 0;

        // Approximate liquidation price
        const liqDist = leverage > 0 ? (1 / leverage) * 0.9 : 0;
        const liquidationPrice = side === TradeSide.Long
          ? entryPrice * (1 - liqDist)
          : entryPrice * (1 + liqDist);

        positions.push({
          pubkey: raw.pubkey.toBase58(),
          market: targetToken.symbol,
          side,
          entryPrice,
          currentPrice,
          sizeUsd,
          collateralUsd,
          leverage,
          unrealizedPnl,
          unrealizedPnlPercent: collateralUsd > 0 ? (unrealizedPnl / collateralUsd) * 100 : 0,
          liquidationPrice,
          timestamp: raw.openTime ? Number(raw.openTime.toString()) : Date.now() / 1000,
        });
      } catch (error: unknown) {
        getLogger().warn('CLIENT', `Failed to parse position: ${getErrorMessage(error)}`);
      }
    }

    return positions;
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    const priceMap = await this.getPriceMap(this.poolConfig);
    const tokens = this.poolConfig.tokens as Array<{ symbol: string }>;

    return tokens
      .filter((t) => !market || t.symbol === market)
      .filter((t) => priceMap.has(t.symbol))
      .map((token) => {
        const tp = priceMap.get(token.symbol)!;
        return {
          symbol: token.symbol,
          price: tp.uiPrice,
          priceChange24h: 0,
          openInterestLong: 0,
          openInterestShort: 0,
          maxLeverage: 100,
          fundingRate: 0,
        };
      });
  }

  async getPortfolio(): Promise<Portfolio> {
    const [solBalance, positions] = await Promise.all([
      this.connection.getBalance(this.wallet.publicKey),
      this.getPositions(),
    ]);

    const solBal = solBalance / 1e9;
    return {
      walletAddress: this.wallet.publicKey.toBase58(),
      balance: solBal,
      balanceLabel: `SOL Balance: ${solBal.toFixed(4)} SOL`,
      totalCollateralUsd: positions.reduce((s, p) => s + p.collateralUsd, 0),
      totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      positions,
      totalPositionValue: positions.reduce((s, p) => s + p.sizeUsd, 0),
    };
  }

  getBalance(): number {
    return this.solBalance;
  }
}

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  PerpetualsClient,
  PoolConfig,
  CustodyAccount,
  Side,
  Privilege,
  Token,
  uiDecimalsToNative,
  BN_ZERO,
  OraclePrice,
} from 'flash-sdk';
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
  getLeverageLimits,
} from '../types/index.js';
import { PythHttpClient, getPythProgramKeyForCluster, PriceData } from '@pythnetwork/client';
import { getPoolForMarket } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage, withRetry } from '../utils/retry.js';
import type { WalletManager } from '../wallet/walletManager.js';

// ─── Pyth Price Service ──────────────────────────────────────────────────────

interface LiveTokenPrice {
  price: OraclePrice;
  emaPrice: OraclePrice;
  uiPrice: number;
  timestamp: number;
}

class PythPriceService {
  private pythClient: PythHttpClient;
  private cache: Map<string, { data: LiveTokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000;

  constructor(pythnetUrl: string) {
    // Validate Pythnet URL: must be HTTPS (or localhost for dev)
    try {
      const parsed = new URL(pythnetUrl);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        throw new Error(`Pythnet URL must use HTTPS: ${pythnetUrl}`);
      }
      if (parsed.username || parsed.password) {
        throw new Error('Pythnet URL must not contain embedded credentials');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Pythnet')) throw e;
      throw new Error(`Invalid Pythnet URL: ${pythnetUrl}`);
    }
    const conn = new Connection(pythnetUrl);
    this.pythClient = new PythHttpClient(conn, getPythProgramKeyForCluster('pythnet'));
  }

  async getPrices(tokens: { symbol: string; pythTicker: string }[]): Promise<Map<string, LiveTokenPrice>> {
    const priceMap = new Map<string, LiveTokenPrice>();
    const now = Date.now();
    const logger = getLogger();
    const uncached: typeof tokens = [];

    for (const token of tokens) {
      const cached = this.cache.get(token.symbol);
      if (cached && cached.expiry > now) {
        priceMap.set(token.symbol, cached.data);
      } else {
        uncached.push(token);
      }
    }

    if (uncached.length === 0) return priceMap;

    const pythData = await withRetry(() => this.pythClient.getData(), 'pyth-prices', { maxAttempts: 2 });

    for (const token of uncached) {
      const priceData: PriceData | undefined = pythData.productPrice.get(token.pythTicker);
      if (!priceData) {
        logger.warn('PRICE', `No Pyth data for ${token.symbol} (${token.pythTicker})`);
        continue;
      }

      const priceComponent = priceData.aggregate.priceComponent;
      const emaPriceComponent = priceData.emaPrice.valueComponent;
      // confidence from Pyth can be a float — convert to integer at the oracle's exponent scale
      const rawConfidence = priceData.confidence ?? 0;
      const confidenceInt = typeof rawConfidence === 'number'
        ? Math.round(rawConfidence * Math.pow(10, Math.abs(priceData.exponent)))
        : rawConfidence;
      const rawEmaConfidence = priceData.emaConfidence?.valueComponent ?? 0;

      const price = new OraclePrice({
        price: new BN(priceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(confidenceInt.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const emaPrice = new OraclePrice({
        price: new BN(emaPriceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(rawEmaConfidence.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const tokenPrice: LiveTokenPrice = {
        price,
        emaPrice,
        uiPrice: priceData.aggregate.price ?? 0,
        timestamp: priceData.timestamp ? Number(priceData.timestamp) * 1000 : now,
      };

      priceMap.set(token.symbol, tokenPrice);
      this.cache.set(token.symbol, { data: tokenPrice, expiry: now + this.cacheTtlMs });
    }

    return priceMap;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSdkSide(side: TradeSide): typeof Side.Long | typeof Side.Short {
  return side === TradeSide.Long ? Side.Long : Side.Short;
}

// Minimum SOL balance required to cover transaction fees
const MIN_SOL_FOR_FEES = 0.01;

// Flash perpetual pools use USDC as the default collateral token
const DEFAULT_COLLATERAL_TOKEN = 'USDC';

// Well-known USDC mint on Solana mainnet
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// ─── FlashClient ─────────────────────────────────────────────────────────────

export class FlashClient implements IFlashClient {
  private connection: Connection;
  private wallet: Keypair;
  private provider: AnchorProvider;
  private perpClient: PerpetualsClient;
  private poolConfig: PoolConfig;
  private priceService: PythPriceService;
  private config: FlashConfig;
  private walletMgr: WalletManager;
  private altCache: AddressLookupTableAccount[] | null = null;
  private cachedSolBalance = 0;

  constructor(connection: Connection, walletManager: WalletManager, config: FlashConfig) {
    this.config = config;
    this.connection = connection;
    this.walletMgr = walletManager;

    const keypair = walletManager.getKeypair();
    if (!keypair) {
      throw new Error('No wallet connected. Use "wallet connect <path>" or ensure ~/.config/solana/id.json exists.');
    }
    this.wallet = keypair;

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

    this.priceService = new PythPriceService(config.pythnetUrl);
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  // ─── Pre-Trade Validation ─────────────────────────────────────────────────

  private async ensureSufficientSol(): Promise<void> {
    const lamports = await withRetry(
      () => this.connection.getBalance(this.wallet.publicKey),
      'sol-balance-check',
      { maxAttempts: 2 },
    );
    this.cachedSolBalance = lamports / LAMPORTS_PER_SOL;
    if (this.cachedSolBalance < MIN_SOL_FOR_FEES) {
      throw new Error(
        `Insufficient SOL for transaction fees. Balance: ${this.cachedSolBalance.toFixed(4)} SOL. ` +
        `Minimum required: ${MIN_SOL_FOR_FEES} SOL.`
      );
    }
  }

  private validateLeverage(market: string, leverage: number): void {
    const limits = getLeverageLimits(market);
    if (leverage < limits.min) {
      throw new Error(`Minimum leverage for ${market}: ${limits.min}x`);
    }
    if (leverage > limits.max) {
      throw new Error(`Maximum leverage for ${market}: ${limits.max}x`);
    }
  }

  // ─── Pool Management ──────────────────────────────────────────────────────

  private getPoolConfigForMarket(market: string): PoolConfig {
    const poolName = getPoolForMarket(market);
    if (!poolName) throw new Error(`Unknown market: ${market}`);
    if (poolName !== this.poolConfig.poolName) {
      return PoolConfig.fromIdsByName(poolName, this.config.network);
    }
    return this.poolConfig;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getPriceMap(poolConfig: PoolConfig): Promise<Map<string, LiveTokenPrice>> {
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
  ): Promise<{
    position: { pubkey: PublicKey; market: PublicKey };
    marketConfig: { marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short };
  }> {
    const sdkSide = toSdkSide(side);
    const positions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    const token = this.findToken(poolConfig, market);
    const markets = poolConfig.markets as unknown as Array<{
      marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short;
    }>;

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

    const signature = await this.perpClient.sendTransaction([cuLimitIx, cuPriceIx, ...instructions], {
      alts,
      additionalSigners,
    });

    // Confirm transaction on-chain (retry once — tx may already be in-flight)
    const logger = getLogger();
    try {
      const latestBlockhash = await withRetry(
        () => this.connection.getLatestBlockhash(),
        'get-blockhash',
        { maxAttempts: 2 },
      );
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        logger.error('CLIENT', `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        throw new Error(`Transaction failed on-chain (${signature}): ${JSON.stringify(confirmation.value.err)}`);
      }
    } catch (error: unknown) {
      // Re-throw ALL confirmation failures — never report unconfirmed tx as successful
      const msg = getErrorMessage(error);
      logger.error('CLIENT', `Transaction confirmation failed: ${msg}`);
      throw new Error(`Transaction sent (${signature}) but confirmation failed: ${msg}. Check "positions" to verify status.`);
    }

    return signature;
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

    // Pre-trade validation
    await this.ensureSufficientSol();
    this.validateLeverage(market, leverage);

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);

    const targetToken = this.findToken(poolConfig, market);
    const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
    const inputToken = this.findToken(poolConfig, collateralSymbol);

    logger.debug('TRADE', 'Trade Request', {
      market, side, collateralToken: inputToken.symbol,
      collateralAmount, leverage, size: collateralAmount * leverage,
    });

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    const inputPrice = priceMap.get(inputToken.symbol);
    if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);
    if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}. Try again later.`);

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide
    );

    const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
    const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
    const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

    const custodyAccounts = await withRetry(
      () => this.perpClient.program.account.custody.fetchMultiple([
        inputCustody.custodyAccount, outputCustody.custodyAccount,
      ]),
      'custody-fetch',
      { maxAttempts: 2 },
    );

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
      liquidationPrice: 0,
      sizeUsd: collateralAmount * leverage,
    };
  }

  // ─── Close Position ───────────────────────────────────────────────────────

  async closePosition(market: string, side: TradeSide, receiveToken?: string): Promise<ClosePositionResult> {
    const logger = getLogger();

    await this.ensureSufficientSol();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);

    const targetToken = this.findToken(poolConfig, market);
    const receivingToken = receiveToken
      ? this.findToken(poolConfig, receiveToken)
      : this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);

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
    await this.ensureSufficientSol();

    const poolConfig = this.getPoolConfigForMarket(market);
    const token = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
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
    await this.ensureSufficientSol();

    const poolConfig = this.getPoolConfigForMarket(market);
    const token = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
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

    for (const raw of rawPositions as unknown as Array<{
      pubkey: PublicKey; market: PublicKey;
      entryPrice?: { price: BN; exponent: number } | BN; sizeUsd?: BN; collateralUsd?: BN; openTime?: BN;
      sizeDecimals?: number; collateralDecimals?: number;
    }>) {
      try {
        const marketConfig = markets.find((m) => m.marketAccount.equals(raw.market));
        if (!marketConfig) continue;

        const targetToken = tokens.find((t) => t.mintKey.equals(marketConfig.targetMint));
        if (!targetToken) continue;

        const tokenPrice = priceMap.get(targetToken.symbol);
        if (!tokenPrice) continue;

        // Entry price is a ContractOraclePrice { price: BN, exponent: number }
        // Compute: price * 10^exponent (exponent is typically negative, e.g. -8)
        const rawEntryField = raw.entryPrice;
        let parsedEntry = 0;
        if (rawEntryField && typeof rawEntryField === 'object' && 'price' in rawEntryField && 'exponent' in rawEntryField) {
          parsedEntry = parseFloat(rawEntryField.price.toString()) * Math.pow(10, rawEntryField.exponent);
        } else if (rawEntryField && BN.isBN(rawEntryField)) {
          // Fallback: bare BN — use oracle exponent from the current price
          const oracleExp = Number(tokenPrice.price.exponent.toString());
          parsedEntry = parseFloat(rawEntryField.toString()) * Math.pow(10, oracleExp);
        }

        // sizeUsd and collateralUsd use their respective decimal fields (default to 6 for USDC precision)
        const sizeDec = raw.sizeDecimals ?? 6;
        const collDec = raw.collateralDecimals ?? 6;
        const parsedSize = raw.sizeUsd ? parseFloat(raw.sizeUsd.toString()) / Math.pow(10, sizeDec) : 0;
        const parsedCollateral = raw.collateralUsd ? parseFloat(raw.collateralUsd.toString()) / Math.pow(10, collDec) : 0;
        const parsedCurrentPrice = tokenPrice.uiPrice;

        // NaN/Infinity guard: skip corrupt positions
        const entryPrice = Number.isFinite(parsedEntry) ? parsedEntry : 0;
        const sizeUsd = Number.isFinite(parsedSize) ? parsedSize : 0;
        const collateralUsd = Number.isFinite(parsedCollateral) ? parsedCollateral : 0;
        const currentPrice = Number.isFinite(parsedCurrentPrice) ? parsedCurrentPrice : 0;

        if (entryPrice <= 0 || sizeUsd <= 0 || collateralUsd <= 0) {
          getLogger().warn('CLIENT', `Skipping position with invalid values: entry=${entryPrice} size=${sizeUsd} collateral=${collateralUsd}`);
          continue;
        }

        const leverage = sizeUsd / collateralUsd;
        const side = marketConfig.side === Side.Long ? TradeSide.Long : TradeSide.Short;
        const priceDelta = currentPrice - entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        const unrealizedPnl = (priceDelta / entryPrice) * sizeUsd * pnlMult;
        const safeUnrealizedPnl = Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0;

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
          unrealizedPnl: safeUnrealizedPnl,
          unrealizedPnlPercent: (safeUnrealizedPnl / collateralUsd) * 100,
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
    const [solBalance, usdcBalance, positions] = await withRetry(
      () => Promise.all([
        this.connection.getBalance(this.wallet.publicKey),
        this.getUsdcBalance(),
        this.getPositions(),
      ]),
      'portfolio-fetch',
      { maxAttempts: 2 },
    );

    const solBal = solBalance / LAMPORTS_PER_SOL;
    this.cachedSolBalance = solBal;

    return {
      walletAddress: this.wallet.publicKey.toBase58(),
      balance: solBal,
      balanceLabel: `SOL: ${solBal.toFixed(4)} | USDC: ${usdcBalance.toFixed(2)}`,
      totalCollateralUsd: positions.reduce((s, p) => s + p.collateralUsd, 0),
      totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      positions,
      totalPositionValue: positions.reduce((s, p) => s + p.sizeUsd, 0),
      usdcBalance,
    };
  }

  private async getUsdcBalance(): Promise<number> {
    try {
      const accounts = await withRetry(
        () => this.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey,
          { mint: USDC_MINT }
        ),
        'usdc-balance',
        { maxAttempts: 2 },
      );
      if (accounts.value.length === 0) return 0;
      const info = accounts.value[0].account.data.parsed?.info;
      return info?.tokenAmount?.uiAmount ?? 0;
    } catch (error: unknown) {
      getLogger().warn('CLIENT', `USDC balance fetch failed: ${getErrorMessage(error)}`);
      return 0;
    }
  }

  getBalance(): number {
    return this.cachedSolBalance;
  }
}

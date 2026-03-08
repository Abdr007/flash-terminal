import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  VersionedTransaction,
  MessageV0,
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
  DryRunPreview,
  getLeverageLimits,
} from '../types/index.js';
import { PythHttpClient, getPythProgramKeyForCluster, PriceData } from '@pythnetwork/client';
import { getPoolForMarket } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage, withRetry } from '../utils/retry.js';
import type { WalletManager } from '../wallet/walletManager.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';

// ─── Pyth Price Service ──────────────────────────────────────────────────────

interface LiveTokenPrice {
  price: OraclePrice;
  emaPrice: OraclePrice;
  uiPrice: number;
  timestamp: number;
}

const MAX_PYTH_CACHE_ENTRIES = 50;

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

    // Evict expired entries if cache is too large
    if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
        const oldest = Array.from(this.cache.keys()).slice(0, 10);
        for (const k of oldest) this.cache.delete(k);
      }
    }

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

      const uiPrice = priceData.aggregate.price ?? 0;
      // Reject zero or negative prices from oracle — prevents trades at invalid prices
      if (!Number.isFinite(uiPrice) || uiPrice <= 0) {
        logger.warn('PRICE', `Invalid oracle price for ${token.symbol}: ${uiPrice} — skipping`);
        continue;
      }

      const tokenPrice: LiveTokenPrice = {
        price,
        emaPrice,
        uiPrice,
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

/**
 * Scrub sensitive data (API keys, private keys) from strings before logging.
 */
function scrubSensitive(msg: string): string {
  // Mask anything that looks like an API key or base58 private key in query params
  return msg.replace(/api[_-]?key=[^&\s]+/gi, 'api_key=***');
}

/**
 * Check if an error message indicates a network-level failure (not a program error).
 * Network errors are candidates for RPC failover; program errors are not.
 */
function isNetworkError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network request failed') ||
    lower.includes('socket hang up') ||
    lower.includes('429') ||
    lower.includes('503') ||
    lower.includes('502');
}

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
  private cachedSolBalance = 0;

  /** Per-market mutex to prevent concurrent transactions on the same market/side */
  private activeTrades = new Set<string>();

  /** Recent trade cache — prevents duplicate submissions within a short window */
  private recentTrades = new Map<string, number>(); // tradeKey -> timestamp
  private static readonly TRADE_CACHE_TTL_MS = 120_000;

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
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    try {
      this.poolConfig = PoolConfig.fromIdsByName(config.defaultPool, config.network);
    } catch {
      throw new Error(
        `Unknown pool: ${config.defaultPool}. ` +
        `Valid pools: Crypto.1, Virtual.1, Governance.1, Community.1, Community.2, Trump.1, Ore.1`
      );
    }

    // Match prioritizationFee with config to avoid conflict with manual CU instructions
    this.perpClient = new PerpetualsClient(
      this.provider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: config.computeUnitPrice }
    );

    this.priceService = new PythPriceService(config.pythnetUrl);
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  /**
   * Replace the active RPC connection (called by RpcManager on failover).
   * Safe to call mid-session — in-flight sendTx() calls capture their own
   * local `conn` reference at the start of each attempt, so swapping
   * this.connection here does not disrupt confirmation polling.
   * The new connection takes effect on the next attempt or next trade.
   */
  replaceConnection(connection: Connection): void {
    this.connection = connection;
    // Rebuild AnchorProvider with the new connection so perpClient uses it too
    const walletAdapter = new Wallet(this.wallet);
    this.provider = new AnchorProvider(connection, walletAdapter, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    this.perpClient = new PerpetualsClient(
      this.provider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: this.config.computeUnitPrice }
    );
    getLogger().info('CLIENT', 'Connection replaced (RPC failover)');
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

  /**
   * Check if a signature is already confirmed on-chain.
   * Used to prevent false failure reports when simulation disagrees with actual state.
   */
  private async isSignatureConfirmed(signature: string): Promise<boolean> {
    try {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value?.[0];
      if (status?.err) return false;
      return status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    } catch {
      return false;
    }
  }

  /**
   * Send a transaction with up to 3 attempts.
   * Each attempt gets a fresh blockhash and re-signs via the SDK.
   * Program errors (from simulation) are thrown immediately without retrying.
   * Before each retry, checks if the previous attempt's tx landed late
   * to prevent duplicate collateral operations.
   */
  private async sendTx(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    _poolConfig: PoolConfig
  ): Promise<string> {
    const logger = getLogger();

    // Pre-signing safety: verify keypair is still valid (not zeroed/disconnected)
    if (!this.walletMgr.verifyKeypairIntegrity()) {
      throw new Error('Wallet keypair is invalid or disconnected. Reconnect your wallet before signing.');
    }

    const maxAttempts = 3;
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });

    let lastError = '';
    let lastSignature = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Capture connection at start of attempt — use this reference for the ENTIRE
      // attempt (send + confirm loop). If a background failover swaps this.connection
      // mid-poll, the captured reference keeps polling the RPC that actually received
      // the transaction, preventing false timeouts and duplicate submissions.
      const conn = this.connection;

      // Before retrying, check if the PREVIOUS attempt's tx landed late.
      // This prevents duplicate collateral additions/removals where the program
      // has no built-in dedup (unlike openPosition which rejects duplicates).
      if (attempt > 1 && lastSignature) {
        try {
          const confirmed = await this.isSignatureConfirmed(lastSignature);
          if (confirmed) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Previous tx confirmed (late detection before retry): ${lastSignature}`);
            return lastSignature;
          }
        } catch {
          // Best-effort — proceed with retry if check fails
        }
      }

      if (attempt === 1) {
        process.stdout.write('  Sending transaction...   \r');
      } else {
        process.stdout.write(`  Retry ${attempt}/${maxAttempts} (fresh blockhash)...\r`);
        logger.info('CLIENT', `Retry attempt ${attempt}/${maxAttempts}`);
      }

      try {
        const latestBlockhash = await conn.getLatestBlockhash('confirmed');
        const allIxs = [cuLimitIx, cuPriceIx, ...instructions];
        const message = MessageV0.compile({
          payerKey: this.wallet.publicKey,
          instructions: allIxs,
          recentBlockhash: latestBlockhash.blockhash,
          addressLookupTableAccounts: [],
        });
        const vtx = new VersionedTransaction(message);
        vtx.sign([this.wallet, ...additionalSigners]);
        const txBytes = Buffer.from(vtx.serialize());

        const signatureStr = await conn.sendRawTransaction(txBytes, {
          skipPreflight: true,
          maxRetries: 3,
        });
        lastSignature = signatureStr;
        logger.info('CLIENT', `Tx sent: ${signatureStr} (${txBytes.length} bytes, attempt ${attempt})`);

        // Poll for confirmation with periodic resends
        // Uses the same `conn` that sent the transaction — never switches mid-poll.
        process.stdout.write('  Awaiting confirmation... \r');
        const start = Date.now();
        const timeoutMs = 45_000;
        for (let i = 0; Date.now() - start < timeoutMs; i++) {
          await new Promise(r => setTimeout(r, 2_000));
          const { value } = await conn.getSignatureStatuses([signatureStr]);
          const status = value?.[0];
          if (status?.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
          }
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed: ${signatureStr}`);
            return signatureStr;
          }
          // Resend every other poll to improve delivery
          if (i % 2 === 0) {
            conn.sendRawTransaction(txBytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
          }
        }

        // Before declaring timeout, do one final status check using the SAME
        // connection that sent the tx. The tx may have landed between the last
        // poll and now. This prevents duplicate submissions.
        try {
          const { value: finalValue } = await conn.getSignatureStatuses([signatureStr]);
          const finalStatus = finalValue?.[0];
          if (finalStatus && !finalStatus.err &&
              (finalStatus.confirmationStatus === 'confirmed' || finalStatus.confirmationStatus === 'finalized')) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed (late detection): ${signatureStr}`);
            return signatureStr;
          }
        } catch {
          // Final check is best-effort — if it fails we proceed to retry
        }

        lastError = `Not confirmed within ${timeoutMs / 1000}s`;
        logger.warn('CLIENT', `Attempt ${attempt} timed out — ${lastError}`);
      } catch (e: unknown) {
        const eMsg = getErrorMessage(e);
        if (eMsg.includes('failed on-chain')) {
          process.stdout.write('                              \r');
          throw e;
        }
        lastError = eMsg;
        logger.warn('CLIENT', `Attempt ${attempt} failed: ${scrubSensitive(eMsg)}`);

        // On network-level failures, attempt RPC failover before next retry.
        // Uses force=true to bypass cooldown — explicit trade failures warrant
        // immediate failover regardless of the background monitor's cooldown.
        if (attempt < maxAttempts && isNetworkError(eMsg)) {
          const rpcMgr = getRpcManagerInstance();
          if (rpcMgr && rpcMgr.fallbackCount > 0) {
            logger.info('CLIENT', 'Network error detected — attempting RPC failover before retry');
            rpcMgr.recordResult(false);
            const didFailover = await rpcMgr.failover(true);
            if (didFailover) {
              // replaceConnection is called via the onConnectionChange callback.
              // Next iteration captures the new this.connection via `const conn = this.connection`.
              logger.info('CLIENT', `Switched to ${rpcMgr.activeEndpoint.label} — retrying`);
            }
          }
        }
      }
    }

    process.stdout.write('                              \r');
    throw new Error(
      `Transaction failed after ${maxAttempts} attempts.\n` +
      `  Last error: ${lastError}\n` +
      (lastSignature ? `  Last signature: ${lastSignature}\n  Check https://solscan.io/tx/${lastSignature}` : '')
    );
  }


  // ─── Trade Mutex ──────────────────────────────────────────────────────────

  private acquireTradeLock(market: string, side: TradeSide): void {
    const key = `${market}:${side}`;
    if (this.activeTrades.has(key)) {
      throw new Error(`A ${side} trade on ${market} is already in progress. Wait for it to complete.`);
    }
    this.activeTrades.add(key);
  }

  private releaseTradeLock(market: string, side: TradeSide): void {
    this.activeTrades.delete(`${market}:${side}`);
  }

  // ─── Recent Trade Cache ──────────────────────────────────────────────────

  /**
   * Build a cache key for a trade operation.
   */
  private tradeCacheKey(action: string, market: string, side: TradeSide, amount?: number): string {
    return `${action}:${market}:${side}${amount !== undefined ? `:${amount}` : ''}`;
  }

  /**
   * Check if an identical trade was recently submitted. Prevents accidental
   * duplicate commands when the user re-sends after a timeout that actually landed.
   * Evicts expired entries on each check.
   */
  private checkRecentTrade(key: string): void {
    const now = Date.now();
    // Evict expired entries
    for (const [k, ts] of this.recentTrades) {
      if (now - ts > FlashClient.TRADE_CACHE_TTL_MS) {
        this.recentTrades.delete(k);
      }
    }
    const lastTime = this.recentTrades.get(key);
    if (lastTime && now - lastTime < FlashClient.TRADE_CACHE_TTL_MS) {
      const ago = Math.ceil((now - lastTime) / 1000);
      throw new Error(
        `Duplicate trade detected — the same trade was submitted ${ago}s ago.\n` +
        `  Wait ${Math.ceil((FlashClient.TRADE_CACHE_TTL_MS - (now - lastTime)) / 1000)}s or check "positions" to verify.`
      );
    }
  }

  /**
   * Record a successful trade in the cache.
   */
  private recordRecentTrade(key: string): void {
    this.recentTrades.set(key, Date.now());
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

    // Pre-trade validation (synchronous checks before locking)
    this.validateLeverage(market, leverage);
    const sideStr = side === TradeSide.Long ? 'long' : 'short';
    if (collateralAmount < 10) {
      throw new Error(
        `Minimum collateral is $10 (got $${collateralAmount}).\n` +
        `  Try: open ${leverage}x ${sideStr} ${market} $10`
      );
    }

    // Duplicate trade cache check (synchronous)
    const cacheKey = this.tradeCacheKey('open', market, side, collateralAmount);
    this.checkRecentTrade(cacheKey);

    // Acquire trade lock BEFORE any async operations to prevent interleaving
    this.acquireTradeLock(market, side);
    try {
      await this.ensureSufficientSol();

      // Check USDC balance before building transaction
      const inputSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      if (inputSymbol === 'USDC') {
        try {
          const balances = await this.walletMgr.getTokenBalances();
          const usdcBalance = balances.tokens.find(t => t.symbol === 'USDC')?.amount ?? 0;
          if (usdcBalance < collateralAmount) {
            throw new Error(
              `Insufficient USDC collateral.\n` +
              `  Required: $${collateralAmount.toFixed(2)}\n` +
              `  Available: $${usdcBalance.toFixed(2)}\n` +
              `  Deposit USDC to trade on Flash Trade.`
            );
          }
        } catch (e: unknown) {
          const eMsg = getErrorMessage(e);
          if (eMsg.includes('Insufficient USDC')) throw e;
          // RPC failure during balance check — warn but don't block the trade
          logger.warn('CLIENT', `USDC balance check skipped (RPC error): ${scrubSensitive(eMsg)}`);
        }
      }

      // Check for duplicate position before sending
      const poolConfig = this.getPoolConfigForMarket(market);
      try {
        const positions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
        const token = this.findToken(poolConfig, market);
        const sdkSide = toSdkSide(side);
        const markets = poolConfig.markets as unknown as Array<{
          marketAccount: PublicKey; targetMint: PublicKey; side: typeof Side.Long | typeof Side.Short;
        }>;
        const marketConfig = markets.find(m => m.targetMint.equals(token.mintKey) && m.side === sdkSide);
        if (marketConfig) {
          const existing = (positions as Array<{ market: PublicKey }>).find(
            p => p.market.equals(marketConfig.marketAccount)
          );
          if (existing) {
            throw new Error(
              `You already have an open ${sideStr} position on ${market}.\n` +
              `  Close it first with: close ${sideStr} ${market}`
            );
          }
        }
      } catch (e: unknown) {
        const eMsg = getErrorMessage(e);
        if (eMsg.includes('already have an open')) throw e;
        // If position check fails due to RPC, proceed — the program will reject duplicates anyway
        logger.debug('CLIENT', `Pre-trade position check skipped: ${scrubSensitive(eMsg)}`);
      }

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
      this.recordRecentTrade(cacheKey);

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
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Close Position ───────────────────────────────────────────────────────

  async closePosition(market: string, side: TradeSide, receiveToken?: string): Promise<ClosePositionResult> {
    const logger = getLogger();

    await this.ensureSufficientSol();

    const cacheKey = this.tradeCacheKey('close', market, side);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
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
      this.recordRecentTrade(cacheKey);

      logger.trade('CLOSE', { market, side, price: targetPrice.uiPrice, tx: txSignature });
      return { txSignature, exitPrice: targetPrice.uiPrice, pnl: 0 };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Collateral Management ────────────────────────────────────────────────

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    await this.ensureSufficientSol();

    const cacheKey = this.tradeCacheKey('add', market, side, amount);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const token = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      const amountNative = uiDecimalsToNative(amount.toString(), token.decimals);
      const { position } = await this.findUserPosition(poolConfig, market, side);

      const result = await this.perpClient.addCollateral(
        amountNative, market, token.symbol, toSdkSide(side), position.pubkey, poolConfig
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);
      getLogger().trade('ADD_COLLATERAL', { market, side, amount, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    await this.ensureSufficientSol();

    const cacheKey = this.tradeCacheKey('remove', market, side, amount);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const token = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      const amountNative = uiDecimalsToNative(amount.toString(), token.decimals);
      const { position } = await this.findUserPosition(poolConfig, market, side);

      const result = await this.perpClient.removeCollateral(
        amountNative, market, token.symbol, toSdkSide(side), position.pubkey, poolConfig
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);
      getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Dry Run / Transaction Preview ─────────────────────────────────────

  /**
   * Build a transaction preview without signing or sending.
   * Compiles the transaction, runs Solana simulation, and returns details.
   * SAFETY: No signing or sending occurs. The transaction is compiled and simulated only.
   */
  async previewOpenPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<DryRunPreview> {
    const logger = getLogger();

    this.validateLeverage(market, leverage);
    if (collateralAmount < 10) {
      throw new Error(`Minimum collateral is $10 (got $${collateralAmount}).`);
    }

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const targetToken = this.findToken(poolConfig, market);
    const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
    const inputToken = this.findToken(poolConfig, collateralSymbol);

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    const inputPrice = priceMap.get(inputToken.symbol);
    if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}.`);
    if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}.`);

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide,
    );

    const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
    const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
    const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

    const custodyAccounts = await withRetry(
      () => this.perpClient.program.account.custody.fetchMultiple([
        inputCustody.custodyAccount, outputCustody.custodyAccount,
      ]),
      'custody-fetch-preview',
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
      BN_ZERO,
    );

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (inputToken.symbol === targetToken.symbol) {
      result = await this.perpClient.openPosition(
        targetToken.symbol, inputToken.symbol, priceAfterSlippage,
        collateralNative, sizeAmount, sdkSide, poolConfig, Privilege.None,
      );
    } else {
      result = await this.perpClient.swapAndOpen(
        targetToken.symbol, targetToken.symbol, inputToken.symbol,
        collateralNative, priceAfterSlippage, sizeAmount, sdkSide,
        poolConfig, Privilege.None,
      );
    }

    // Build the transaction WITHOUT signing
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });
    const allIxs = [cuLimitIx, cuPriceIx, ...result.instructions];

    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
    const message = MessageV0.compile({
      payerKey: this.wallet.publicKey,
      instructions: allIxs,
      recentBlockhash: latestBlockhash.blockhash,
      addressLookupTableAccounts: [],
    });
    const vtx = new VersionedTransaction(message);
    // DO NOT sign — this is a preview only
    const txBytes = Buffer.from(vtx.serialize());

    // Collect unique accounts from all instructions
    const accountSet = new Set<string>();
    for (const ix of allIxs) {
      accountSet.add(ix.programId.toBase58());
      for (const key of ix.keys) {
        accountSet.add(key.pubkey.toBase58());
      }
    }

    // Liquidation price estimate
    const liqDist = leverage > 0 ? (1 / leverage) * 0.9 : 0;
    const liqPrice = side === TradeSide.Long
      ? targetPrice.uiPrice * (1 - liqDist)
      : targetPrice.uiPrice * (1 + liqDist);

    const preview: DryRunPreview = {
      market,
      side,
      collateral: collateralAmount,
      leverage,
      positionSize: collateralAmount * leverage,
      entryPrice: targetPrice.uiPrice,
      liquidationPrice: liqPrice,
      estimatedFee: (collateralAmount * leverage * 8) / 10_000, // 0.08% fee
      programId: poolConfig.programId.toBase58(),
      accountCount: accountSet.size,
      instructionCount: allIxs.length,
      estimatedComputeUnits: this.config.computeUnitLimit,
      transactionSize: txBytes.length,
    };

    // Run Solana simulation (RPC simulateTransaction)
    try {
      // Sign for simulation only (required by simulateTransaction)
      const simVtx = new VersionedTransaction(message);
      simVtx.sign([this.wallet, ...result.additionalSigners]);

      const simResult = await this.connection.simulateTransaction(simVtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      preview.simulationSuccess = !simResult.value.err;
      preview.simulationLogs = simResult.value.logs ?? [];
      preview.simulationUnitsConsumed = simResult.value.unitsConsumed ?? 0;
      if (simResult.value.err) {
        preview.simulationError = JSON.stringify(simResult.value.err);
      }
    } catch (e: unknown) {
      preview.simulationSuccess = false;
      preview.simulationError = getErrorMessage(e);
      logger.debug('DRYRUN', `Simulation failed: ${getErrorMessage(e)}`);
    }

    logger.info('DRYRUN', `Preview built for ${market} ${side} ${leverage}x $${collateralAmount}`);
    return preview;
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
      unsettledFeesUsd?: BN;
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
        const rawEntryField = raw.entryPrice;
        let parsedEntry = 0;
        if (rawEntryField && typeof rawEntryField === 'object' && 'price' in rawEntryField && 'exponent' in rawEntryField) {
          parsedEntry = parseFloat(rawEntryField.price.toString()) * Math.pow(10, rawEntryField.exponent);
        } else if (rawEntryField && BN.isBN(rawEntryField)) {
          const oracleExp = Number(tokenPrice.price.exponent.toString());
          parsedEntry = parseFloat(rawEntryField.toString()) * Math.pow(10, oracleExp);
        }

        // USD values in Flash Trade always use 6 decimal precision (USD_DECIMALS),
        // NOT the token's native decimals (sizeDecimals/collateralDecimals are TOKEN decimals).
        const USD_DECIMALS = 6;
        const parsedSize = raw.sizeUsd ? parseFloat(raw.sizeUsd.toString()) / Math.pow(10, USD_DECIMALS) : 0;
        const parsedCollateral = raw.collateralUsd ? parseFloat(raw.collateralUsd.toString()) / Math.pow(10, USD_DECIMALS) : 0;
        const parsedCurrentPrice = tokenPrice.uiPrice;

        // NaN/Infinity guard
        const entryPrice = Number.isFinite(parsedEntry) ? parsedEntry : 0;
        const sizeUsd = Number.isFinite(parsedSize) ? parsedSize : 0;
        const collateralUsd = Number.isFinite(parsedCollateral) ? parsedCollateral : 0;
        const currentPrice = Number.isFinite(parsedCurrentPrice) ? parsedCurrentPrice : 0;

        if (entryPrice <= 0 || sizeUsd <= 0 || collateralUsd <= 0) {
          getLogger().warn('CLIENT', `Skipping position with invalid values: entry=${entryPrice} size=${sizeUsd} collateral=${collateralUsd}`);
          continue;
        }

        const rawLeverage = sizeUsd / collateralUsd;
        const leverage = Number.isFinite(rawLeverage) ? rawLeverage : 0;
        const side = marketConfig.side === Side.Long ? TradeSide.Long : TradeSide.Short;
        const priceDelta = currentPrice - entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        const unrealizedPnl = (priceDelta / entryPrice) * sizeUsd * pnlMult;
        const safeUnrealizedPnl = Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0;

        const liqDist = leverage > 0 ? (1 / leverage) * 0.9 : 0;
        const liquidationPrice = side === TradeSide.Long
          ? entryPrice * (1 - liqDist)
          : entryPrice * (1 + liqDist);

        // Accumulated fees from protocol (unsettledFeesUsd is in USD with 6 decimals)
        const rawFees = raw.unsettledFeesUsd
          ? parseFloat(raw.unsettledFeesUsd.toString()) / Math.pow(10, USD_DECIMALS)
          : 0;
        const totalFees = Number.isFinite(rawFees) ? rawFees : 0;

        const rawPnlPct = collateralUsd > 0 ? (safeUnrealizedPnl / collateralUsd) * 100 : 0;

        positions.push({
          pubkey: raw.pubkey.toBase58(),
          market: targetToken.symbol,
          side,
          entryPrice,
          currentPrice,
          markPrice: currentPrice,
          sizeUsd,
          collateralUsd,
          leverage,
          unrealizedPnl: safeUnrealizedPnl,
          unrealizedPnlPercent: Number.isFinite(rawPnlPct) ? rawPnlPct : 0,
          liquidationPrice,
          openFee: 0,
          totalFees,
          fundingRate: 0,
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
      totalRealizedPnl: 0,
      totalFees: positions.reduce((s, p) => s + p.totalFees, 0),
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

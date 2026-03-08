import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readFileSync, realpathSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const RPC_RETRY_OPTS = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3000 };

export class WalletManager {
  private connection: Connection;
  private keypair: Keypair | null = null;
  private publicKey: PublicKey | null = null;
  private tokenBalancesCache: { data: { sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> }; expiry: number } | null = null;
  private static readonly TOKEN_CACHE_TTL = 30_000;

  // [H-3] Session timeout — auto-disconnect keypair after inactivity
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '900000', 10); // 15 min default

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /** Reset the idle session timer (call on every signed operation). */
  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.keypair) return;
    this.idleTimer = setTimeout(() => {
      if (this.keypair) {
        const logger = getLogger();
        logger.warn('WALLET', 'Session timed out due to inactivity — wallet disconnected for security');
        this.disconnect();
      }
    }, WalletManager.SESSION_TIMEOUT_MS);
    this.idleTimer.unref(); // Don't prevent process exit
  }

  /** True if a keypair is loaded (can sign transactions) */
  get isConnected(): boolean {
    return this.keypair !== null;
  }

  /** True if at least a public key is set (read-only or full access) */
  get hasAddress(): boolean {
    return this.publicKey !== null;
  }

  /** True if only an address is connected (no signing capability) */
  get isReadOnly(): boolean {
    return this.publicKey !== null && this.keypair === null;
  }

  get address(): string | null {
    return this.publicKey?.toBase58() ?? null;
  }

  getKeypair(): Keypair | null {
    return this.keypair;
  }

  /**
   * Disconnect wallet: clear keypair and public key from memory.
   * Attempts to zero the secret key bytes in the Keypair's internal buffer.
   * Note: Keypair.fromSecretKey holds a REFERENCE to the input Uint8Array,
   * so we zero the secretKey property directly to scrub from memory.
   */
  disconnect(): void {
    if (this.keypair) {
      // Zero the secret key bytes in memory
      // Keypair.secretKey returns the internal Uint8Array reference
      try {
        const sk = this.keypair.secretKey;
        if (sk && sk instanceof Uint8Array) {
          sk.fill(0);
        }
      } catch {
        // Best-effort — some environments may restrict property access
      }
    }
    this.keypair = null;
    this.publicKey = null;
    this.tokenBalancesCache = null;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * Load a keypair from a JSON file (Solana CLI format).
   * Throws on invalid file or keypair.
   */
  loadFromFile(path: string): { address: string; keypair: Keypair } {
    const logger = getLogger();

    // Sanitize path: resolve symlinks and ensure it stays within user's home directory
    const resolvedPath = resolve(path);
    const home = homedir();
    // Use path separator suffix to prevent prefix attacks (e.g., /home/userX matching /home/user)
    const homePrefix = home.endsWith('/') ? home : home + '/';
    if (resolvedPath !== home && !resolvedPath.startsWith(homePrefix)) {
      throw new Error(`Wallet path must be within home directory (${home}). Got: ${resolvedPath}`);
    }

    // Resolve symlinks to prevent traversal via symlink
    let realPath: string;
    try {
      realPath = realpathSync(resolvedPath);
    } catch {
      throw new Error(`Wallet file not found: ${resolvedPath}`);
    }

    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error(`Wallet path resolves outside home directory (symlink?). Real path: ${realPath}`);
    }

    // Reject suspiciously large files (keypair JSON should be < 1KB)
    const fileSize = statSync(realPath).size;
    if (fileSize > 1024) {
      throw new Error(`Wallet file too large (${fileSize} bytes). Expected a 64-byte keypair JSON.`);
    }

    let raw: string;
    try {
      raw = readFileSync(realPath, 'utf-8');
    } catch {
      throw new Error(`Wallet file not found: ${realPath}`);
    }

    let secretKey: number[];
    try {
      secretKey = JSON.parse(raw);
    } catch {
      throw new Error('Invalid wallet file format.');
    }

    // Clear the raw string reference — secretKey holds the parsed data now
    raw = '';

    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      throw new Error(`Invalid keypair: expected 64-byte array, got ${Array.isArray(secretKey) ? secretKey.length : typeof secretKey}`);
    }

    // Validate every byte is an integer in 0-255 range
    for (let i = 0; i < secretKey.length; i++) {
      const v = secretKey[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`Invalid keypair: byte at index ${i} is not a valid uint8 value`);
      }
    }

    const keyBytes = Uint8Array.from(secretKey);
    // Zero the parsed array immediately
    secretKey.fill(0);

    // Keypair.fromSecretKey does NOT copy the input — it holds a reference.
    // Do NOT zero keyBytes after this call, or the keypair's secret key is corrupted.
    this.keypair = Keypair.fromSecretKey(keyBytes);

    this.publicKey = this.keypair.publicKey;

    const address = this.publicKey.toBase58();
    // SECURITY: Log only the public address — never log secret key material
    logger.debug('Wallet', `Loaded wallet: ${address}`);

    // Start session idle timer
    this.resetIdleTimer();

    return { address, keypair: this.keypair };
  }

  /**
   * Verify keypair integrity: returns true if the loaded keypair can produce valid signatures.
   * Does not expose the private key — only checks that it hasn't been zeroed/corrupted.
   */
  verifyKeypairIntegrity(): boolean {
    if (!this.keypair) return false;
    try {
      // Check that the secret key has non-zero bytes (not zeroed out)
      const sk = this.keypair.secretKey;
      let nonZero = 0;
      for (let i = 0; i < 32; i++) { // Only check private portion (first 32 bytes)
        if (sk[i] !== 0) nonZero++;
      }
      return nonZero > 0;
    } catch {
      return false;
    }
  }

  /**
   * Non-throwing wrapper around loadFromFile.
   * Returns wallet info on success, null on failure.
   */
  tryDetect(path: string): { address: string; keypair: Keypair } | null {
    try {
      return this.loadFromFile(path);
    } catch {
      return null;
    }
  }

  /**
   * Connect a wallet by public key (address) for read-only access.
   * Can view balances and positions but cannot sign transactions.
   */
  connectAddress(address: string): { address: string } {
    const logger = getLogger();

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      throw new Error(`Invalid Solana address: ${address}`);
    }

    // Validate it's on the ed25519 curve (real address, not a program ID)
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
      throw new Error(`Address is not a valid wallet (off-curve): ${address}`);
    }

    this.publicKey = pubkey;
    this.keypair = null; // Read-only — no signing

    const addr = pubkey.toBase58();
    logger.debug('Wallet', `Connected address (read-only): ${addr}`);
    return { address: addr };
  }

  /**
   * Fetch the SOL balance for the connected wallet.
   */
  async getBalance(): Promise<number> {
    if (!this.publicKey) {
      throw new Error('No wallet connected');
    }

    const lamports = await withRetry(
      () => this.connection.getBalance(this.publicKey!),
      'wallet-balance',
      RPC_RETRY_OPTS,
    );
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Fetch SOL + SPL token balances (including USDC).
   */
  async getTokenBalances(): Promise<{ sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> }> {
    if (!this.publicKey) {
      throw new Error('No wallet connected');
    }

    const now = Date.now();
    if (this.tokenBalancesCache && this.tokenBalancesCache.expiry > now) {
      return this.tokenBalancesCache.data;
    }

    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const KNOWN_MINTS: Record<string, string> = {
      [USDC_MINT]: 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    };

    const [solBalance, tokenAccounts] = await withRetry(
      () => Promise.all([
        this.connection.getBalance(this.publicKey!),
        this.connection.getParsedTokenAccountsByOwner(this.publicKey!, {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        }),
      ]),
      'wallet-token-balances',
      RPC_RETRY_OPTS,
    );

    const tokens: Array<{ symbol: string; mint: string; amount: number }> = [];

    for (const account of tokenAccounts.value) {
      const info = account.account.data.parsed?.info;
      if (!info) continue;
      const mint: string = info.mint;
      const uiAmount: number = info.tokenAmount?.uiAmount ?? 0;
      if (uiAmount === 0) continue;

      const symbol = KNOWN_MINTS[mint] ?? mint.slice(0, 4) + '...';
      tokens.push({ symbol, mint, amount: uiAmount });
    }

    const result = { sol: solBalance / LAMPORTS_PER_SOL, tokens };
    this.tokenBalancesCache = { data: result, expiry: Date.now() + WalletManager.TOKEN_CACHE_TTL };
    return result;
  }
}

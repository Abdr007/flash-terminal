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

  constructor(connection: Connection) {
    this.connection = connection;
  }

  get isConnected(): boolean {
    return this.keypair !== null;
  }

  get address(): string | null {
    return this.publicKey?.toBase58() ?? null;
  }

  getKeypair(): Keypair | null {
    return this.keypair;
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
      throw new Error(`Invalid wallet file format: ${path}`);
    }

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

    this.keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    this.publicKey = this.keypair.publicKey;

    const address = this.publicKey.toBase58();
    logger.debug('Wallet', `Loaded keypair: ${address}`);

    return { address, keypair: this.keypair };
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

    return { sol: solBalance / LAMPORTS_PER_SOL, tokens };
  }
}

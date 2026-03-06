import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Keypair } from '@solana/web3.js';

const FLASH_DIR = join(homedir(), '.flash');
const WALLETS_DIR = join(FLASH_DIR, 'wallets');
const CONFIG_FILE = join(FLASH_DIR, 'config.json');

interface FlashLocalConfig {
  defaultWallet?: string;
}

/** Ensure ~/.flash/ and ~/.flash/wallets/ exist with safe permissions. */
function ensureDirs(): void {
  if (!existsSync(FLASH_DIR)) {
    mkdirSync(FLASH_DIR, { mode: 0o700 });
  }
  if (!existsSync(WALLETS_DIR)) {
    mkdirSync(WALLETS_DIR, { mode: 0o700 });
  }
}

function loadLocalConfig(): FlashLocalConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as FlashLocalConfig;
  } catch {
    return {};
  }
}

function saveLocalConfig(config: FlashLocalConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/** Validate a raw secret key array: 64 integers each 0-255. */
function validateSecretKey(data: unknown): number[] {
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of 64 numbers');
  }
  if (data.length !== 64) {
    throw new Error(`Expected 64 bytes, got ${data.length}`);
  }
  for (let i = 0; i < 64; i++) {
    const v = data[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new Error(`Invalid byte at index ${i}: must be integer 0-255`);
    }
  }
  return data as number[];
}

/** Sanitize wallet name: alphanumeric, hyphens, underscores only. */
function sanitizeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean.length > 64) {
    throw new Error('Wallet name must be 1-64 alphanumeric/hyphen/underscore characters');
  }
  return clean;
}

export class WalletStore {
  /** Import a wallet from a raw secret key array. */
  importWallet(name: string, secretKeyArray: number[]): { address: string; path: string } {
    const safeName = sanitizeName(name);
    const validated = validateSecretKey(secretKeyArray);
    const keyBytes = Uint8Array.from(validated);

    try {
      ensureDirs();

      const filePath = join(WALLETS_DIR, `${safeName}.json`);
      if (existsSync(filePath)) {
        throw new Error(`Wallet "${safeName}" already exists. Use a different name or remove it first.`);
      }

      // Derive address to verify keypair is valid
      const keypair = Keypair.fromSecretKey(keyBytes);
      const address = keypair.publicKey.toBase58();

      writeFileSync(filePath, JSON.stringify(validated), { mode: 0o600 });

      return { address, path: filePath };
    } finally {
      // Zero sensitive data from memory
      keyBytes.fill(0);
      validated.fill(0);
    }
  }

  /** List all stored wallet names. */
  listWallets(): string[] {
    ensureDirs();
    try {
      return readdirSync(WALLETS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  /** Get the file path for a stored wallet by name. */
  getWalletPath(name: string): string {
    const safeName = sanitizeName(name);
    const filePath = join(WALLETS_DIR, `${safeName}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Wallet "${safeName}" not found. Use "wallet list" to see stored wallets.`);
    }
    return filePath;
  }

  /** Set a wallet as the default (auto-loaded on startup). */
  setDefault(name: string): void {
    const safeName = sanitizeName(name);
    // Verify it exists
    this.getWalletPath(safeName);
    const config = loadLocalConfig();
    config.defaultWallet = safeName;
    saveLocalConfig(config);
  }

  /** Get the default wallet name. */
  getDefault(): string | null {
    const config = loadLocalConfig();
    if (!config.defaultWallet) return null;
    // Verify it still exists
    try {
      this.getWalletPath(config.defaultWallet);
      return config.defaultWallet;
    } catch {
      return null;
    }
  }

  /** Remove a stored wallet. */
  removeWallet(name: string): void {
    const safeName = sanitizeName(name);
    const filePath = this.getWalletPath(safeName);
    unlinkSync(filePath);

    // If this was the default, clear it
    const config = loadLocalConfig();
    if (config.defaultWallet === safeName) {
      delete config.defaultWallet;
      saveLocalConfig(config);
    }
  }

  /** Derive the public address from a stored wallet without exposing the key. */
  getAddress(name: string): string {
    const filePath = this.getWalletPath(name);
    const raw = readFileSync(filePath, 'utf-8');
    const secretKey = validateSecretKey(JSON.parse(raw));
    const keyBytes = Uint8Array.from(secretKey);
    try {
      const keypair = Keypair.fromSecretKey(keyBytes);
      return keypair.publicKey.toBase58();
    } finally {
      keyBytes.fill(0);
      secretKey.fill(0);
    }
  }
}

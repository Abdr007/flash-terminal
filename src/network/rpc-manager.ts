import { Connection } from '@solana/web3.js';
import chalk from 'chalk';
import { getLogger } from '../utils/logger.js';
import { createConnection } from '../wallet/connection.js';

const LATENCY_THRESHOLD_MS = 3_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface RpcHealthResult {
  url: string;
  label: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * RPC Manager — manages multiple RPC endpoints with automatic failover.
 * Primary is tried first; on failure, backups are tried in order.
 */
export class RpcManager {
  private endpoints: RpcEndpoint[];
  private activeIndex = 0;
  private _connection: Connection;
  private failoverCount = 0;

  constructor(endpoints: RpcEndpoint[]) {
    if (endpoints.length === 0) {
      throw new Error('At least one RPC endpoint is required');
    }
    this.endpoints = endpoints;
    this._connection = createConnection(endpoints[0].url);
  }

  get connection(): Connection {
    return this._connection;
  }

  get activeEndpoint(): RpcEndpoint {
    return this.endpoints[this.activeIndex];
  }

  get totalEndpoints(): number {
    return this.endpoints.length;
  }

  get fallbackCount(): number {
    return Math.max(0, this.endpoints.length - 1);
  }

  get totalFailovers(): number {
    return this.failoverCount;
  }

  /**
   * Test a single RPC endpoint for health + latency.
   */
  async checkHealth(endpoint: RpcEndpoint): Promise<RpcHealthResult> {
    try {
      const conn = createConnection(endpoint.url);
      const start = Date.now();
      await Promise.race([
        conn.getLatestBlockhash('confirmed'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
        ),
      ]);
      const latencyMs = Date.now() - start;
      return {
        url: endpoint.url,
        label: endpoint.label,
        healthy: true,
        latencyMs,
      };
    } catch (e: unknown) {
      return {
        url: endpoint.url,
        label: endpoint.label,
        healthy: false,
        latencyMs: -1,
        error: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Check health of all configured endpoints.
   */
  async checkAllHealth(): Promise<RpcHealthResult[]> {
    return Promise.all(this.endpoints.map(ep => this.checkHealth(ep)));
  }

  /**
   * Measure latency of the active connection (3-call average).
   */
  async measureLatency(): Promise<number> {
    let total = 0;
    const calls = 3;
    for (let i = 0; i < calls; i++) {
      const start = Date.now();
      try {
        await Promise.race([
          this._connection.getLatestBlockhash('confirmed'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
          ),
        ]);
        total += Date.now() - start;
      } catch {
        total += HEALTH_CHECK_TIMEOUT_MS;
      }
    }
    return Math.round(total / calls);
  }

  /**
   * Attempt automatic failover to the next healthy endpoint.
   * Returns true if failover succeeded, false if no healthy backup found.
   */
  async failover(): Promise<boolean> {
    const logger = getLogger();

    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.activeIndex + 1 + i) % this.endpoints.length;
      if (idx === this.activeIndex) continue;

      const ep = this.endpoints[idx];
      const health = await this.checkHealth(ep);

      if (health.healthy) {
        logger.warn('RPC', `Failover: switching from ${this.endpoints[this.activeIndex].label} to ${ep.label}`);
        this.activeIndex = idx;
        this._connection = createConnection(ep.url);
        this.failoverCount++;
        return true;
      }
    }

    logger.error('RPC', 'No healthy backup RPC found');
    return false;
  }

  /**
   * Get a connection, checking health first. If unhealthy, attempt failover.
   */
  async getHealthyConnection(): Promise<Connection> {
    const health = await this.checkHealth(this.activeEndpoint);

    if (!health.healthy || health.latencyMs > LATENCY_THRESHOLD_MS) {
      const didFailover = await this.failover();
      if (didFailover) {
        return this._connection;
      }
      // No backup available — return current connection anyway
    }

    return this._connection;
  }

  /**
   * Format status for CLI display.
   */
  formatStatus(latencyMs: number): string {
    const active = this.activeEndpoint;
    const lines = [
      '',
      chalk.bold('  RPC STATUS'),
      chalk.dim('  ────────────────────────────'),
      '',
      `  Active RPC:    ${chalk.cyan(active.label)}`,
      `  Latency:       ${this.colorLatency(latencyMs)}`,
      `  Fallback RPCs: ${chalk.bold(String(this.fallbackCount))}`,
      `  Failovers:     ${chalk.bold(String(this.failoverCount))}`,
    ];

    if (this.endpoints.length > 1) {
      lines.push('');
      lines.push(chalk.bold('  Endpoints'));
      for (let i = 0; i < this.endpoints.length; i++) {
        const ep = this.endpoints[i];
        const marker = i === this.activeIndex ? chalk.green('*') : chalk.dim('-');
        lines.push(`    ${marker} ${ep.label} ${i === this.activeIndex ? chalk.green('(active)') : ''}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  private colorLatency(ms: number): string {
    if (ms < 0) return chalk.red('unavailable');
    if (ms < 500) return chalk.green(`${ms}ms`);
    if (ms < 1500) return chalk.yellow(`${ms}ms`);
    return chalk.red(`${ms}ms`);
  }
}

/**
 * Build RPC endpoints from environment config.
 * Reads: RPC_URL, BACKUP_RPC_1, BACKUP_RPC_2
 */
export function buildRpcEndpoints(primaryUrl: string): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [
    { url: primaryUrl, label: labelFromUrl(primaryUrl) },
  ];

  const backup1 = process.env.BACKUP_RPC_1;
  const backup2 = process.env.BACKUP_RPC_2;

  if (backup1) {
    endpoints.push({ url: backup1, label: labelFromUrl(backup1) });
  }
  if (backup2) {
    endpoints.push({ url: backup2, label: labelFromUrl(backup2) });
  }

  return endpoints;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: RpcManager | null = null;

export function initRpcManager(endpoints: RpcEndpoint[]): RpcManager {
  _instance = new RpcManager(endpoints);
  return _instance;
}

export function getRpcManagerInstance(): RpcManager | null {
  return _instance;
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.includes('helius')) return 'Helius';
    if (host.includes('quicknode')) return 'QuickNode';
    if (host.includes('alchemy')) return 'Alchemy';
    if (host.includes('triton')) return 'Triton';
    if (host.includes('getblock')) return 'GetBlock';
    if (host.includes('mainnet-beta.solana.com')) return 'Solana Public';
    if (host === 'localhost' || host === '127.0.0.1') return 'Localhost';
    return host.split('.')[0] || 'Custom';
  } catch {
    return 'Custom';
  }
}

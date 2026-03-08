import chalk from 'chalk';
import { Interface as ReadlineInterface } from 'readline';
import { IFlashClient } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { formatUsd } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Status Bar ──────────────────────────────────────────────────────────────
//
// Lightweight status bar that renders below the prompt every 10 seconds.
// Shows RPC provider, latency, network, wallet, positions, exposure, mode.
//
// Design constraints:
//   • No new network calls — reuses cached data from existing systems
//   • Suspends during command execution or monitor mode
//   • Uses readline cursor control for flicker-free updates
//   • Timer is unref'd so it doesn't prevent Node exit

const STATUS_INTERVAL_MS = 10_000;

interface StatusBarConfig {
  simulationMode: boolean;
  walletName: string;
}

interface CachedStatus {
  rpcLabel: string;
  latencyMs: number;
  network: string;
  walletName: string;
  positions: number;
  exposureUsd: number;
  mode: string;
  timestamp: number;
}

export class StatusBar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private rl: ReadlineInterface;
  private client: IFlashClient;
  private rpcManager: RpcManager;
  private cfg: StatusBarConfig;
  private suspended = false;
  private lastStatus: CachedStatus | null = null;
  private active = false;

  constructor(
    rl: ReadlineInterface,
    client: IFlashClient,
    rpcManager: RpcManager,
    cfg: StatusBarConfig,
  ) {
    this.rl = rl;
    this.client = client;
    this.rpcManager = rpcManager;
    this.cfg = cfg;
  }

  /** Start periodic status bar updates. */
  start(): void {
    if (this.active) return;
    this.active = true;

    // Initial render after a brief delay to avoid stomping on startup output
    const initDelay = setTimeout(() => {
      if (this.active && !this.suspended) {
        this.refresh().catch(() => {});
      }
    }, 2_000);
    if (initDelay.unref) initDelay.unref();

    this.timer = setInterval(() => {
      if (!this.suspended) {
        this.refresh().catch(() => {});
      }
    }, STATUS_INTERVAL_MS);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Stop the status bar permanently. */
  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Temporarily suspend rendering (during command execution / monitor mode). */
  suspend(): void {
    this.suspended = true;
  }

  /** Resume rendering after suspension. */
  resume(): void {
    this.suspended = false;
  }

  /** Update the client reference (e.g. after wallet reconnect). */
  setClient(client: IFlashClient): void {
    this.client = client;
  }

  /** Update the wallet display name. */
  setWalletName(name: string): void {
    this.cfg.walletName = name;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.active || this.suspended) return;

    try {
      const status = await this.gatherStatus();
      this.lastStatus = status;
      this.render(status);
    } catch (err) {
      getLogger().debug('STATUS_BAR', `Refresh error: ${getErrorMessage(err)}`);
    }
  }

  private async gatherStatus(): Promise<CachedStatus> {
    const ep = this.rpcManager.activeEndpoint;
    const latency = this.rpcManager.activeLatencyMs;

    let positions = 0;
    let exposureUsd = 0;

    try {
      // getPositions uses cached data from the reconciler in most cases
      const positionList = await this.client.getPositions();
      positions = positionList.length;
      for (const p of positionList) {
        if (Number.isFinite(p.sizeUsd) && p.sizeUsd > 0) {
          exposureUsd += p.sizeUsd;
        }
      }
    } catch {
      // Use last known values if available
      if (this.lastStatus) {
        positions = this.lastStatus.positions;
        exposureUsd = this.lastStatus.exposureUsd;
      }
    }

    return {
      rpcLabel: ep.label,
      latencyMs: latency,
      network: 'mainnet-beta',
      walletName: this.cfg.walletName || 'N/A',
      positions,
      exposureUsd,
      mode: this.cfg.simulationMode ? 'SIMULATION' : 'LIVE',
      timestamp: Date.now(),
    };
  }

  private render(s: CachedStatus): void {
    if (this.suspended || !this.active) return;

    // Build the status line
    const latStr = s.latencyMs > 0
      ? (s.latencyMs < 500 ? chalk.green(`${s.latencyMs}ms`) : s.latencyMs < 1500 ? chalk.yellow(`${s.latencyMs}ms`) : chalk.red(`${s.latencyMs}ms`))
      : chalk.dim('--');

    const modeColor = s.mode === 'LIVE' ? chalk.red(s.mode) : chalk.yellow(s.mode);

    const parts = [
      `RPC: ${chalk.cyan(s.rpcLabel)} (${latStr})`,
      `Network: ${s.network}`,
      `Wallet: ${chalk.bold(s.walletName)}`,
      `Positions: ${s.positions}`,
      `Exposure: ${formatUsd(s.exposureUsd)}`,
      `Mode: ${modeColor}`,
    ];

    const statusLine = parts.join(chalk.dim(' | '));
    const separator = chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 80)));

    // Write status below the current prompt line without disrupting readline.
    // Strategy: print the status, then re-display the prompt.
    // We use process.stdout.write to avoid extra newlines.
    process.stdout.write('\n');
    process.stdout.write(`${statusLine}\n`);
    process.stdout.write(`${separator}\n`);
    process.stdout.write('\n');

    // Re-display the readline prompt so the cursor is in the right place
    this.rl.prompt(true);
  }
}

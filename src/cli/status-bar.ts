import * as readline from 'readline';
import chalk from 'chalk';
import { Interface as ReadlineInterface } from 'readline';
import { IFlashClient } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { formatUsd } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { theme } from './theme.js';

// ─── Status Bar ──────────────────────────────────────────────────────────────
//
// Lightweight status bar that renders below the prompt every 10 seconds.
// Shows RPC provider, latency, network, wallet, positions, exposure, mode.
//
// Design constraints:
//   • No new network calls — reuses cached data from existing systems
//   • Suspends during command execution or monitor mode
//   • Updates in-place using ANSI cursor control — never appends new lines
//   • Timer is unref'd so it doesn't prevent Node exit

const STATUS_INTERVAL_MS = 10_000;
/** Number of terminal lines the status bar occupies (status + separator) */
const STATUS_LINE_COUNT = 2;

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
  /** Whether the status bar lines have been printed at least once */
  private rendered = false;
  /** Previous display string for change detection */
  private prevStatusText = '';
  private prevSeparatorText = '';

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

  /** Resume rendering after suspension. Resets rendered flag so next render prints fresh. */
  resume(): void {
    this.suspended = false;
    this.rendered = false;
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
      ? (s.latencyMs < 500 ? theme.positive(`${s.latencyMs}ms`) : s.latencyMs < 1500 ? theme.warning(`${s.latencyMs}ms`) : theme.negative(`${s.latencyMs}ms`))
      : theme.dim('--');

    const modeColor = s.mode === 'LIVE' ? theme.negative(s.mode) : theme.warning(s.mode);

    const parts = [
      `${theme.dim('RPC:')} ${theme.accent(s.rpcLabel)} ${theme.dim('(')}${latStr}${theme.dim(')')}`,
      `${theme.dim('Wallet:')} ${chalk.bold(s.walletName)}`,
      `${theme.dim('Pos:')} ${s.positions}`,
      `${theme.dim('Exp:')} ${formatUsd(s.exposureUsd)}`,
      `${theme.dim('Mode:')} ${modeColor}`,
    ];

    const statusText = parts.join(theme.dim('  |  '));
    const separatorText = theme.fullSeparator();

    // Skip redraw if nothing changed
    if (this.rendered && statusText === this.prevStatusText && separatorText === this.prevSeparatorText) {
      return;
    }
    this.prevStatusText = statusText;
    this.prevSeparatorText = separatorText;

    if (!this.rendered) {
      // First render: print the status lines below the prompt
      process.stdout.write('\n');
      process.stdout.write(`${statusText}\n`);
      process.stdout.write(`${separatorText}\n`);
      this.rendered = true;
    } else {
      // Subsequent renders: move cursor up over the existing status lines and overwrite
      // Lines to move up: STATUS_LINE_COUNT (status + separator) + 1 (blank line after prompt)
      readline.moveCursor(process.stdout, 0, -(STATUS_LINE_COUNT + 1));

      // Overwrite status line
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`${statusText}`);

      // Overwrite separator line
      process.stdout.write('\n');
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`${separatorText}`);

      // Move to the line after separator
      process.stdout.write('\n');
    }

    // Re-display the readline prompt so the cursor is in the right place
    this.rl.prompt(true);
  }
}

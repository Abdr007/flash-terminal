import chalk from 'chalk';
import { ToolContext } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: SystemDiagnostics | null = null;

export function initSystemDiagnostics(rpcManager: RpcManager, context: ToolContext): SystemDiagnostics {
  _instance = new SystemDiagnostics(rpcManager, context);
  return _instance;
}

export function getSystemDiagnostics(): SystemDiagnostics | null {
  return _instance;
}

/**
 * System Diagnostics — inspect system health, RPC status, and transaction details.
 */
export class SystemDiagnostics {
  private rpcManager: RpcManager;
  private context: ToolContext;

  constructor(rpcManager: RpcManager, context: ToolContext) {
    this.rpcManager = rpcManager;
    this.context = context;
  }

  /**
   * Full system status report.
   */
  async systemStatus(): Promise<string> {
    const lines: string[] = [
      '',
      chalk.bold('  SYSTEM STATUS'),
      chalk.dim('  ────────────────────────────'),
      '',
    ];

    // RPC
    const activeRpc = this.rpcManager.activeEndpoint;
    let latency = -1;
    try {
      latency = await this.rpcManager.measureLatency();
    } catch { /* best-effort */ }

    lines.push(chalk.bold('  RPC'));
    lines.push(`    Active:    ${chalk.cyan(activeRpc.label)}`);
    lines.push(`    Latency:   ${this.colorLatency(latency)}`);
    lines.push(`    Failovers: ${this.rpcManager.totalFailovers}`);
    lines.push(`    Backups:   ${this.rpcManager.fallbackCount}`);
    lines.push('');

    // Wallet
    const wm = this.context.walletManager;
    lines.push(chalk.bold('  Wallet'));
    if (wm?.isConnected) {
      lines.push(`    Status:  ${chalk.green('Connected')}`);
      lines.push(`    Address: ${chalk.cyan(wm.address ?? 'unknown')}`);
      lines.push(`    Mode:    ${wm.isReadOnly ? chalk.yellow('Read-Only') : chalk.green('Full Access')}`);
    } else if (wm?.hasAddress) {
      lines.push(`    Status:  ${chalk.yellow('Read-Only')}`);
      lines.push(`    Address: ${chalk.cyan(wm.address ?? 'unknown')}`);
    } else {
      lines.push(`    Status:  ${chalk.red('Disconnected')}`);
    }
    lines.push('');

    // Positions
    try {
      const positions = await this.context.flashClient.getPositions();
      lines.push(chalk.bold('  Positions'));
      lines.push(`    Open: ${chalk.bold(String(positions.length))}`);
      if (positions.length > 0) {
        const totalSize = positions.reduce((s, p) => s + p.sizeUsd, 0);
        lines.push(`    Total Size: ${formatUsd(totalSize)}`);
      }
    } catch {
      lines.push(chalk.bold('  Positions'));
      lines.push(chalk.dim('    Unable to fetch'));
    }
    lines.push('');

    // Memory
    const mem = process.memoryUsage();
    lines.push(chalk.bold('  Memory'));
    lines.push(`    Heap Used:  ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    lines.push(`    Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);
    lines.push(`    RSS:        ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
    lines.push('');

    // Mode
    lines.push(chalk.bold('  Session'));
    lines.push(`    Mode:    ${this.context.simulationMode ? chalk.yellow('Simulation') : chalk.red('Live Trading')}`);
    lines.push(`    Uptime:  ${this.formatUptime()}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Test all configured RPC endpoints.
   */
  async rpcTest(): Promise<string> {
    const results = await this.rpcManager.checkAllHealth();
    const lines: string[] = [
      '',
      chalk.bold('  RPC LATENCY TEST'),
      chalk.dim('  ────────────────────────────'),
      '',
    ];

    for (const r of results) {
      const status = r.healthy ? chalk.green('OK') : chalk.red('FAIL');
      const lat = r.healthy ? this.colorLatency(r.latencyMs) : chalk.red(r.error ?? 'unreachable');
      const active = r.url === this.rpcManager.activeEndpoint.url ? chalk.green(' (active)') : '';
      lines.push(`    ${status} ${r.label.padEnd(16)} ${lat}${active}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Inspect a transaction by signature.
   */
  async txInspect(signature: string): Promise<string> {
    const lines: string[] = [
      '',
      chalk.bold('  TRANSACTION DETAILS'),
      chalk.dim('  ────────────────────────────'),
      '',
      `  Signature: ${chalk.dim(signature)}`,
      '',
    ];

    try {
      const conn = this.rpcManager.connection;
      const { value } = await conn.getSignatureStatuses([signature]);
      const status = value?.[0];

      if (!status) {
        lines.push(chalk.yellow('  Status: Not found (may not have landed)'));
        lines.push(chalk.dim(`  Check: https://solscan.io/tx/${signature}`));
        lines.push('');
        return lines.join('\n');
      }

      if (status.err) {
        lines.push(`  Status: ${chalk.red('Failed')}`);
        lines.push(`  Error:  ${chalk.red(JSON.stringify(status.err))}`);
      } else {
        const confStatus = status.confirmationStatus ?? 'unknown';
        const color = confStatus === 'finalized' ? chalk.green : confStatus === 'confirmed' ? chalk.cyan : chalk.yellow;
        lines.push(`  Status: ${color(confStatus)}`);
      }

      lines.push(`  Slot:   ${status.slot}`);

      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        // Fetch full transaction for details
        try {
          const tx = await conn.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (tx) {
            lines.push(`  Fee:    ${(tx.meta?.fee ?? 0) / 1e9} SOL`);
            const cu = tx.meta?.computeUnitsConsumed;
            if (cu !== undefined) {
              lines.push(`  CU:     ${cu.toLocaleString()}`);
            }
            if (tx.meta?.logMessages && tx.meta.logMessages.length > 0) {
              lines.push('');
              lines.push(chalk.bold('  Logs (last 10):'));
              const logs = tx.meta.logMessages.slice(-10);
              for (const log of logs) {
                lines.push(chalk.dim(`    ${log}`));
              }
            }
          }
        } catch {
          // Transaction details are best-effort
        }
      }

      lines.push('');
      lines.push(chalk.dim(`  Explorer: https://solscan.io/tx/${signature}`));
    } catch (e: unknown) {
      lines.push(chalk.red(`  Error fetching status: ${getErrorMessage(e)}`));
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

  private formatUptime(): string {
    const seconds = Math.floor(process.uptime());
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
}

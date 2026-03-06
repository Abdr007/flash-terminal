#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { FlashTerminal } from './cli/terminal.js';
import { getErrorMessage } from './utils/retry.js';
import { getLogger } from './utils/logger.js';
import chalk from 'chalk';

// Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error(chalk.red(`\n  Unhandled error: ${getErrorMessage(reason)}\n`));
  process.exit(1);
});

// Safe shutdown: stop autopilot before exiting
// Import at top level — safe since clawd-tools has no circular dependency with index
import { getAutopilotIfExists } from './clawd/clawd-tools.js';

function gracefulShutdown(signal: string): void {
  console.log(chalk.dim(`\n  Shutting down (${signal})...`));
  try {
    const autopilot = getAutopilotIfExists();
    if (autopilot?.state?.active) {
      autopilot.stop();
      getLogger().info('SHUTDOWN', `Autopilot stopped via ${signal}`);
    }
  } catch {
    // Best-effort cleanup — don't block exit
  }
  console.log(chalk.dim('  Goodbye.\n'));
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const program = new Command();

program
  .name('flash')
  .description('Flash AI Terminal — AI-powered CLI for Flash Trade on Solana')
  .version('1.0.0');

// Default command: launch the interactive terminal
program
  .command('start', { isDefault: true })
  .description('Start the interactive Flash AI Terminal')
  .option('--sim', 'Run in simulation mode (default)')
  .option('--live', 'Run in live trading mode (real transactions)')
  .option('-p, --pool <name>', 'Default pool name')
  .option('--rpc <url>', 'Solana RPC URL')
  .action(async (opts: { live?: boolean; sim?: boolean; pool?: string; rpc?: string }) => {
    // Conflicting flags guard
    if (opts.sim && opts.live) {
      console.error(chalk.red('\n  Cannot run both --sim and --live modes.\n'));
      console.log(chalk.dim('  Usage:'));
      console.log(chalk.dim('    flash --sim     Simulation mode (paper trading)'));
      console.log(chalk.dim('    flash --live    Live trading mode (real transactions)\n'));
      process.exit(1);
    }

    const config = loadConfig();

    // CLI flags override env var. Default to simulation for safety.
    if (opts.live) {
      config.simulationMode = false;
    } else if (opts.sim) {
      config.simulationMode = true;
    }
    // If neither flag: keep config.simulationMode from loadConfig() (defaults to true)

    if (opts.pool) config.defaultPool = opts.pool;
    if (opts.rpc) config.rpcUrl = opts.rpc;

    const terminal = new FlashTerminal(config);
    await terminal.start();
  });

program
  .command('markets')
  .description('List all available markets')
  .action(async () => {
    const { POOL_MARKETS } = await import('./config/index.js');
    console.log(chalk.bold('\n  Flash Trade Markets\n'));
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      console.log(`  ${chalk.yellow(pool)}: ${markets.join(', ')}`);
    }
    console.log();
  });

program
  .command('stats')
  .description('Show Flash Trade overview stats')
  .option('-p, --period <period>', 'Time period (7d, 30d, all)', '30d')
  .action(async (opts: { period?: '7d' | '30d' | 'all' }) => {
    const { FStatsClient } = await import('./data/fstats.js');
    const { formatUsd, colorPercent } = await import('./utils/format.js');
    const fstats = new FStatsClient();

    try {
      const stats = await fstats.getOverviewStats(opts.period);
      console.log(chalk.bold('\n  Flash Trade Stats\n'));
      console.log(`  Volume:     ${formatUsd(stats.volumeUsd)} (${colorPercent(stats.volumeChangePct)})`);
      console.log(`  Trades:     ${stats.trades.toLocaleString()}`);
      console.log(`  Fees:       ${formatUsd(stats.feesUsd)}`);
      console.log(`  Pool PnL:   ${formatUsd(stats.poolPnlUsd)}`);
      console.log(`  Revenue:    ${formatUsd(stats.poolRevenueUsd)}`);
      console.log(`  Traders:    ${stats.uniqueTraders}`);
      console.log();
    } catch (error: unknown) {
      console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
    }
  });

program
  .command('leaderboard')
  .description('Show trader leaderboard')
  .option('-m, --metric <metric>', 'Ranking metric (pnl, volume)', 'pnl')
  .option('-d, --days <days>', 'Time period in days', '30')
  .option('-n, --limit <limit>', 'Number of entries', '10')
  .action(async (opts: { metric?: 'pnl' | 'volume'; days?: string; limit?: string }) => {
    const { FStatsClient } = await import('./data/fstats.js');
    const { formatUsd, colorPnl, shortAddress, formatTable } = await import('./utils/format.js');
    const fstats = new FStatsClient();

    try {
      const entries = await fstats.getLeaderboard(
        opts.metric,
        parseInt(opts.days ?? '30'),
        parseInt(opts.limit ?? '10')
      );
      console.log(chalk.bold(`\n  Leaderboard — ${(opts.metric ?? 'pnl').toUpperCase()} (${opts.days ?? '30'}d)\n`));

      const headers = ['#', 'Trader', 'PnL', 'Volume', 'Trades'];
      const rows = entries.map((e) => [
        `${e.rank}`,
        shortAddress(e.address),
        colorPnl(e.pnl),
        formatUsd(e.volume),
        e.trades.toString(),
      ]);
      console.log(formatTable(headers, rows));
      console.log();
    } catch (error: unknown) {
      console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
    }
  });

program.parse();

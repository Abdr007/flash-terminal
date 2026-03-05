#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { FlashTerminal } from './cli/terminal.js';
import { getErrorMessage } from './utils/retry.js';
import chalk from 'chalk';

// Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error(chalk.red(`\n  Unhandled error: ${getErrorMessage(reason)}\n`));
  process.exit(1);
});

const program = new Command();

program
  .name('flash')
  .description('Flash AI Terminal — AI-powered CLI for Flash Trade on Solana')
  .version('1.0.0');

program
  .command('start', { isDefault: true })
  .description('Start the interactive Flash AI Terminal')
  .option('-s, --simulate', 'Run in simulation mode (default)', true)
  .option('-l, --live', 'Run in live mode (real transactions)')
  .option('-p, --pool <name>', 'Default pool name', 'Crypto.1')
  .option('--rpc <url>', 'Solana RPC URL')
  .action(async (opts: { live?: boolean; simulate?: boolean; pool?: string; rpc?: string }) => {
    const config = loadConfig();

    // CLI overrides
    if (opts.live) config.simulationMode = false;
    if (opts.simulate) config.simulationMode = true;
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

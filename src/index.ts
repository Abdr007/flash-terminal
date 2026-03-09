#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { FlashTerminal } from './cli/terminal.js';
import { getErrorMessage } from './utils/retry.js';
import { BUILD_INFO } from './build-info.js';
import chalk from 'chalk';

// Global error handlers — prevent crashes from leaking to the user
// NOTE: unhandledRejection must NOT call process.exit() — background subsystems
// (health monitor, reconciler) fire-and-forget promises that may
// reject during RPC outages. Crashing the terminal for a background task error
// would bypass graceful shutdown (history save, cleanup).
process.on('unhandledRejection', (reason) => {
  console.error(chalk.red(`\n  Unhandled async error: ${getErrorMessage(reason)}`));
  console.error(chalk.dim('  The terminal is still running. If this persists, restart with "exit".\n'));
});

process.on('uncaughtException', (err) => {
  console.error(chalk.red(`\n  Fatal error: ${getErrorMessage(err)}\n`));
  process.exit(1);
});

// NOTE: SIGTERM is handled by FlashTerminal.start() once the terminal is
// running. Registering it here would bypass the terminal's graceful shutdown
// (history save, monitor cleanup). For non-interactive
// commands (markets, stats, etc.), Node exits naturally when done.

const program = new Command();

const versionString = [
  `Flash Terminal v${BUILD_INFO.version}`,
  `Commit: ${BUILD_INFO.gitHash}`,
  `Branch: ${BUILD_INFO.branch}`,
  `Built:  ${BUILD_INFO.buildDate}`,
].join('\n');

program
  .name('flash')
  .description('Flash Terminal — CLI for Flash Trade on Solana')
  .version(versionString, '-v, --version');

// Default command: launch the interactive terminal
program
  .command('start', { isDefault: true })
  .description('Start the interactive Flash Terminal')
  .option('-p, --pool <name>', 'Default pool name')
  .option('--rpc <url>', 'Solana RPC URL')
  .option('--no-plugins', 'Disable plugin loading')
  .action(async (opts: { pool?: string; rpc?: string; plugins?: boolean }) => {
    const config = loadConfig();

    if (opts.pool) config.defaultPool = opts.pool;
    if (opts.rpc) config.rpcUrl = opts.rpc;
    if (opts.plugins === false) config.noPlugins = true;

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

program
  .command('doctor')
  .description('Check system environment and connectivity')
  .action(async () => {
    const config = loadConfig();

    console.log('');
    console.log(chalk.bold('  FLASH TERMINAL DIAGNOSTICS'));
    console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');

    const label = (name: string) => `  ${name.padEnd(23)}`;
    const ok = (msg: string) => chalk.green(`✓ ${msg}`);
    const warn = (msg: string) => chalk.yellow(`⚠ ${msg}`);
    const fail = (msg: string) => chalk.red(`✗ ${msg}`);

    let allOk = true;

    // 1. Node.js version
    const nodeVersion = process.versions.node;
    const major = parseInt(nodeVersion.split('.')[0], 10);
    if (major >= 18) {
      console.log(label('Node.js version') + ok(`v${nodeVersion}`));
    } else {
      console.log(label('Node.js version') + fail(`v${nodeVersion} (requires >= 18)`));
      allOk = false;
    }

    // 2. RPC connection
    if (!config.rpcUrl) {
      console.log(label('RPC connection') + fail('RPC_URL not configured'));
      allOk = false;
    } else {
      try {
        const res = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as { result?: string };
        if (data.result === 'ok') {
          console.log(label('RPC connection') + ok('Connected'));
        } else {
          console.log(label('RPC connection') + warn('Reachable but unhealthy'));
        }
      } catch {
        console.log(label('RPC connection') + fail('Unreachable'));
        allOk = false;
      }
    }

    // 3. Market data
    try {
      const { PriceService } = await import('./data/prices.js');
      const ps = new PriceService();
      const prices = await ps.getPrices(['SOL']);
      const solPrice = prices.get('SOL');
      if (solPrice && solPrice.price > 0) {
        console.log(label('Market data') + ok('Live data available'));
      } else {
        console.log(label('Market data') + warn('No price data returned'));
      }
    } catch {
      console.log(label('Market data') + fail('Unable to fetch prices'));
      allOk = false;
    }

    // 4. fstats.io connectivity
    try {
      const { FStatsClient } = await import('./data/fstats.js');
      const fstats = new FStatsClient();
      const stats = await fstats.getOverviewStats();
      if (stats.trades > 0) {
        console.log(label('Flash Trade data') + ok('Connected'));
      } else {
        console.log(label('Flash Trade data') + warn('No data returned'));
      }
    } catch {
      console.log(label('Flash Trade data') + fail('Unable to reach fstats.io'));
      allOk = false;
    }

    // 5. AI provider
    const hasPrimaryAi = !!config.anthropicApiKey && config.anthropicApiKey !== 'sk-ant-...';
    const hasGroq = !!config.groqApiKey;
    if (hasPrimaryAi && hasGroq) {
      console.log(label('AI provider') + ok('Primary + Groq'));
    } else if (hasPrimaryAi) {
      console.log(label('AI provider') + ok('Primary'));
    } else if (hasGroq) {
      console.log(label('AI provider') + ok('Groq'));
    } else {
      console.log(label('AI provider') + warn('None (local parsing only)'));
    }

    // 6. Wallet
    try {
      const { WalletStore } = await import('./wallet/wallet-store.js');
      const store = new WalletStore();
      const wallets = store.listWallets();
      const defaultWallet = store.getDefault();
      if (defaultWallet) {
        console.log(label('Wallet') + ok(`Default: ${defaultWallet}`));
      } else if (wallets.length > 0) {
        console.log(label('Wallet') + warn(`${wallets.length} saved, none set as default`));
      } else {
        console.log(label('Wallet') + warn('Not configured'));
      }
    } catch {
      console.log(label('Wallet') + warn('Not configured'));
    }

    // Summary
    console.log('');
    if (allOk) {
      console.log(chalk.green('  Environment ready.'));
    } else {
      console.log(chalk.yellow('  Some checks failed. Review the issues above.'));
    }
    console.log('');
  });

program.parse();

import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { AIInterpreter, OfflineInterpreter } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import { ToolContext, ToolResult, FlashConfig, IFlashClient, ActionType, ParsedIntent, DryRunPreview, TradeSide } from '../types/index.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { WalletManager, createConnection } from '../wallet/index.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { getLastWallet, updateLastWallet } from '../wallet/session.js';
import { shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { initLogger } from '../utils/logger.js';
import { getAutopilot, setAiApiKey, getInspector, getScanner, getRegimeDetector } from '../agent/agent-tools.js';
import { formatUsd, formatPrice, colorPercent } from '../utils/format.js';
import { MarketRegime } from '../regime/regime-types.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { RpcManager, buildRpcEndpoints, initRpcManager } from '../network/rpc-manager.js';
import { initSystemDiagnostics } from '../system/system-diagnostics.js';
import { initReconciler, getReconciler } from '../core/state-reconciliation.js';
import { loadPlugins, shutdownPlugins } from '../plugins/plugin-loader.js';

const COMMAND_TIMEOUT_MS = 120_000;
const SLOW_COMMAND_MS = 3_000;
const HISTORY_FILE = join(homedir(), '.flash', 'history');
const MAX_HISTORY = 1000;

/** Single-token fast dispatch — skips interpreter entirely */
const FAST_DISPATCH: Record<string, ParsedIntent> = {
  'help':        { action: ActionType.Help },
  'commands':    { action: ActionType.Help },
  '?':           { action: ActionType.Help },
  'positions':   { action: ActionType.GetPositions },
  'position':    { action: ActionType.GetPositions },
  'portfolio':   { action: ActionType.GetPortfolio },
  'balance':     { action: ActionType.GetPortfolio },
  'account':     { action: ActionType.GetPortfolio },
  'volume':      { action: ActionType.GetVolume },
  'fees':        { action: ActionType.GetFees },
  'fee':         { action: ActionType.GetFees },
  'markets':     { action: ActionType.FlashMarkets },
  'market':      { action: ActionType.FlashMarkets },
  'leaderboard': { action: ActionType.GetLeaderboard },
  'rankings':    { action: ActionType.GetLeaderboard },
  'dashboard':   { action: ActionType.Dashboard },
  'dash':        { action: ActionType.Dashboard },
  'risk':        { action: ActionType.RiskReport },
  'scan':        { action: ActionType.ScanMarkets },
  'rebalance':   { action: ActionType.PortfolioRebalance },
  'exposure':    { action: ActionType.PortfolioExposure },
  'risk report':     { action: ActionType.RiskReport },
  'whale activity':  { action: ActionType.WhaleActivity },
  'suggest trade':   { action: ActionType.SuggestTrade },
  'autopilot start': { action: ActionType.AutopilotStart },
  'autopilot stop':  { action: ActionType.AutopilotStop },
  'autopilot status': { action: ActionType.AutopilotStatus },
  'wallet tokens':   { action: ActionType.WalletTokens },
  'wallet':          { action: ActionType.WalletStatus },
  'wallet list':     { action: ActionType.WalletList },
  'wallet status':   { action: ActionType.WalletStatus },
  'wallet address':  { action: ActionType.WalletAddress },
  'wallet balance':  { action: ActionType.WalletBalance },
  'wallet disconnect': { action: ActionType.WalletDisconnect },
  'open interest':     { action: ActionType.GetOpenInterest },
  'oi':                { action: ActionType.GetOpenInterest },
  'whales':            { action: ActionType.WhaleActivity },
  'autopilot':         { action: ActionType.AutopilotStatus },
  'portfolio state':   { action: ActionType.PortfolioState },
  'portfolio exposure': { action: ActionType.PortfolioExposure },
  'portfolio rebalance': { action: ActionType.PortfolioRebalance },
  'capital':           { action: ActionType.PortfolioState },
  'risk monitor on':   { action: ActionType.RiskMonitorOn },
  'risk monitor off':  { action: ActionType.RiskMonitorOff },
  'inspect protocol':  { action: ActionType.InspectProtocol },
  'inspect':           { action: ActionType.InspectProtocol },
  'system status':     { action: ActionType.SystemStatus },
  'system':            { action: ActionType.SystemStatus },
  'rpc status':        { action: ActionType.RpcStatus },
  'rpc test':          { action: ActionType.RpcTest },
  'trade history':     { action: ActionType.TradeHistory },
  'trades':            { action: ActionType.TradeHistory },
  'journal':           { action: ActionType.TradeHistory },
  'history':           { action: ActionType.TradeHistory },
  'market monitor':    { action: ActionType.MarketMonitor },
  'monitor':           { action: ActionType.MarketMonitor },
  'watch':             { action: ActionType.MarketMonitor },
};

/** Timeout wrapper for command execution */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Command timed out after ${ms / 1000}s: ${label}`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

interface IntelligenceData {
  marketCount: number;
  positionCount: number;
  portfolioBalance: number;
  totalPnl: number;
  dominantRegime?: string;
  opportunities?: {
    market: string;
    direction: string;
    confidence: number;
    regime?: string;
  }[];
}

export class FlashTerminal {
  private config: FlashConfig;
  private interpreter: AIInterpreter | OfflineInterpreter;
  private engine!: ToolEngine;
  private context!: ToolContext;
  private rl!: Interface;
  private flashClient!: IFlashClient;
  private fstats: FStatsClient;
  private walletManager: WalletManager;
  /** Mode is locked for the entire session once selected */
  private modeLocked = false;
  /** Confirmation callback for the next line input */
  private pendingConfirmation: ((answer: string) => void) | null = null;
  /** Prevent concurrent command processing */
  private processing = false;
  /** Cleanup callback for risk monitor on shutdown */
  private riskMonitorCleanup: (() => void) | null = null;
  /** RPC manager for failover support */
  private rpcManager!: RpcManager;

  constructor(config: FlashConfig) {
    this.config = config;
    this.fstats = new FStatsClient();
    // Initial connection for wallet manager — will be replaced after RPC manager init
    const initConnection = createConnection(config.rpcUrl);
    this.walletManager = new WalletManager(initConnection);

    initLogger(config.logFile ? { logFile: config.logFile } : undefined);

    // Initialize signing guard with config limits
    initSigningGuard({
      maxCollateralPerTrade: config.maxCollateralPerTrade,
      maxPositionSize: config.maxPositionSize,
      maxLeverage: config.maxLeverage,
      maxTradesPerMinute: config.maxTradesPerMinute,
      minDelayBetweenTradesMs: config.minDelayBetweenTradesMs,
    });

    const hasAiKey = config.anthropicApiKey && config.anthropicApiKey !== 'sk-ant-...';
    const hasGroqKey = !!config.groqApiKey;

    if (hasAiKey || hasGroqKey) {
      this.interpreter = new AIInterpreter(
        hasAiKey ? config.anthropicApiKey : '',
        hasGroqKey ? config.groqApiKey : undefined,
      );
    } else {
      this.interpreter = new OfflineInterpreter();
    }
  }

  async start(): Promise<void> {
    // Create readline early — needed for prompts
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: MAX_HISTORY,
    });

    this.loadHistory();

    // ─── Welcome Screen & Mode Selection ──────────────────────────────
    const mode = await this.showModeSelection();

    if (mode === 'exit') {
      console.log(chalk.dim('\n  Goodbye.\n'));
      this.rl.close();
      process.exit(0);
    }

    this.config.simulationMode = mode === 'simulation';
    this.modeLocked = true;

    // ─── Mode-Specific Setup ──────────────────────────────────────────
    let walletInfo: { address: string; name: string } | null = null;

    if (mode === 'live') {
      walletInfo = await this.setupLiveMode();
      if (!walletInfo) {
        // User chose exit from wallet menu
        console.log(chalk.dim('\n  Goodbye.\n'));
        this.rl.close();
        process.exit(0);
      }
    }

    // ─── Initialize RPC Manager ─────────────────────────────────────
    const rpcEndpoints = buildRpcEndpoints(this.config.rpcUrl, this.config.backupRpcUrls);
    this.rpcManager = initRpcManager(rpcEndpoints);
    const connection = this.rpcManager.connection;

    // Warn if using public RPC for live trading
    if (!this.config.simulationMode && this.config.rpcUrl.includes('api.mainnet-beta.solana.com')) {
      console.log(chalk.yellow('\n  ⚠ Using default public RPC — transactions may be slow or fail.'));
      console.log(chalk.dim('    Set RPC_URL in .env for reliable execution (e.g. Helius, QuickNode).'));
    }

    // RPC latency check (non-blocking, 3-call average to avoid cold-start bias)
    if (!this.config.simulationMode) {
      (async () => {
        try {
          const avg = await this.rpcManager.measureLatency();
          if (avg > 600) {
            console.log(chalk.yellow(`\n  ⚠ RPC latency is high (${avg}ms average).`));
            console.log(chalk.dim('    Transaction confirmations may be slower.'));
            console.log(chalk.dim('    Consider switching to a faster RPC provider.\n'));
          }
        } catch { /* non-critical */ }
      })();
    }

    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient(10_000);
    } else {
      try {
        const { FlashClient } = await import('../client/flash-client.js');
        this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      } catch (error: unknown) {
        console.log(chalk.red(`\n  Failed to initialize live client: ${getErrorMessage(error)}`));
        // Attempt RPC failover
        if (this.rpcManager.fallbackCount > 0) {
          console.log(chalk.yellow('  Attempting RPC failover...'));
          const didFailover = await this.rpcManager.failover();
          if (didFailover) {
            console.log(chalk.green(`  Switched to ${this.rpcManager.activeEndpoint.label}`));
            try {
              const { FlashClient: FC } = await import('../client/flash-client.js');
              this.flashClient = new FC(this.rpcManager.connection, this.walletManager, this.config);
            } catch (e2: unknown) {
              console.log(chalk.red(`  Failover also failed: ${getErrorMessage(e2)}\n`));
              this.rl.close();
              process.exit(1);
            }
          } else {
            console.log(chalk.red('  No healthy backup RPC found.\n'));
            this.rl.close();
            process.exit(1);
          }
        } else {
          console.log(chalk.dim('  Please check your RPC connection and try again.\n'));
          this.rl.close();
          process.exit(1);
        }
      }
    }

    // Build tool context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      walletAddress: walletInfo?.address ?? this.flashClient.walletAddress ?? 'unknown',
      walletName: walletInfo?.name ?? '',
      walletManager: this.walletManager,
    };

    setAiApiKey(this.config.anthropicApiKey, this.config.groqApiKey);
    this.engine = new ToolEngine(this.context);

    // Initialize system diagnostics
    initSystemDiagnostics(this.rpcManager, this.context);

    // Wire RPC failover to auto-update FlashClient connection
    if (!this.config.simulationMode) {
      this.rpcManager.setConnectionChangeCallback((newConn, ep) => {
        if (this.flashClient && 'replaceConnection' in this.flashClient) {
          (this.flashClient as { replaceConnection: (c: typeof newConn) => void }).replaceConnection(newConn);
        }
        // Update context reference
        if (this.context) {
          this.context.flashClient = this.flashClient;
        }
        console.log(chalk.yellow(`\n  RPC failover: now using ${ep.label}`));
      });
      // Start background health monitoring for live trading
      this.rpcManager.startMonitoring();
    }

    // Initialize state reconciliation engine
    const reconciler = initReconciler(this.flashClient);
    reconciler.reconcile().catch(() => {}); // Initial sync — fire and forget
    if (!this.config.simulationMode) {
      reconciler.startPeriodicSync(); // 60s background sync for live mode
    }

    // Load plugins and register their tools
    try {
      const pluginTools = await loadPlugins(this.context);
      if (pluginTools.length > 0) {
        for (const tool of pluginTools) {
          this.engine.registerTool(tool);
        }
      }
    } catch {
      // Plugin loading is non-critical
    }

    // Register risk monitor cleanup
    this.riskMonitorCleanup = () => {
      import('../monitor/risk-monitor.js').then(({ getActiveRiskMonitor }) => {
        const m = getActiveRiskMonitor();
        if (m?.active) m.stop();
      }).catch(() => {});
    };

    // Set prompt based on mode
    this.updatePrompt();

    // ─── Display Intelligence Screen ─────────────────────────────────
    await this.showIntelligenceScreen(walletInfo?.name ?? null);

    // ─── Signal Handlers ──────────────────────────────────────────────
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    // ─── Start Line Handler ───────────────────────────────────────────
    this.rl.on('close', () => {
      this.shutdown();
    });

    this.rl.on('line', async (line) => {
      if (this.pendingConfirmation) {
        const cb = this.pendingConfirmation;
        this.pendingConfirmation = null;
        cb(line);
        return;
      }

      // Sanitize: strip control chars (null bytes, etc.) and collapse whitespace
      const trimmed = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed.length > 1000) {
        console.log(chalk.red('  Input too long (max 1000 characters).'));
        this.rl.prompt();
        return;
      }

      const lower = trimmed.toLowerCase();
      if (lower === 'exit' || lower === 'quit') {
        this.shutdown();
        return;
      }

      if (this.processing) {
        console.log(chalk.dim('  Please wait for the current command to finish.'));
        return;
      }

      this.processing = true;
      try {
        await this.handleInput(trimmed);
      } catch (error: unknown) {
        console.log(chalk.red(`  Error: ${getErrorMessage(error)}`));
      } finally {
        this.processing = false;
        this.rl.prompt();
      }
    });

    this.rl.prompt();
  }

  // ─── Welcome Screen ────────────────────────────────────────────────

  private async showModeSelection(): Promise<'live' | 'simulation' | 'exit'> {
    console.log('');
    console.log(chalk.yellow.bold('  ⚡ FLASH AI TERMINAL ⚡'));
    console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.dim('  AI Trading Interface for Flash Trade'));
    console.log('');
    console.log(chalk.dim('  This terminal provides real-time market intelligence'));
    console.log(chalk.dim('  and trading tools using live blockchain data.'));
    console.log('');
    console.log(chalk.bold('  Modes Available'));
    console.log('');
    console.log(`    ${chalk.cyan('1)')} ${chalk.bold('LIVE TRADING')}`);
    console.log(chalk.dim('       Execute real transactions on Flash Trade.'));
    console.log('');
    console.log(`    ${chalk.cyan('2)')} ${chalk.bold('SIMULATION')}`);
    console.log(chalk.dim('       Test strategies using paper trading.'));
    console.log('');
    console.log(chalk.dim('  All market data shown in this terminal is real-time.'));
    console.log(chalk.dim('  No synthetic or fabricated values are used.'));
    console.log('');
    console.log(chalk.bold('  Select mode:'));
    console.log('');
    console.log(`    ${chalk.cyan('1')} → Live Trading`);
    console.log(`    ${chalk.cyan('2')} → Simulation`);
    console.log(`    ${chalk.cyan('3')} → Exit`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1':
          return 'live';
        case '2':
          return 'simulation';
        case '3':
          return 'exit';
        default:
          console.log(chalk.dim('  Enter 1, 2, or 3.'));
          continue;
      }
    }
  }

  // ─── Live Mode Setup ───────────────────────────────────────────────

  /**
   * Set up live mode: ensure a wallet is connected.
   * Auto-connects if a default or single wallet exists.
   * Returns wallet info on success, null if user chose exit.
   */
  private async setupLiveMode(): Promise<{ address: string; name: string } | null> {
    const store = new WalletStore();
    const wallets = store.listWallets();
    let defaultWallet = store.getDefault();
    const sessionWallet = getLastWallet();

    // Auto-set default if there's exactly one wallet saved
    if (!defaultWallet && wallets.length === 1) {
      store.setDefault(wallets[0]);
      defaultWallet = wallets[0];
    }

    // Check session for previous wallet
    const targetWallet = defaultWallet ?? sessionWallet;

    // Auto-connect target wallet
    if (targetWallet && wallets.includes(targetWallet)) {
      console.log('');
      console.log(chalk.dim(`  Previous wallet detected: ${chalk.bold(targetWallet)}`));
      console.log('');
      console.log(`    ${chalk.cyan('1)')} Reconnect previous wallet`);
      console.log(`    ${chalk.cyan('2)')} Choose different wallet`);
      console.log(`    ${chalk.cyan('3)')} Continue without wallet ${chalk.dim('(read-only)')}`);
      console.log('');

      while (true) {
        const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

        if (choice === '1') {
          try {
            const walletPath = store.getWalletPath(targetWallet);
            const info = this.tryConnectWallet(walletPath);
            if (info && this.walletManager.isConnected) {
              console.log(chalk.green(`\n  Wallet connected: ${targetWallet}`));
              updateLastWallet(targetWallet);
              return { ...info, name: targetWallet };
            }
          } catch {
            console.log(chalk.dim(`  Wallet "${targetWallet}" could not be loaded.`));
          }
          break; // Fall through to picker
        } else if (choice === '2') {
          break; // Fall through to picker
        } else if (choice === '3') {
          // Read-only mode: no wallet
          console.log(chalk.yellow('\n  Continuing in READ-ONLY mode.'));
          console.log(chalk.dim('  You can view data but cannot execute trades.'));
          return { address: 'read-only', name: 'read-only' };
        } else {
          console.log(chalk.dim('  Enter 1, 2, or 3.'));
          continue;
        }
      }
    }

    // Multiple wallets saved — pick by number
    if (wallets.length > 1) {
      return this.showWalletPicker(store, wallets);
    }

    if (wallets.length === 1) {
      try {
        const walletPath = store.getWalletPath(wallets[0]);
        const info = this.tryConnectWallet(walletPath);
        if (info && this.walletManager.isConnected) {
          console.log(chalk.green(`\n  Wallet connected: ${wallets[0]}`));
          updateLastWallet(wallets[0]);
          return { ...info, name: wallets[0] };
        }
      } catch {
        console.log(chalk.dim(`\n  Wallet "${wallets[0]}" could not be loaded.`));
      }
    }

    // No wallets — first-time setup
    return this.showFirstTimeWalletSetup(store);
  }

  /** Pick from multiple saved wallets by number. */
  private async showWalletPicker(store: WalletStore, wallets: string[]): Promise<{ address: string; name: string } | null> {
    console.log('');
    console.log(chalk.bold('  Select wallet:'));
    console.log('');
    for (let i = 0; i < wallets.length; i++) {
      console.log(`    ${chalk.cyan(String(i + 1) + ')')} ${wallets[i]}`);
    }
    console.log('');
    console.log(`    ${chalk.cyan('0)')} Import new wallet`);
    console.log(`    ${chalk.dim('q)')} Exit`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim().toLowerCase();

      if (choice === 'q') return null;

      if (choice === '0') {
        const importedName = await this.handleWalletImportFlow(store);
        if (importedName) return { address: this.walletManager.address!, name: importedName };
        continue;
      }

      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < wallets.length) {
        try {
          const walletPath = store.getWalletPath(wallets[idx]);
          const info = this.tryConnectWallet(walletPath);
          if (info) {
            store.setDefault(wallets[idx]);
            console.log(chalk.green(`\n  Wallet connected: ${wallets[idx]}`));
            return { ...info, name: wallets[idx] };
          }
        } catch (error: unknown) {
          console.log(chalk.red(`  ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim(`  Enter 1-${wallets.length}, 0, or q.`));
      }
    }
  }

  /** First-time wallet setup — no saved wallets. */
  private async showFirstTimeWalletSetup(store: WalletStore): Promise<{ address: string; name: string } | null> {
    console.log('');
    console.log(chalk.bold('  Wallet Setup'));
    console.log(chalk.dim('  A wallet is required for live trading.'));
    console.log('');
    console.log(`    ${chalk.cyan('1)')} Import wallet (paste private key)`);
    console.log(`    ${chalk.cyan('2)')} Connect wallet file (JSON path)`);
    console.log(`    ${chalk.cyan('3)')} Exit`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1': {
          const importedName = await this.handleWalletImportFlow(store);
          if (importedName) return { address: this.walletManager.address!, name: importedName };
          continue;
        }

        case '2': {
          const connected = await this.handleWalletConnectFlow();
          if (connected) return { address: this.walletManager.address!, name: 'wallet' };
          continue;
        }

        case '3':
          return null;

        default:
          console.log(chalk.dim('  Enter 1, 2, or 3.'));
          continue;
      }
    }
  }

  // ─── Mode Banners ──────────────────────────────────────────────────

  private showSimulationBanner(): void {
    console.log('');
    console.log(chalk.yellow.bold('  ⚡ FLASH AI TERMINAL ⚡'));
    console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.bgYellow.black(' SIMULATION MODE '));
    console.log('');
    console.log(`  Balance: ${chalk.green('$' + this.flashClient.getBalance().toFixed(2))}`);
    console.log(chalk.dim('  Trades are simulated. No real transactions.'));
    console.log('');
    console.log(chalk.dim('  Type "help" for commands.'));
    console.log(chalk.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  private async showLiveBanner(walletName: string): Promise<void> {
    console.log('');
    console.log(chalk.red.bold('  ⚡ FLASH AI TERMINAL ⚡'));
    console.log(chalk.red('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.bgRed.white.bold(' LIVE TRADING MODE '));
    console.log('');
    console.log(`  Wallet:  ${chalk.cyan(walletName)}`);
    console.log(`  Network: ${chalk.bold(this.config.network)}`);

    try {
      const bal = await this.walletManager.getBalance();
      console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
    } catch {
      // silently ignore balance fetch errors at startup
    }

    console.log('');
    console.log(chalk.yellow('  WARNING'));
    console.log(chalk.dim('  Transactions executed here are real.'));
    console.log('');
    console.log(chalk.dim('  Type "help" for commands.'));
    console.log(chalk.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  // ─── Intelligence Screen ─────────────────────────────────────────

  private async showIntelligenceScreen(walletName: string | null): Promise<void> {
    const isSim = this.config.simulationMode;
    const modeColor = isSim ? chalk.yellow : chalk.red;
    const modeLabel = isSim ? 'SIMULATION' : 'LIVE TRADING';
    const modeBg = isSim ? chalk.bgYellow.black : chalk.bgRed.white.bold;

    // Header
    console.log('');
    console.log(modeColor.bold('  ⚡ FLASH AI TERMINAL ⚡'));
    console.log(modeColor('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(`  ${modeBg(` ${modeLabel} `)}`);
    console.log('');

    // Wallet / Balance
    if (isSim) {
      console.log(`  Balance: ${chalk.green('$' + this.flashClient.getBalance().toFixed(2))}`);
      console.log(chalk.dim('  Trades are simulated. No real transactions.'));
    } else if (walletName) {
      console.log(`  Wallet:  ${chalk.cyan(walletName)}`);
      console.log(`  Network: ${chalk.bold(this.config.network)}`);
      try {
        const bal = await this.walletManager.getBalance();
        console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
      } catch {
        // best-effort
      }
      console.log('');
      console.log(chalk.yellow('  WARNING'));
      console.log(chalk.dim('  Transactions executed here are real.'));
      console.log('');
      console.log(chalk.dim('  Flash Trade requires USDC collateral.'));
      console.log(chalk.dim('  Ensure your wallet holds USDC before opening positions.'));
      console.log(chalk.dim('  Run "wallet tokens" to check balances.'));
    }
    console.log('');

    console.log(chalk.dim('  Type "help" for commands, "scan" for opportunities.'));
    console.log(chalk.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  private async fetchIntelligence(): Promise<IntelligenceData | null> {
    const INTEL_TIMEOUT = 5_000; // 5s max for intelligence fetch

    return new Promise<IntelligenceData | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), INTEL_TIMEOUT);

      this.doFetchIntelligence()
        .then((data) => { clearTimeout(timer); resolve(data); })
        .catch(() => { clearTimeout(timer); resolve(null); });
    });
  }

  private async doFetchIntelligence(): Promise<IntelligenceData> {
    const inspector = getInspector(this.context);
    const snapshot = await inspector.getFullSnapshot();

    const data: IntelligenceData = {
      marketCount: snapshot.markets.length,
      positionCount: snapshot.positions.length,
      portfolioBalance: snapshot.portfolio.balance,
      totalPnl: snapshot.portfolio.totalUnrealizedPnl,
    };

    // Regime detection
    if (snapshot.markets.length > 0) {
      try {
        const rd = getRegimeDetector();
        const regimes = rd.detectAll(snapshot.markets, snapshot.volume, snapshot.openInterest);
        if (regimes.size > 0) {
          const counts = new Map<string, number>();
          for (const [, state] of regimes) {
            counts.set(state.regime, (counts.get(state.regime) ?? 0) + 1);
          }
          data.dominantRegime = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        }
      } catch {
        // regime detection is best-effort
      }
    }

    // Top opportunities via scanner
    try {
      const scanner = getScanner(this.context);
      const balance = this.flashClient.getBalance();
      const opps = await scanner.scan(balance, 3);
      if (opps.length > 0) {
        data.opportunities = opps.map((o) => ({
          market: o.market,
          direction: o.direction,
          confidence: o.confidence,
          regime: o.regime,
        }));
      }
    } catch {
      // scanner is best-effort
    }

    return data;
  }

  private renderIntelligence(intel: IntelligenceData): void {
    console.log(chalk.bold('  Market Intelligence'));
    console.log(chalk.dim('  ─────────────────────────────────────────'));
    console.log('');

    // Regime
    if (intel.dominantRegime) {
      console.log(`  Regime:    ${this.colorRegime(intel.dominantRegime)}`);
    } else {
      console.log(chalk.dim('  Regime:    Data unavailable'));
    }

    // Coverage
    console.log(`  Markets:   ${chalk.bold(String(intel.marketCount))} scanned`);
    console.log('');

    // Top Opportunities
    if (intel.opportunities && intel.opportunities.length > 0) {
      console.log(chalk.bold('  Top Opportunities'));
      for (let i = 0; i < intel.opportunities.length; i++) {
        const o = intel.opportunities[i];
        const dir = o.direction === 'long'
          ? chalk.green('LONG ')
          : chalk.red('SHORT');
        const conf = `${(o.confidence * 100).toFixed(0)}%`;
        console.log(`    ${i + 1}. ${o.market.padEnd(6)} ${dir}  ${conf}`);
      }
    } else {
      console.log(chalk.bold('  Top Opportunities'));
      console.log(chalk.dim('    No clear signals detected.'));
    }
    console.log('');

    // Portfolio summary (only if positions exist)
    if (intel.positionCount > 0) {
      console.log(chalk.bold('  Portfolio'));
      console.log(`    Positions: ${intel.positionCount}  PnL: ${intel.totalPnl >= 0 ? chalk.green(formatUsd(intel.totalPnl)) : chalk.red(formatUsd(intel.totalPnl))}`);
      console.log('');
    }
  }

  private colorRegime(regime: string): string {
    switch (regime) {
      case MarketRegime.TRENDING: return chalk.green(regime);
      case MarketRegime.RANGING: return chalk.blue(regime);
      case MarketRegime.HIGH_VOLATILITY: return chalk.red(regime);
      case MarketRegime.LOW_VOLATILITY: return chalk.gray(regime);
      case MarketRegime.WHALE_DOMINATED: return chalk.magenta(regime);
      case MarketRegime.LOW_LIQUIDITY: return chalk.yellow(regime);
      default: return chalk.gray(regime);
    }
  }

  // ─── Wallet Flows ──────────────────────────────────────────────────

  /** Try to connect a wallet from a file path. Returns info on success, null on failure. */
  private tryConnectWallet(path: string): { address: string } | null {
    try {
      const result = this.walletManager.loadFromFile(path);
      return { address: result.address };
    } catch (error: unknown) {
      console.log(chalk.red(`  Failed to load wallet: ${getErrorMessage(error)}`));
      return null;
    }
  }

  /** Blocking question prompt. */
  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, resolve);
    });
  }

  /**
   * Read a line of input with echo disabled.
   * Uses a temporary readline with no output to guarantee zero echo,
   * plus ANSI hide sequences as a belt-and-suspenders safeguard.
   */
  private readHidden(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.pause();

      process.stdout.write(prompt);

      // ANSI escape: hide text (makes any echoed chars invisible)
      process.stdout.write('\x1B[8m');

      // Create a temporary readline with no output stream — guarantees no echo
      const hiddenRl = createInterface({
        input: process.stdin,
        output: undefined,
        terminal: false,
      });

      hiddenRl.once('line', (line) => {
        hiddenRl.close();

        // ANSI escape: reveal text (restore normal display)
        process.stdout.write('\x1B[28m');
        process.stdout.write('\n');

        this.rl.resume();
        resolve(line.trim());
      });

      // Handle Ctrl+C / stream close
      hiddenRl.once('close', () => {
        process.stdout.write('\x1B[28m');
        process.stdout.write('\n');
        this.rl.resume();
        resolve('');
      });
    });
  }

  /**
   * Interactive wallet import: prompts for name and private key,
   * accepts base58 string, JSON array, or file path.
   * Stores to ~/.flash/wallets/ and connects.
   */
  private async handleWalletImportFlow(store: WalletStore): Promise<string | null> {
    console.log('');

    const name = (await this.ask(`  ${chalk.yellow('Wallet name:')} `)).trim();
    if (!name) {
      console.log(chalk.red('  Wallet name cannot be empty.'));
      return null;
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
      return null;
    }

    console.log('');
    console.log(chalk.dim('  Paste your private key (base58 or JSON array)'));
    console.log(chalk.dim('  or enter path to wallet JSON file.'));
    console.log(chalk.dim('  Input is hidden for security.'));
    const keyInput = await this.readHidden(`  ${chalk.yellow('>')} `);

    if (!keyInput) {
      console.log(chalk.red('  No input provided.'));
      return null;
    }

    let secretKey: number[] | undefined;
    const trimmed = keyInput.trim();

    // Try JSON array first (e.g. [1,2,3,...])
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          secretKey = parsed as number[];
        }
      } catch {
        // Not valid JSON array
      }
    }

    // Try as a file path (e.g. ~/.config/solana/id.json)
    if (!secretKey && (trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.startsWith('.'))) {
      try {
        const expandedPath = trimmed.startsWith('~')
          ? join(homedir(), trimmed.slice(1))
          : resolve(trimmed);

        // Security: restrict file reads to home directory (same as walletManager)
        const home = homedir();
        const homePrefix = home.endsWith('/') ? home : home + '/';
        if (expandedPath !== home && !expandedPath.startsWith(homePrefix)) {
          console.log(chalk.red('  Wallet path must be within home directory.'));
        } else if (existsSync(expandedPath)) {
          // Resolve symlinks to prevent traversal
          const { realpathSync: realpath } = await import('fs');
          const realPath = realpath(expandedPath);
          if (realPath !== home && !realPath.startsWith(homePrefix)) {
            console.log(chalk.red('  Wallet path resolves outside home directory (symlink?).'));
          } else {
            // Reject suspiciously large files (keypair JSON should be < 1KB)
            const { statSync: stat } = await import('fs');
            const fileSize = stat(realPath).size;
            if (fileSize > 1024) {
              console.log(chalk.red(`  File too large (${fileSize} bytes). Expected a keypair JSON.`));
            } else {
              const raw = readFileSync(realPath, 'utf-8');
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                secretKey = parsed as number[];
              }
            }
          }
        }
      } catch {
        // Not a valid file
      }
    }

    // Try base58 decode (Phantom/Solflare export format)
    if (!secretKey) {
      try {
        const bs58 = await import('bs58');
        const decoded = bs58.default.decode(trimmed);
        if (decoded.length === 64) {
          secretKey = Array.from(decoded);
        } else {
          console.log(chalk.red(`  Invalid key length: expected 64 bytes, got ${decoded.length}.`));
          return null;
        }
      } catch {
        console.log(chalk.red('  Invalid key format.'));
        console.log(chalk.dim('  Accepted: base58 string, JSON array [1,2,...], or file path.'));
        return null;
      }
    }

    try {
      const result = store.importWallet(name, secretKey!);
      store.setDefault(name);

      // Connect the wallet
      this.walletManager.loadFromFile(result.path);

      console.log('');
      console.log(chalk.green(`  Wallet "${name}" imported successfully`));
      console.log('');

      return name;
    } catch (error: unknown) {
      console.log(chalk.red(`  Import failed: ${getErrorMessage(error)}`));
      return null;
    } finally {
      if (secretKey) {
        secretKey.fill(0);
      }
    }
  }

  /**
   * Interactive wallet connect: prompts for keypair file path,
   * validates, and connects.
   */
  private async handleWalletConnectFlow(): Promise<boolean> {
    console.log('');

    console.log(chalk.dim('  Enter path to your Solana wallet JSON file'));
    console.log(chalk.dim('  Example: ~/.config/solana/id.json'));
    const rawPath = (await this.ask(`  ${chalk.yellow('Path:')} `)).trim();
    if (!rawPath) {
      console.log(chalk.red('  No path provided.'));
      return false;
    }

    // Expand ~ to home directory
    const expandedPath = rawPath.startsWith('~')
      ? join(homedir(), rawPath.slice(1))
      : resolve(rawPath);

    if (!existsSync(expandedPath)) {
      console.log(chalk.red(`  File not found: ${expandedPath}`));
      return false;
    }

    const info = this.tryConnectWallet(expandedPath);
    if (!info) return false;

    console.log(chalk.green(`  Connected: ${info.address}`));

    // Show balance
    try {
      const bal = await this.walletManager.getBalance();
      console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
    } catch {
      // Balance fetch is best-effort at setup
    }

    console.log('');
    return true;
  }

  // ─── Wallet Disconnect (Mode-Locked) ──────────────────────────────

  /**
   * Handle wallet disconnect in live mode.
   * Mode stays locked — only disables trading capability.
   */
  private handleWalletDisconnected(): void {
    // Stop autopilot if running
    try {
      const autopilot = getAutopilot(this.context);
      if (autopilot.state.active) {
        autopilot.stop();
        console.log(chalk.yellow('  Autopilot stopped due to wallet disconnect.'));
      }
    } catch {
      // No autopilot instance — fine
    }

    // Do NOT change mode — mode is locked for the session
    // Trading commands will fail naturally since wallet is disconnected
  }

  /**
   * Handle wallet reconnected in live mode.
   * Reinitialize the live client with the new wallet.
   */
  private async handleWalletReconnected(): Promise<void> {
    // Only relevant in live mode — rebuild client with new wallet
    if (this.config.simulationMode) return;

    const connection = this.rpcManager.connection;

    try {
      const { FlashClient } = await import('../client/flash-client.js');
      this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      this.context.flashClient = this.flashClient;
      this.context.walletAddress = this.walletManager.address ?? 'unknown';
      // walletName is preserved from initial setup
    } catch (error: unknown) {
      console.log(chalk.red(`  Failed to reinitialize live client: ${getErrorMessage(error)}`));
      console.log(chalk.dim('  Trading commands may fail until a wallet is reconnected.'));
      return;
    }

    // Update reconciler with new client
    const reconciler = getReconciler();
    if (reconciler) {
      reconciler.setClient(this.flashClient);
      reconciler.reconcile().catch(() => {});
    }

    // Rebuild tool engine with updated context
    this.engine = new ToolEngine(this.context);
  }

  // ─── Prompt ────────────────────────────────────────────────────────

  /** Update prompt prefix based on current mode */
  private updatePrompt(): void {
    const prefix = this.config.simulationMode
      ? chalk.yellow('flash [sim]')
      : chalk.red('flash [live]');
    this.rl.setPrompt(`${prefix} > `);
  }

  // ─── History ───────────────────────────────────────────────────────

  /** Load command history from file */
  private loadHistory(): void {
    try {
      const data = readFileSync(HISTORY_FILE, 'utf-8');
      const lines = data.split('\n').filter(Boolean).slice(-MAX_HISTORY);
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        rlAny.history = lines.reverse();
      }
    } catch {
      // No history file yet
    }
  }

  /** Save command history to file */
  private saveHistory(): void {
    try {
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        const lines = [...rlAny.history].reverse().slice(-MAX_HISTORY);
        writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
      }
    } catch {
      // Best-effort
    }
  }

  // ─── Shutdown ──────────────────────────────────────────────────────

  private isShuttingDown = false;

  private shutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.saveHistory();
    try {
      const autopilot = getAutopilot(this.context);
      if (autopilot.state.active) autopilot.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (this.riskMonitorCleanup) this.riskMonitorCleanup();
    } catch {
      // Best-effort cleanup
    }
    try {
      const reconciler = getReconciler();
      if (reconciler) reconciler.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownPlugins().catch(() => {});
    } catch {
      // Best-effort cleanup
    }
    try {
      this.rpcManager?.stopMonitoring();
    } catch {
      // Best-effort cleanup
    }
    console.log(chalk.dim('\n  Goodbye.\n'));
    this.rl.close();
    process.exit(0);
  }

  // ─── Command Handler ──────────────────────────────────────────────

  private async handleInput(input: string): Promise<void> {
    const startTime = Date.now();

    // Fast dispatch for single-token commands
    let intent: ParsedIntent;
    const lower = input.toLowerCase();
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) {
      intent = fastIntent;
    } else if (lower.startsWith('dryrun ') || lower.startsWith('dry-run ') || lower.startsWith('dry run ')) {
      const prefix = lower.startsWith('dryrun ') ? 'dryrun ' : lower.startsWith('dry-run ') ? 'dry-run ' : 'dry run ';
      const innerCmd = input.slice(prefix.length).trim();
      intent = { action: ActionType.DryRun, innerCommand: innerCmd } as ParsedIntent;
    } else if (lower.startsWith('inspect pool ')) {
      const pool = input.slice('inspect pool '.length).trim();
      intent = { action: ActionType.InspectPool, pool } as ParsedIntent;
    } else if (lower.startsWith('inspect market ')) {
      const market = input.slice('inspect market '.length).trim().toUpperCase();
      intent = { action: ActionType.InspectMarket, market } as ParsedIntent;
    } else if (lower.startsWith('tx inspect ')) {
      const signature = input.slice('tx inspect '.length).trim();
      intent = { action: ActionType.TxInspect, signature } as ParsedIntent;
    } else {
      // Full interpreter path (regex + AI)
      process.stdout.write(chalk.dim('  Parsing...\r'));
      try {
        intent = await withTimeout(
          this.interpreter.parseIntent(input),
          COMMAND_TIMEOUT_MS,
          'parsing',
        );
        process.stdout.write('              \r');
      } catch (error: unknown) {
        console.log(chalk.red(`  Parse error: ${getErrorMessage(error)}`));
        return;
      }
    }

    // ─── Market Monitor Intercept ────────────────────────────────────
    if (intent.action === ActionType.MarketMonitor) {
      await this.handleMarketMonitor();
      return;
    }

    // ─── Dry Run Intercept ──────────────────────────────────────────
    if (intent.action === ActionType.DryRun && 'innerCommand' in intent) {
      await this.handleDryRun(intent.innerCommand as string);
      return;
    }

    // Execute tool
    process.stdout.write(chalk.dim('  Executing...\r'));

    let result: ToolResult;
    try {
      result = await withTimeout(
        this.engine.dispatch(intent),
        COMMAND_TIMEOUT_MS,
        'execution',
      );
      process.stdout.write('               \r');
    } catch (error: unknown) {
      console.log(chalk.red(`  Execution error: ${getErrorMessage(error)}`));
      return;
    }

    // Display result
    console.log(result.message);

    // Handle wallet disconnect — mode stays locked
    if (result.data?.disconnected) {
      this.handleWalletDisconnected();
    }

    // Handle wallet reconnected in live mode — rebuild client
    if (result.data?.walletConnected && !this.config.simulationMode) {
      await this.handleWalletReconnected();
    }

    // Handle confirmation flow
    if (result.requiresConfirmation && result.data?.executeAction) {
      const confirmed = await this.confirm(result.confirmationPrompt ?? 'Confirm?');
      if (confirmed) {
        console.log(chalk.dim('  Submitting transaction...'));

        try {
          const submitStart = Date.now();
          const execResult = await withTimeout(
            result.data.executeAction(),
            COMMAND_TIMEOUT_MS,
            'transaction',
          );
          const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
          console.log(chalk.green(`  Confirmed in ${elapsed}s`));
          console.log(execResult.message);

          // Post-trade verification (live mode only)
          if (!this.config.simulationMode && execResult.data?.market && execResult.data?.side) {
            const rec = getReconciler();
            if (rec) {
              const verified = await rec.verifyTrade(
                execResult.data.market as string,
                execResult.data.side as string,
              );
              if (!verified) {
                console.log(chalk.yellow('  ⚠ Position not yet found on-chain. It may take a moment to settle.'));
              }
            }
          }
        } catch (error: unknown) {
          console.log(chalk.red(`  ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
    }

    // Slow command warning
    const elapsed = Date.now() - startTime;
    if (elapsed > SLOW_COMMAND_MS) {
      console.log(chalk.dim(`  [${(elapsed / 1000).toFixed(1)}s]`));
    }
  }

  // ─── Dry Run Handler ─────────────────────────────────────────────

  /**
   * Handle market monitor — live-updating market table.
   * Refreshes every 5 seconds. Press any key to exit.
   */
  private async handleMarketMonitor(): Promise<void> {
    const { PriceService } = await import('../data/prices.js');
    const priceSvc = new PriceService();
    const { POOL_MARKETS } = await import('../config/index.js');

    // Collect all unique market symbols
    const allSymbols = [...new Set(Object.values(POOL_MARKETS).flat().map(s => s.toUpperCase()))];

    let running = true;

    const render = async () => {
      const [priceMap, oi] = await Promise.all([
        priceSvc.getPrices(allSymbols).catch(() => new Map()),
        this.fstats.getOpenInterest().catch(() => ({ markets: [] })),
      ]);

      // Build rows only for markets with live price data
      const rows: { symbol: string; price: number; change: number; totalOi: number; longPct: number; shortPct: number }[] = [];

      for (const sym of allSymbols) {
        const tp = priceMap.get(sym);
        if (!tp) continue;
        const oiEntry = oi.markets.find(m => m.market.toUpperCase().includes(sym));
        const longOi = oiEntry?.longOi ?? 0;
        const shortOi = oiEntry?.shortOi ?? 0;
        const totalOi = longOi + shortOi;
        const longPct = totalOi > 0 ? Math.round((longOi / totalOi) * 100) : 50;
        const shortPct = totalOi > 0 ? 100 - longPct : 50;
        rows.push({ symbol: sym, price: tp.price, change: tp.priceChange24h, totalOi, longPct, shortPct });
      }

      // Sort by total OI descending (most active markets first)
      rows.sort((a, b) => b.totalOi - a.totalOi);

      // Clear screen and render
      process.stdout.write('\x1B[2J\x1B[H');
      const now = new Date().toLocaleTimeString();
      console.log('');
      console.log(chalk.bold.yellow('  MARKET MONITOR'));
      console.log(chalk.dim(`  ${now}  |  Refreshing every 5s  |  Press any key to exit`));
      console.log(chalk.dim('  ' + '─'.repeat(68)));
      console.log('');

      // Header
      const hdr = [
        chalk.bold('  Asset'.padEnd(12)),
        chalk.bold('Price'.padStart(12)),
        chalk.bold('24h Change'.padStart(12)),
        chalk.bold('Open Interest'.padStart(15)),
        chalk.bold('Long / Short'.padStart(14)),
      ].join('  ');
      console.log(hdr);
      console.log(chalk.dim('  ' + '─'.repeat(68)));

      if (rows.length === 0) {
        console.log(chalk.dim('\n  Waiting for price data...\n'));
      } else {
        for (const r of rows) {
          const sym = chalk.bold(('  ' + r.symbol).padEnd(12));
          const price = formatPrice(r.price).padStart(12);
          const change = colorPercent(r.change).padStart(12);
          const oiStr = formatUsd(r.totalOi).padStart(15);
          const ratio = `${r.longPct} / ${r.shortPct}`.padStart(14);
          const ratioColored = r.longPct > 60 ? chalk.green(ratio) : r.shortPct > 60 ? chalk.red(ratio) : chalk.gray(ratio);
          console.log(`${sym}  ${price}  ${change}  ${oiStr}  ${ratioColored}`);
        }
      }

      console.log('');
    };

    // Initial render
    try {
      await render();
    } catch {
      console.log(chalk.red('  Failed to fetch market data.'));
      return;
    }

    // Set up refresh interval
    const interval = setInterval(async () => {
      if (!running) return;
      try {
        await render();
      } catch {
        // Silently skip failed refreshes
      }
    }, 5_000);
    interval.unref();

    // Wait for any keypress to exit
    await new Promise<void>((resolve) => {
      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onKey = () => {
        running = false;
        clearInterval(interval);
        process.stdin.removeListener('data', onKey);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }
        // Clear screen and return to prompt
        process.stdout.write('\x1B[2J\x1B[H');
        console.log(chalk.dim('  Market monitor stopped.\n'));
        resolve();
      };

      process.stdin.on('data', onKey);
    });
  }

  /**
   * Handle dry-run commands.
   * Parses the inner command, builds a transaction preview, and displays it.
   * SAFETY: No transaction is ever signed or sent.
   */
  private async handleDryRun(innerCommand: string): Promise<void> {
    // Parse the inner command using the interpreter
    process.stdout.write(chalk.dim('  Parsing inner command...\r'));
    let innerIntent: ParsedIntent;
    try {
      innerIntent = await withTimeout(
        this.interpreter.parseIntent(innerCommand),
        COMMAND_TIMEOUT_MS,
        'dryrun-parse',
      );
      process.stdout.write('                           \r');
    } catch (error: unknown) {
      console.log(chalk.red(`  Failed to parse inner command: ${getErrorMessage(error)}`));
      return;
    }

    // Only trade actions are supported for dry-run
    if (innerIntent.action !== ActionType.OpenPosition) {
      console.log('');
      console.log(chalk.yellow('  Dry run currently supports open position commands only.'));
      console.log('');
      console.log(chalk.dim('  Usage:'));
      console.log(chalk.dim('    dryrun open 2x long SOL $10'));
      console.log(chalk.dim('    dryrun open 5x short BTC $100'));
      console.log('');
      return;
    }

    if (innerIntent.action !== ActionType.OpenPosition) return;
    const { market, side, collateral, leverage, collateral_token } = innerIntent;

    process.stdout.write(chalk.dim('  Building transaction preview...\r'));

    try {
      if (!this.flashClient.previewOpenPosition) {
        console.log(chalk.red('  Dry run not available for this client.'));
        return;
      }

      const preview = await withTimeout(
        this.flashClient.previewOpenPosition(market, side, collateral, leverage, collateral_token),
        COMMAND_TIMEOUT_MS,
        'dryrun-preview',
      );
      process.stdout.write('                                   \r');
      this.renderDryRunPreview(preview);
    } catch (error: unknown) {
      process.stdout.write('                                   \r');
      console.log(chalk.red(`  Dry run failed: ${getErrorMessage(error)}`));
    }
  }

  /** Render a dry-run transaction preview. */
  private renderDryRunPreview(preview: DryRunPreview): void {
    const sideColor = preview.side === TradeSide.Long ? chalk.green : chalk.red;
    const sideStr = preview.side === TradeSide.Long ? 'LONG' : 'SHORT';

    console.log('');
    console.log(chalk.bold.cyan('  TRANSACTION PREVIEW (DRY RUN)'));
    console.log(chalk.dim('  ────────────────────────────────────────'));
    console.log('');

    // Trade parameters
    console.log(chalk.bold('  Trade Parameters'));
    console.log(`    Market:         ${chalk.bold(preview.market)}`);
    console.log(`    Side:           ${sideColor(sideStr)}`);
    console.log(`    Collateral:     ${chalk.bold('$' + preview.collateral.toFixed(2))}`);
    console.log(`    Leverage:       ${chalk.bold(preview.leverage + 'x')}`);
    console.log(`    Position Size:  ${chalk.bold('$' + preview.positionSize.toFixed(2))}`);
    console.log('');
    console.log(`    Entry Price:    $${preview.entryPrice.toFixed(preview.entryPrice < 1 ? 6 : 2)}`);
    console.log(`    Liq. Price:     ${chalk.red('$' + preview.liquidationPrice.toFixed(preview.liquidationPrice < 1 ? 6 : 2))}`);
    console.log(`    Est. Fee:       $${preview.estimatedFee.toFixed(4)}`);

    // Solana transaction info (live mode only)
    if (preview.programId) {
      console.log('');
      console.log(chalk.dim('  ────────────────────────────────────────'));
      console.log(chalk.bold('  Solana Transaction'));
      console.log(`    Program:        ${chalk.dim(preview.programId)}`);
      console.log(`    Accounts:       ${preview.accountCount}`);
      console.log(`    Instructions:   ${preview.instructionCount}`);
      console.log(`    Tx Size:        ${preview.transactionSize} bytes`);
      console.log(`    CU Budget:      ${preview.estimatedComputeUnits?.toLocaleString()}`);
    }

    // Simulation results
    if (preview.simulationSuccess !== undefined) {
      console.log('');
      console.log(chalk.dim('  ────────────────────────────────────────'));
      console.log(chalk.bold('  Simulation Result'));

      if (preview.simulationSuccess) {
        console.log(`    Status:         ${chalk.green('SUCCESS')}`);
        if (preview.simulationUnitsConsumed) {
          console.log(`    CU Consumed:    ${preview.simulationUnitsConsumed.toLocaleString()}`);
        }
      } else {
        console.log(`    Status:         ${chalk.red('FAILED')}`);
        if (preview.simulationError) {
          console.log(`    Error:          ${chalk.red(preview.simulationError)}`);
        }
      }

      // Show program logs (truncated)
      if (preview.simulationLogs && preview.simulationLogs.length > 0) {
        console.log('');
        console.log(chalk.bold('  Program Logs'));
        const maxLogs = 15;
        const logs = preview.simulationLogs.slice(0, maxLogs);
        for (const log of logs) {
          // Highlight program invocations and errors
          if (log.includes('invoke')) {
            console.log(`    ${chalk.cyan(log)}`);
          } else if (log.includes('error') || log.includes('Error') || log.includes('failed')) {
            console.log(`    ${chalk.red(log)}`);
          } else if (log.includes('success')) {
            console.log(`    ${chalk.green(log)}`);
          } else {
            console.log(`    ${chalk.dim(log)}`);
          }
        }
        if (preview.simulationLogs.length > maxLogs) {
          console.log(chalk.dim(`    ... ${preview.simulationLogs.length - maxLogs} more log lines`));
        }
      }
    }

    console.log('');
    console.log(chalk.dim('  ────────────────────────────────────────'));
    console.log(chalk.yellow.bold('  No transaction was signed or sent.'));
    console.log('');
  }

  /** Confirmation via pendingConfirmation callback */
  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      process.stdout.write(`  ${chalk.yellow(prompt)} ${chalk.dim('(yes/no)')} `);
      this.pendingConfirmation = (answer) => {
        resolve(
          answer.toLowerCase() === 'yes' ||
          answer.toLowerCase() === 'y'
        );
      };
    });
  }
}

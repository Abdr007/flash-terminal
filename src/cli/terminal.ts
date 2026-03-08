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
import { initLogger, getLogger } from '../utils/logger.js';
import { getAutopilot, setAiApiKey, getInspector, getScanner, getRegimeDetector } from '../agent/agent-tools.js';
import { formatUsd, formatPrice, colorPercent } from '../utils/format.js';
import { MarketRegime } from '../regime/regime-types.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { RpcManager, buildRpcEndpoints, initRpcManager } from '../network/rpc-manager.js';
import { initSystemDiagnostics } from '../system/system-diagnostics.js';
import { initReconciler, getReconciler } from '../core/state-reconciliation.js';
import { loadPlugins, shutdownPlugins } from '../plugins/plugin-loader.js';
import { StatusBar } from './status-bar.js';
import { runDoctor } from '../tools/doctor.js';
import { startWatch } from './watch.js';
import { theme } from './theme.js';
import { completer, getSuggestions } from './completer.js';

/** Resolve common market name aliases to canonical Flash Trade symbols */
const MARKET_ALIASES: Record<string, string> = {
  JITO: 'JTO', RAYDIUM: 'RAY', KAMINO: 'KMNO',
  METAPLEX: 'MET', SOLANA: 'SOL', BITCOIN: 'BTC',
  ETHEREUM: 'ETH', ETHER: 'ETH', GOLD: 'XAU',
  SILVER: 'XAG', CRUDE: 'CRUDEOIL', OIL: 'CRUDEOIL',
  'CRUDE OIL': 'CRUDEOIL',
  PENGUIN: 'PENGU', ZCASH: 'ZEC', EURO: 'EUR',
  POUND: 'GBP', STERLING: 'GBP', YEN: 'USDJPY',
  YUAN: 'USDCNH', HYPERLIQUID: 'HYPE', PUMPFUN: 'PUMP',
};

function resolveMarketAlias(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  // Try exact match first (handles multi-word like "CRUDE OIL")
  if (MARKET_ALIASES[upper]) return MARKET_ALIASES[upper];
  // Try with spaces removed (e.g. "crude oil" → "CRUDEOIL")
  const collapsed = upper.replace(/\s+/g, '');
  if (MARKET_ALIASES[collapsed]) return MARKET_ALIASES[collapsed];
  return collapsed;
}

/**
 * Normalize user input: collapse whitespace, trim, strip trailing punctuation.
 * Does NOT lowercase — callers decide casing.
 */
function normalizeInput(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')  // strip control chars
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .replace(/[.!?]+$/, '');             // strip trailing punctuation
}

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
  /** Suppress repeated "Please wait" messages during a single command */
  private processingWarnShown = false;
  /** Cleanup callback for risk monitor on shutdown */
  private riskMonitorCleanup: (() => void) | null = null;
  /** RPC manager for failover support */
  private rpcManager!: RpcManager;
  /** Live status bar */
  private statusBar: StatusBar | null = null;
  /** Last executed command text (for context line) */
  private lastCommand = '';
  /** Last command execution time in ms (for context line) */
  private lastCommandMs = 0;

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
      console.log(chalk.yellow('\n  AI features disabled — no API key configured.'));
      console.log(chalk.dim('  Set ANTHROPIC_API_KEY or GROQ_API_KEY in .env to enable AI analysis.'));
      this.interpreter = new OfflineInterpreter();
    }
  }

  async start(): Promise<void> {
    // Create readline early — needed for prompts
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: MAX_HISTORY,
      completer,
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
        console.log(chalk.cyan(`\n  ℹ RPC failover triggered → ${ep.label}`));
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
    if (this.config.noPlugins) {
      console.log(chalk.dim('  Plugins disabled (--no-plugins).'));
    } else {
      try {
        const pluginTools = await loadPlugins(this.context);
        if (pluginTools.length > 0) {
          for (const tool of pluginTools) {
            this.engine.registerTool(tool);
          }
          console.log(chalk.yellow('  Plugins loaded with full system access.'));
          console.log(chalk.dim('  Only install plugins from trusted sources. Use --no-plugins to disable.'));
        }
      } catch {
        // Plugin loading is non-critical
      }
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

    // Log startup readiness (structured, for operational visibility)
    {
      const logger = getLogger();
      logger.info('STARTUP', 'Terminal ready', {
        mode: this.config.simulationMode ? 'simulation' : 'live',
        wallet: walletInfo?.address ?? 'none',
        rpc: this.rpcManager.activeEndpoint.label,
        backupRpcs: this.rpcManager.fallbackCount,
        plugins: this.config.noPlugins ? 'disabled' : 'enabled',
      });
    }

    // ─── Display Intelligence Screen ─────────────────────────────────
    await this.showIntelligenceScreen(walletInfo?.name ?? null);

    // ─── Start Status Bar ─────────────────────────────────────────────
    this.statusBar = new StatusBar(this.rl, this.flashClient, this.rpcManager, {
      simulationMode: this.config.simulationMode,
      walletName: walletInfo?.name ?? (this.config.simulationMode ? 'paper' : 'N/A'),
    });
    this.statusBar.start();

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
        if (!this.processingWarnShown) {
          this.processingWarnShown = true;
          console.log(chalk.dim('  Please wait for the current command to finish.'));
        }
        return;
      }

      this.processing = true;
      this.processingWarnShown = false;
      this.statusBar?.suspend();
      const cmdStart = Date.now();
      try {
        await this.handleInput(trimmed);
      } catch (error: unknown) {
        console.log(chalk.red(`  ✖ Error: ${getErrorMessage(error)}`));
      } finally {
        this.processing = false;
        this.processingWarnShown = false;
        this.lastCommand = trimmed;
        this.lastCommandMs = Date.now() - cmdStart;
        this.renderExecutionTimer();
        this.statusBar?.resume();
        this.saveHistory();
        this.rl.prompt();
      }
    });

    this.rl.prompt();
  }

  // ─── Welcome Screen ────────────────────────────────────────────────

  private async showModeSelection(): Promise<'live' | 'simulation' | 'exit'> {
    console.log('');
    console.log(`  ${theme.accentBold('FLASH AI TERMINAL')}`);
    console.log(`  ${theme.separator(32)}`);
    console.log('');
    console.log(theme.dim('  AI Trading Interface for Flash Trade'));
    console.log('');
    console.log(theme.dim('  Real-time market intelligence and trading tools'));
    console.log(theme.dim('  powered by live blockchain data.'));
    console.log('');
    console.log(theme.section('  Select Mode'));
    console.log('');
    console.log(`    ${theme.command('1)')} ${theme.section('LIVE TRADING')}`);
    console.log(theme.dim('       Execute real transactions on Flash Trade.'));
    console.log('');
    console.log(`    ${theme.command('2)')} ${theme.section('SIMULATION')}`);
    console.log(theme.dim('       Test strategies using paper trading.'));
    console.log('');
    console.log(`    ${theme.command('3)')} ${theme.dim('Exit')}`);
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

    // No wallets saved — first-time setup
    if (wallets.length === 0) {
      return this.showFirstTimeWalletSetup(store);
    }

    // Auto-set default if there's exactly one wallet saved
    if (!defaultWallet && wallets.length === 1) {
      store.setDefault(wallets[0]);
      defaultWallet = wallets[0];
    }

    // Check session for previous wallet
    const targetWallet = defaultWallet ?? sessionWallet;

    // Wallets exist — show saved wallets menu
    if (targetWallet && wallets.includes(targetWallet)) {
      return this.showSavedWalletsMenu(store, wallets, targetWallet);
    }

    // Wallets exist but no target — go straight to picker
    return this.showWalletPicker(store, wallets);
  }

  /**
   * Show the saved wallets menu when wallets already exist.
   * Options: use previous, select another, import new, create new.
   */
  private async showSavedWalletsMenu(
    store: WalletStore,
    wallets: string[],
    targetWallet: string,
  ): Promise<{ address: string; name: string } | null> {
    console.log('');
    console.log(chalk.bold('  Saved Wallets'));
    console.log(chalk.dim('  ────────────'));
    console.log('');
    console.log(`    ${chalk.cyan('1)')} Use previous wallet ${chalk.dim(`(${targetWallet})`)}`);
    console.log(`    ${chalk.cyan('2)')} Select another saved wallet`);
    console.log(`    ${chalk.cyan('3)')} Import new wallet`);
    console.log(`    ${chalk.cyan('4)')} Create new wallet`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1': {
          // Reconnect previous wallet
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
          // Fall through to picker on failure
          return this.showWalletPicker(store, wallets);
        }

        case '2': {
          // Show wallet picker (excludes the target wallet from being auto-selected)
          return this.showWalletPicker(store, wallets);
        }

        case '3': {
          // Import new wallet
          const importedName = await this.handleWalletImportFlow(store);
          if (importedName) return { address: this.walletManager.address!, name: importedName };
          continue;
        }

        case '4': {
          // Create new wallet
          const created = await this.handleWalletCreateFlow(store);
          if (created) return created;
          continue;
        }

        default:
          console.log(chalk.dim('  Enter 1, 2, 3, or 4.'));
          continue;
      }
    }
  }

  /** Pick from multiple saved wallets by number. */
  private async showWalletPicker(store: WalletStore, wallets: string[]): Promise<{ address: string; name: string } | null> {
    console.log('');
    console.log(chalk.bold('  Select wallet:'));
    console.log('');
    for (let i = 0; i < wallets.length; i++) {
      try {
        const addr = store.getAddress(wallets[i]);
        console.log(`    ${chalk.cyan(String(i + 1) + ')')} ${wallets[i]} ${chalk.dim(`(${shortAddress(addr)})`)}`);
      } catch {
        console.log(`    ${chalk.cyan(String(i + 1) + ')')} ${wallets[i]}`);
      }
    }
    console.log('');
    console.log(`    ${chalk.cyan('i)')} Import new wallet`);
    console.log(`    ${chalk.cyan('c)')} Create new wallet`);
    console.log(`    ${chalk.dim('q)')} Exit`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim().toLowerCase();

      if (choice === 'q') return null;

      if (choice === 'i') {
        const importedName = await this.handleWalletImportFlow(store);
        if (importedName) return { address: this.walletManager.address!, name: importedName };
        continue;
      }

      if (choice === 'c') {
        const created = await this.handleWalletCreateFlow(store);
        if (created) return created;
        continue;
      }

      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < wallets.length) {
        try {
          const walletPath = store.getWalletPath(wallets[idx]);
          const info = this.tryConnectWallet(walletPath);
          if (info) {
            store.setDefault(wallets[idx]);
            updateLastWallet(wallets[idx]);
            console.log(chalk.green(`\n  Wallet connected: ${wallets[idx]}`));
            return { ...info, name: wallets[idx] };
          }
        } catch (error: unknown) {
          console.log(chalk.red(`  ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim(`  Enter 1-${wallets.length}, i, c, or q.`));
      }
    }
  }

  /** First-time wallet setup — no saved wallets. */
  private async showFirstTimeWalletSetup(store: WalletStore): Promise<{ address: string; name: string } | null> {
    console.log('');
    console.log(chalk.bold('  Wallet Setup'));
    console.log(chalk.dim('  ────────────'));
    console.log('');
    console.log(chalk.dim('  A wallet is required for live trading.'));
    console.log('');
    console.log(`    ${chalk.cyan('1)')} Create new wallet`);
    console.log(`    ${chalk.cyan('2)')} Import wallet file`);
    console.log(`    ${chalk.cyan('3)')} Connect existing Solana keypair`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1': {
          const created = await this.handleWalletCreateFlow(store);
          if (created) return created;
          continue;
        }

        case '2': {
          const importedName = await this.handleWalletImportFlow(store);
          if (importedName) return { address: this.walletManager.address!, name: importedName };
          continue;
        }

        case '3': {
          const connected = await this.handleWalletConnectFlow();
          if (connected) return { address: this.walletManager.address!, name: 'wallet' };
          continue;
        }

        default:
          console.log(chalk.dim('  Enter 1, 2, or 3.'));
          continue;
      }
    }
  }

  /**
   * Create a new Solana wallet, save it, and connect.
   */
  private async handleWalletCreateFlow(store: WalletStore): Promise<{ address: string; name: string } | null> {
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

    try {
      const { Keypair } = await import('@solana/web3.js');
      const keypair = Keypair.generate();
      const secretKeyArray = Array.from(keypair.secretKey);
      const address = keypair.publicKey.toBase58();

      const result = store.importWallet(name, secretKeyArray);
      store.setDefault(name);

      // Connect the wallet
      this.walletManager.loadFromFile(result.path);
      updateLastWallet(name);

      // Zero sensitive data
      secretKeyArray.fill(0);

      console.log('');
      console.log(chalk.green(`  Wallet "${name}" created successfully`));
      console.log(`  Address: ${chalk.cyan(address)}`);
      console.log('');
      console.log(chalk.bold('  Wallet stored at:'));
      console.log(chalk.dim(`    ~/.flash/wallets/${name}.json`));
      console.log('');
      console.log(chalk.yellow.bold('  Security Tips'));
      console.log(chalk.dim('    Keep this file private'));
      console.log(chalk.dim('    Back up this file securely'));
      console.log(chalk.dim('    Loss of this file means permanent loss of funds'));
      console.log(chalk.dim('    Never share your wallet file with anyone'));
      console.log(chalk.dim('    Consider using a hardware wallet for large balances'));
      console.log('');
      console.log(chalk.dim('  Fund this wallet with SOL (for fees) and USDC (for collateral).'));
      console.log('');

      return { address, name };
    } catch (error: unknown) {
      console.log(chalk.red(`  Create failed: ${getErrorMessage(error)}`));
      return null;
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
    const walletAddr = this.walletManager.address;
    console.log(`  Wallet:  ${chalk.cyan(walletName)}`);
    if (walletAddr) {
      console.log(`  Address: ${chalk.dim(shortAddress(walletAddr))}`);
    }
    console.log(`  Network: ${chalk.bold(this.config.network)}`);
    console.log('');

    let usdcBal: number | null = null;
    try {
      const tokenData = await this.walletManager.getTokenBalances();
      console.log(`  SOL Balance:  ${chalk.green(tokenData.sol.toFixed(4))} SOL`);
      const usdcToken = tokenData.tokens.find(
        (t) => t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      );
      usdcBal = usdcToken?.amount ?? 0;
      const usdcColor = usdcBal > 0 ? chalk.green : chalk.yellow;
      console.log(`  USDC Balance: ${usdcColor(usdcBal.toFixed(2))} USDC`);
    } catch {
      try {
        const bal = await this.walletManager.getBalance();
        console.log(`  SOL Balance: ${chalk.green(bal.toFixed(4))} SOL`);
      } catch {
        // best-effort
      }
    }

    console.log('');
    if (usdcBal !== null && usdcBal === 0) {
      console.log(chalk.yellow('  Flash Trade requires USDC collateral to open positions.'));
      console.log(chalk.dim('  Run "wallet tokens" to view all token balances.'));
      console.log('');
    }
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
    const modeLabel = isSim ? 'SIMULATION' : 'LIVE TRADING';
    const modeBg = isSim ? theme.simBadge : theme.liveBadge;

    // Header
    console.log('');
    console.log(`  ${theme.accentBold('FLASH AI TERMINAL')}`);
    console.log(`  ${theme.separator(32)}`);
    console.log('');
    console.log(`  ${modeBg(modeLabel)}`);
    console.log('');

    // Wallet / Balance
    if (isSim) {
      console.log(theme.pair('Balance', theme.positive('$' + this.flashClient.getBalance().toFixed(2))));
      console.log(theme.dim('  Trades are simulated. No real transactions.'));
    } else if (walletName) {
      const walletAddr = this.walletManager.address;
      console.log(theme.pair('Wallet', theme.accent(walletName)));
      if (walletAddr) {
        console.log(theme.pair('Address', theme.dim(walletAddr)));
      }
      console.log(theme.pair('Network', theme.value(this.config.network)));
      console.log('');

      // Fetch SOL + USDC balances
      let solBal: number | null = null;
      let usdcBal: number | null = null;
      try {
        const tokenData = await this.walletManager.getTokenBalances();
        solBal = tokenData.sol;
        const usdcToken = tokenData.tokens.find(
          (t) => t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        );
        usdcBal = usdcToken?.amount ?? 0;
      } catch {
        try {
          solBal = await this.walletManager.getBalance();
        } catch {
          // best-effort
        }
      }

      if (solBal !== null) {
        console.log(theme.pair('SOL Balance', theme.positive(solBal.toFixed(4) + ' SOL')));
      }
      if (usdcBal !== null) {
        const val = usdcBal > 0 ? theme.positive(usdcBal.toFixed(2) + ' USDC') : theme.warning(usdcBal.toFixed(2) + ' USDC');
        console.log(theme.pair('USDC Balance', val));
      }

      console.log('');
      if (usdcBal !== null && usdcBal === 0) {
        console.log(theme.warning('  Flash Trade requires USDC collateral to open positions.'));
        console.log(theme.dim('  Run "wallet tokens" to view all token balances.'));
        console.log('');
      }
      console.log(theme.warning('  WARNING'));
      console.log(theme.dim('  Transactions executed here are real.'));
    }
    console.log('');

    // ─── Quick Start Hints ───────────────────────────────────────
    console.log(theme.section('  Quick Start'));
    console.log(`    ${theme.command('help')}           List all commands`);
    console.log(`    ${theme.command('scan')}           Find trading opportunities`);
    console.log(`    ${theme.command('monitor')}        Live market monitoring`);
    console.log(`    ${theme.command('wallet tokens')}  View token balances`);
    console.log(`    ${theme.command('markets')}        View available markets`);
    console.log('');
    console.log(theme.dim('  Type "exit" to close the terminal.'));
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

    // Reject excessively long input (keypairs are ~88 chars base58 or ~200 chars JSON)
    if (keyInput.length > 2048) {
      console.log(chalk.red('  Input too long. Expected a keypair (base58, JSON array, or file path).'));
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
      console.log(chalk.bold('  Wallet stored at:'));
      console.log(chalk.dim(`    ~/.flash/wallets/${name}.json`));
      console.log('');
      console.log(chalk.yellow.bold('  Security Tips'));
      console.log(chalk.dim('    Keep this file private'));
      console.log(chalk.dim('    Back up this file securely'));
      console.log(chalk.dim('    Loss of this file means permanent loss of funds'));
      console.log(chalk.dim('    Never share your wallet file with anyone'));
      console.log(chalk.dim('    Consider using a hardware wallet for large balances'));
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
      ? theme.warning('flash') + theme.dim(' [sim]')
      : theme.negative('flash') + theme.dim(' [live]');
    this.rl.setPrompt(`${prefix} ${theme.accent('>')} `);
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

  // [M-7] Sensitive command patterns — scrubbed from history file to prevent info leak
  private static readonly SENSITIVE_HISTORY_PATTERN = /^(wallet\s+(import|connect)\s|open\s|close\s|add\s+collateral|remove\s+collateral)/i;

  /** Save command history to file — scrubs sensitive trade/wallet commands */
  private saveHistory(): void {
    try {
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        const lines = [...rlAny.history]
          .filter(line => !FlashTerminal.SENSITIVE_HISTORY_PATTERN.test(line))
          .reverse().slice(-MAX_HISTORY);
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

    const logger = getLogger();
    logger.info('SHUTDOWN', 'Graceful shutdown initiated', {
      mode: this.config.simulationMode ? 'simulation' : 'live',
      uptime: Math.floor(process.uptime()),
    });

    this.saveHistory();
    try {
      if (this.statusBar) this.statusBar.stop();
    } catch {
      // Best-effort cleanup
    }
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
    // Flush shutdown log synchronously before exit
    logger.flushSync('SHUTDOWN', 'Shutdown complete', {
      uptime: Math.floor(process.uptime()),
    });

    console.log(chalk.dim('\n  Goodbye.\n'));
    this.rl.close();
    process.exit(0);
  }

  // ─── Command Handler ──────────────────────────────────────────────

  private async handleInput(rawInput: string): Promise<void> {
    const startTime = Date.now();
    const input = normalizeInput(rawInput);
    if (!input) return;

    const lower = input.toLowerCase();

    // ─── Doctor Diagnostic Intercept ───────────────────────────────
    if (lower === 'doctor' || lower === 'flash doctor') {
      const output = await runDoctor(
        this.flashClient,
        this.rpcManager,
        this.walletManager,
        this.context,
      );
      console.log(output);
      return;
    }

    // ─── Watch Mode Intercept ────────────────────────────────────
    if (lower.startsWith('watch ') && lower !== 'watch') {
      const innerCmd = input.slice('watch '.length).trim();
      if (innerCmd) {
        await startWatch(innerCmd, {
          engine: this.engine,
          parseCommand: (cmd: string) => this.resolveIntent(cmd),
          rl: this.rl,
        });
        return;
      }
    }

    // Fast dispatch for single-token commands
    let intent: ParsedIntent;
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) {
      intent = fastIntent;
    } else if (this.showUsageHint(lower)) {
      return;
    } else if (lower.startsWith('dryrun ') || lower.startsWith('dry-run ') || lower.startsWith('dry run ')) {
      const prefix = lower.startsWith('dryrun ') ? 'dryrun ' : lower.startsWith('dry-run ') ? 'dry-run ' : 'dry run ';
      const innerCmd = input.slice(prefix.length).trim();
      intent = { action: ActionType.DryRun, innerCommand: innerCmd } as ParsedIntent;
    } else if (lower.startsWith('inspect pool ')) {
      const poolInput = input.slice('inspect pool '.length).trim();
      const { POOL_NAMES } = await import('../config/index.js');
      // Case-insensitive pool name matching
      const pool = POOL_NAMES.find((p: string) => p.toLowerCase() === poolInput.toLowerCase());
      if (!pool) {
        console.log(chalk.red(`  Unknown pool: ${poolInput}`));
        console.log(chalk.dim(`  Valid pools: ${POOL_NAMES.join(', ')}`));
        return;
      }
      intent = { action: ActionType.InspectPool, pool } as ParsedIntent;
    } else if (lower.startsWith('inspect market ') || (lower.startsWith('inspect ') && !lower.startsWith('inspect pool ') && !lower.startsWith('inspect protocol') && lower !== 'inspect')) {
      // Handle both "inspect market crude oil" and "inspect crude oil"
      const prefix = lower.startsWith('inspect market ') ? 'inspect market ' : 'inspect ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        console.log(chalk.red(`  Unknown market: ${market}`));
        return;
      }
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
        console.log(chalk.red(`  ✖ Parse error: ${getErrorMessage(error)}`));
        return;
      }
    }

    // ─── Unknown Command Intercept ──────────────────────────────────
    // If the interpreter returned Help (meaning it couldn't parse the input),
    // and the user didn't explicitly type "help", show an unknown command message.
    if (intent.action === ActionType.Help && !fastIntent) {
      // Try position-aware suggestions first
      let positions: { market: string; side: string; sizeUsd: number }[] | undefined;
      try {
        const posList = await this.flashClient.getPositions();
        positions = posList.map(p => ({
          market: p.market ?? '',
          side: p.side ?? '',
          sizeUsd: p.sizeUsd ?? 0,
        })).filter(p => p.market && p.side);
      } catch {
        // Non-critical — proceed without position context
      }

      const suggestion = getSuggestions(input, positions);
      if (suggestion) {
        console.log('');
        console.log(theme.warning(`  Unknown command: ${input}`));
        console.log(suggestion);
        return;
      }

      console.log('');
      console.log(theme.warning(`  Unknown command: ${input}`));
      console.log('');
      console.log(theme.section('  Try'));
      console.log(`    ${theme.command('help')}       List all commands`);
      console.log(`    ${theme.command('scan')}       Find trading opportunities`);
      console.log(`    ${theme.command('markets')}    View available markets`);
      console.log(`    ${theme.command('positions')}  View open positions`);
      console.log(`    ${theme.command('monitor')}    Live market monitoring`);
      console.log('');
      console.log(theme.dim('  You can also type natural language, e.g. "what is the price of SOL?"'));
      console.log('');
      return;
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

    // ─── Auto-Detect Position Side ─────────────────────────────────
    // When close/add/remove has a market but no side, auto-detect from open positions
    const intentAny = intent as Record<string, unknown>;
    const needsSide = (
      intent.action === ActionType.ClosePosition ||
      intent.action === ActionType.AddCollateral ||
      intent.action === ActionType.RemoveCollateral
    ) && intentAny.market && !intentAny.side;

    if (needsSide) {
      const mkt = String(intentAny.market).toUpperCase();
      try {
        const posList = await this.flashClient.getPositions();
        const matching = posList.filter(p =>
          (p.market ?? '').toUpperCase() === mkt,
        );
        if (matching.length === 1) {
          intent = { ...intent, side: matching[0].side } as ParsedIntent;
        } else if (matching.length === 0) {
          console.log(theme.warning(`  No open position found for ${mkt}.`));
          return;
        } else {
          const sides = matching.map(p => p.side?.toLowerCase()).join(' and ');
          console.log(theme.warning(`  Multiple ${mkt} positions open (${sides}).`));
          console.log(theme.dim(`  Please specify the side, e.g. "${input} long" or "${input} short"`));
          return;
        }
      } catch {
        console.log(theme.warning(`  Could not detect position side. Please specify long or short.`));
        return;
      }
    }

    // ─── Pre-Trade Safety Checks (live mode only) ─────────────────
    const isTradeAction = [
      ActionType.OpenPosition,
      ActionType.ClosePosition,
      ActionType.AddCollateral,
      ActionType.RemoveCollateral,
    ].includes(intent.action);

    if (isTradeAction && !this.config.simulationMode) {
      // Feature 1: RPC health check before trades
      const health = await this.rpcManager.checkHealth(this.rpcManager.activeEndpoint);
      if (!health.healthy || health.latencyMs > 3000 || (health.slotLag !== undefined && health.slotLag > 50)) {
        const reasons: string[] = [];
        if (!health.healthy) reasons.push('RPC unreachable');
        if (health.latencyMs > 3000) reasons.push(`latency ${health.latencyMs}ms`);
        if (health.slotLag !== undefined && health.slotLag > 50) reasons.push(`${health.slotLag} slots behind`);
        console.log(chalk.yellow(`\n  ⚠ RPC health warning: ${reasons.join(', ')}`));
        console.log(chalk.dim('    Trading may be unreliable. Proceed with caution.'));
        const proceed = await this.confirm('Continue anyway?');
        if (!proceed) {
          console.log(chalk.dim('  Cancelled.'));
          return;
        }
      }

      // Feature 2: Position verification before close/modify
      if (intent.action !== ActionType.OpenPosition && intentAny.market && intentAny.side) {
        const mkt = String(intentAny.market).toUpperCase();
        const sd = String(intentAny.side);
        try {
          const positions = await this.flashClient.getPositions();
          const found = positions.some(p =>
            (p.market ?? '').toUpperCase() === mkt && p.side === sd,
          );
          if (!found) {
            console.log(chalk.yellow('  ⚠ Position not confirmed on-chain yet. Waiting for state sync...'));
            // Trigger reconciliation and retry once
            const rec = getReconciler();
            if (rec) await rec.reconcile();
            const retry = await this.flashClient.getPositions();
            const retryFound = retry.some(p =>
              (p.market ?? '').toUpperCase() === mkt && p.side === sd,
            );
            if (!retryFound) {
              console.log(chalk.red(`  ✖ Position ${mkt} ${sd} not found after sync. Cannot proceed.`));
              return;
            }
            console.log(chalk.green('  Position verified after sync.'));
          }
        } catch {
          // Non-critical — let the trade tool handle it
        }
      }
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
      console.log(chalk.red(`  ✖ Execution error: ${getErrorMessage(error)}`));
      return;
    }

    // Display result with success/error indicator
    console.log(result.message);
    if (!result.requiresConfirmation) {
      this.printIndicator(result);
    }

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
          console.log(chalk.green(`  ✔ Confirmed in ${elapsed}s`));
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
          console.log(chalk.red(`  ✖ ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
    }
  }

  // ─── Execution Timer ─────────────────────────────────────────

  /**
   * Print a compact execution timer after each command.
   * Format: [153ms] or [7.4s]
   */
  private renderExecutionTimer(): void {
    if (!this.lastCommand || this.lastCommandMs < 1) return;

    // Skip for trivial commands
    const skip = ['help', 'commands', '?', 'exit', 'quit'];
    if (skip.includes(this.lastCommand.toLowerCase())) return;

    const timeStr = this.lastCommandMs >= 1000
      ? `${(this.lastCommandMs / 1000).toFixed(1)}s`
      : `${this.lastCommandMs}ms`;

    console.log(theme.dim(`  [${timeStr}]`));
  }

  // ─── Result Indicators ─────────────────────────────────────

  /**
   * Print a success/error/warning indicator after tool output.
   */
  private printIndicator(result: ToolResult): void {
    if (result.success === false) {
      // Only print indicator if the message doesn't already contain error styling
      if (result.message && !result.message.includes('✖')) {
        console.log(chalk.red('  ✖ Command failed'));
      }
    }
    // Success is implicit — clean output means success.
    // We don't print ✔ for every read-only command (positions, portfolio, etc.)
    // to avoid noise. The ✔ is reserved for trade confirmations (handled above).
  }

  // ─── Usage Hints ──────────────────────────────────────────────

  /**
   * Show usage hint for commands typed without required parameters.
   * Returns true if a hint was shown (caller should return early).
   */
  private showUsageHint(lower: string): boolean {
    const hints: Record<string, string[]> = {
      'open': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('open <leverage>x <long|short> <asset> $<collateral>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    open 5x long SOL $500'),
        chalk.dim('    open 3x short ETH $200'),
        chalk.dim('    open 10x long BTC $1000'),
        '',
      ],
      'close': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('close <asset> <long|short>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    close SOL long'),
        chalk.dim('    close ETH short'),
        '',
      ],
      'analyze': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('analyze <asset>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    analyze SOL'),
        chalk.dim('    analyze BTC'),
        chalk.dim('    analyze ETH'),
        '',
      ],
      'dryrun': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('dryrun <command>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    dryrun open 5x long SOL $500'),
        chalk.dim('    dryrun close ETH short'),
        '',
      ],
      'dry-run': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('dryrun <command>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    dryrun open 5x long SOL $500'),
        chalk.dim('    dryrun close ETH short'),
        '',
      ],
      'add': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('add $<amount> to <asset> <long|short>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    add $100 to SOL long'),
        chalk.dim('    add $50 to BTC short'),
        chalk.dim('    add $200 to ETH long'),
        '',
      ],
      'remove': [
        '',
        chalk.bold('  Usage'),
        `    ${chalk.cyan('remove $<amount> from <asset> <long|short>')}`,
        '',
        chalk.bold('  Examples'),
        chalk.dim('    remove $100 from SOL long'),
        chalk.dim('    remove $50 from BTC short'),
        '',
      ],
    };

    const hint = hints[lower];
    if (hint) {
      console.log(hint.join('\n'));
      return true;
    }
    return false;
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

      // Move cursor to top-left and clear from cursor to end of screen
      // This avoids the flicker caused by full screen clear (\x1B[2J)
      process.stdout.write('\x1B[H\x1B[J');
      const now = new Date().toLocaleTimeString();
      console.log('');
      console.log(`  ${theme.accentBold('MARKET MONITOR')}`);
      console.log(theme.dim(`  ${now}  |  Refresh 5s  |  Press any key to exit`));
      console.log(`  ${theme.separator(68)}`);
      console.log('');

      // Header
      const hdr = [
        theme.tableHeader('  Asset'.padEnd(12)),
        theme.tableHeader('Price'.padStart(12)),
        theme.tableHeader('24h Change'.padStart(12)),
        theme.tableHeader('Open Interest'.padStart(15)),
        theme.tableHeader('Long / Short'.padStart(14)),
      ].join('  ');
      console.log(hdr);
      console.log(`  ${theme.separator(68)}`);

      if (rows.length === 0) {
        console.log(theme.dim('\n  Waiting for price data...\n'));
      } else {
        for (const r of rows) {
          const sym = chalk.bold(('  ' + r.symbol).padEnd(12));
          const price = formatPrice(r.price).padStart(12);
          const change = colorPercent(r.change).padStart(12);
          const oiStr = formatUsd(r.totalOi).padStart(15);
          const ratio = `${r.longPct} / ${r.shortPct}`.padStart(14);
          const ratioColored = r.longPct > 60 ? theme.positive(ratio) : r.shortPct > 60 ? theme.negative(ratio) : theme.dim(ratio);
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
        process.stdout.write('\x1B[H\x1B[J');
        console.log(theme.dim('  Market monitor stopped.\n'));
        resolve();
      };

      process.stdin.on('data', onKey);
    });
  }

  /**
   * Resolve a raw command string into a ParsedIntent.
   * Reuses FAST_DISPATCH, inspect routing, and the AI interpreter.
   * Used by watch mode and dry-run to parse commands without executing them.
   */
  private async resolveIntent(input: string): Promise<ParsedIntent> {
    const lower = input.toLowerCase();
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) return fastIntent;

    if (lower.startsWith('inspect pool ')) {
      const pool = input.slice('inspect pool '.length).trim();
      return { action: ActionType.InspectPool, pool } as ParsedIntent;
    }

    if (lower.startsWith('inspect market ') || (lower.startsWith('inspect ') && !lower.startsWith('inspect pool ') && !lower.startsWith('inspect protocol') && lower !== 'inspect')) {
      const prefix = lower.startsWith('inspect market ') ? 'inspect market ' : 'inspect ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      return { action: ActionType.InspectMarket, market } as ParsedIntent;
    }

    // Fall through to interpreter
    return this.interpreter.parseIntent(input);
  }

  /**
   * Handle dry-run commands.
   * Parses the inner command, builds a transaction preview, and displays it.
   * SAFETY: No transaction is ever signed or sent.
   */
  private async handleDryRun(innerCommand: string): Promise<void> {
    // Normalize: if inner command doesn't start with an action keyword, prepend "open"
    // This handles natural language like "dryrun sol 2x long $500"
    const lowerInner = innerCommand.toLowerCase().trim();
    const actionKeywords = ['open', 'close', 'add', 'remove', 'long', 'short'];
    const hasAction = actionKeywords.some(k => lowerInner.startsWith(k));
    const normalizedCommand = hasAction ? innerCommand : `open ${innerCommand}`;

    // Parse the inner command using the interpreter
    process.stdout.write(chalk.dim('  Parsing inner command...\r'));
    let innerIntent: ParsedIntent;
    try {
      innerIntent = await withTimeout(
        this.interpreter.parseIntent(normalizedCommand),
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

    // Check if virtual market is currently open before building preview
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(market);
    if (!mktStatus.isOpen) {
      console.log(chalk.yellow(formatMarketClosedMessage(market)));
      return;
    }

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

  // [L-11] Confirmation timeout — cancel trade if user doesn't respond within 2 minutes
  private static readonly CONFIRM_TIMEOUT_MS = 120_000;

  /** Confirmation via pendingConfirmation callback — auto-cancels after timeout */
  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      process.stdout.write(`  ${chalk.yellow(prompt)} ${chalk.dim('(yes/no)')} `);
      const timeout = setTimeout(() => {
        this.pendingConfirmation = null;
        process.stdout.write(`\n  ${chalk.yellow('Confirmation timed out — trade cancelled.')}\n`);
        resolve(false);
      }, FlashTerminal.CONFIRM_TIMEOUT_MS);
      timeout.unref();
      this.pendingConfirmation = (answer) => {
        clearTimeout(timeout);
        resolve(
          answer.toLowerCase() === 'yes' ||
          answer.toLowerCase() === 'y'
        );
      };
    });
  }
}

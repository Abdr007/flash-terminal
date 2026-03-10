import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { AIInterpreter, OfflineInterpreter } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import { ToolContext, ToolResult, FlashConfig, IFlashClient, ActionType, ParsedIntent, DryRunPreview, TradeSide, Position } from '../types/index.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { PriceService } from '../data/prices.js';
import { WalletManager, createConnection } from '../wallet/index.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { getLastWallet, updateLastWallet } from '../wallet/session.js';
import { shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { initLogger, getLogger } from '../utils/logger.js';
import { setAiApiKey, getInspector, getRegimeDetector } from '../agent/agent-tools.js';
import { formatUsd, formatPrice, formatPercent, colorPercent, colorPnl, humanizeSdkError } from '../utils/format.js';
import { MarketRegime } from '../regime/regime-types.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { RpcManager, buildRpcEndpoints, initRpcManager } from '../network/rpc-manager.js';
import { initSystemDiagnostics } from '../system/system-diagnostics.js';
import { initReconciler, getReconciler } from '../core/state-reconciliation.js';
import { loadPlugins, shutdownPlugins } from '../plugins/plugin-loader.js';
import { StatusBar } from './status-bar.js';
import { runDoctor } from '../tools/doctor.js';
// watch.ts removed — monitor command replaces watch functionality
import { theme } from './theme.js';
import { completer, getSuggestions } from './completer.js';
import { buildFastDispatch } from './command-registry.js';
import { resolveMarket } from '../utils/market-resolver.js';
import { computeSimulationLiquidationPrice, isDivergenceOk } from '../utils/protocol-liq.js';

/** Alias for backward compat — delegates to centralized resolver */
function resolveMarketAlias(input: string): string {
  return resolveMarket(input);
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

/** Single-token fast dispatch — derived from command registry */
const FAST_DISPATCH = buildFastDispatch() as Record<string, ParsedIntent>;

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
  /** Buffer for input received while processing (e.g. pre-typed "y" for confirmation) */
  private bufferedLine: string | null = null;
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

    // Re-initialize signing guard with relaxed rate limits for simulation
    if (this.config.simulationMode) {
      initSigningGuard({
        maxCollateralPerTrade: this.config.maxCollateralPerTrade,
        maxPositionSize: this.config.maxPositionSize,
        maxLeverage: this.config.maxLeverage,
        maxTradesPerMinute: 60,
        minDelayBetweenTradesMs: 500,
      });
    }

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

    // Pause readline during initialization — prevents stray Enter keypresses
    // from being consumed and lost before the line handler is registered
    this.rl.pause();

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

    // Sync open positions into session history so CLOSE events have matching OPEN records
    const sessionTrades: import('../types/index.js').SessionTrade[] = [];
    try {
      const existingPositions = await Promise.race([
        this.flashClient.getPositions(),
        new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
      ]);
      for (const pos of existingPositions) {
        sessionTrades.push({
          action: 'open',
          market: pos.market,
          side: pos.side,
          leverage: pos.leverage,
          sizeUsd: pos.sizeUsd,
          entryPrice: pos.entryPrice,
          openFeePaid: pos.openFee > 0 ? pos.openFee : undefined,
          timestamp: pos.timestamp ? pos.timestamp * 1000 : Date.now(),
        });
      }
    } catch {
      // Non-critical: proceed with empty session history
    }

    // Build tool context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      degenMode: false,
      walletAddress: walletInfo?.address ?? this.flashClient.walletAddress ?? 'unknown',
      walletName: walletInfo?.name ?? '',
      walletManager: this.walletManager,
      sessionTrades,
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
    // Resume readline now that the line handler is about to be registered
    this.rl.resume();

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

      // Reset session idle timer on any user activity (not just trades)
      if (this.walletManager?.isConnected) {
        this.walletManager.resetIdleTimer();
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
        // Buffer input during processing so confirmation prompts can use it
        // (e.g. user pre-types "y" before the confirmation prompt appears)
        this.bufferedLine = trimmed;
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
        this.bufferedLine = null;
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
    console.log(`  ${theme.accentBold('FLASH TERMINAL')}`);
    console.log(`  ${theme.separator(32)}`);
    console.log('');
    console.log(theme.dim('  Trading Interface for Flash Trade'));
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
    console.log(chalk.yellow.bold('  ⚡ FLASH TERMINAL ⚡'));
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
    console.log(chalk.red.bold('  ⚡ FLASH TERMINAL ⚡'));
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
    console.log(`  ${theme.accentBold('FLASH TERMINAL')}`);
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

      // Fetch SOL + USDC balances with a tight timeout to avoid blocking startup
      let solBal: number | null = null;
      let usdcBal: number | null = null;
      try {
        const balancePromise = this.walletManager.getTokenBalances();
        const tokenData = await Promise.race([
          balancePromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]);
        if (tokenData) {
          solBal = tokenData.sol;
          const usdcToken = tokenData.tokens.find(
            (t) => t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          );
          usdcBal = usdcToken?.amount ?? 0;
        }
      } catch {
        // best-effort — skip balance display on failure
      }

      if (solBal !== null) {
        console.log(theme.pair('SOL Balance', theme.positive(solBal.toFixed(4) + ' SOL')));
      }
      if (usdcBal !== null) {
        const val = usdcBal > 0 ? theme.positive(usdcBal.toFixed(2) + ' USDC') : theme.warning(usdcBal.toFixed(2) + ' USDC');
        console.log(theme.pair('USDC Balance', val));
      }
      if (solBal === null && usdcBal === null) {
        console.log(theme.dim('  Run "wallet tokens" to view balances.'));
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
    console.log(`    ${theme.command('dashboard')}      Protocol & portfolio overview`);
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

    return data;
  }

  private renderIntelligence(intel: IntelligenceData): void {
    console.log(chalk.bold('  Market Overview'));
    console.log(chalk.dim('  ─────────────────────────────────────────'));
    console.log('');

    // Regime
    if (intel.dominantRegime) {
      console.log(`  Regime:    ${this.colorRegime(intel.dominantRegime)}`);
    } else {
      console.log(chalk.dim('  Regime:    Data unavailable'));
    }

    // Coverage
    console.log(`  Markets:   ${chalk.bold(String(intel.marketCount))} active`);
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

    // Re-register plugin tools lost during engine rebuild
    if (!this.config.noPlugins) {
      try {
        const { loadPlugins } = await import('../plugins/plugin-loader.js');
        const pluginTools = await loadPlugins(this.context);
        for (const tool of pluginTools) {
          this.engine.registerTool(tool);
        }
      } catch {
        // Non-critical — plugins may not be available
      }
    }
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
      // Flush price history to disk so 24h change persists across restarts
      new PriceService().flushHistory();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (this.statusBar) this.statusBar.stop();
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
    try {
      if (this.flashClient && 'stopBlockhashRefresh' in this.flashClient) {
        (this.flashClient as { stopBlockhashRefresh: () => void }).stopBlockhashRefresh();
      }
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
    if (lower === 'doctor') {
      const output = await runDoctor(
        this.flashClient,
        this.rpcManager,
        this.walletManager,
        this.context,
      );
      console.log(output);
      return;
    }

    // ─── Degen Mode Toggle ──────────────────────────────────────
    if (lower === 'degen' || lower === 'degen mode' || lower === 'degen on' || lower === 'degen off' || lower === 'degen toggle') {
      if (lower === 'degen off') {
        this.context.degenMode = false;
      } else if (lower === 'degen on') {
        this.context.degenMode = true;
      } else {
        this.context.degenMode = !this.context.degenMode;
      }
      if (this.context.degenMode) {
        // Show per-market leverage from protocol config
        const { hasDegenMode: hasDegen, getMaxLeverage: getMaxLev } = await import('../config/index.js');
        const { getAllMarkets: getAll } = await import('../config/index.js');
        // Degen-extended markets (SOL/BTC/ETH: 100x → 500x)
        const degenMarkets = getAll().filter(m => hasDegen(m));
        const degenInfo = degenMarkets.map(m => `${m} ${getMaxLev(m, true)}x`).join(', ');
        // High-leverage markets that already have ≥200x as standard (forex pairs)
        const highLevMarkets = getAll().filter(m => !hasDegen(m) && getMaxLev(m, false) >= 200);
        const highLevInfo = highLevMarkets.map(m => `${m} ${getMaxLev(m, false)}x`).join(', ');
        console.log('');
        console.log(chalk.red.bold('  ⚡ DEGEN MODE ENABLED'));
        if (degenInfo) {
          console.log(chalk.yellow(`  Degen markets: ${degenInfo}`));
        }
        if (highLevInfo) {
          console.log(chalk.yellow(`  High leverage: ${highLevInfo}`));
        }
        if (!degenInfo && !highLevInfo) {
          console.log(chalk.yellow('  No markets have extended leverage beyond standard limits.'));
        }
        console.log(chalk.dim('  Type "degen off" to disable'));
        console.log('');
      } else {
        console.log('');
        console.log(chalk.green('  Degen mode disabled — standard leverage limits active'));
        console.log('');
      }
      return;
    }

    // Fast dispatch for single-token commands
    let intent: ParsedIntent;
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) {
      intent = fastIntent;
    } else if (this.showUsageHint(lower)) {
      return;
    } else if (lower.startsWith('position debug ') || lower.startsWith('pos debug ')) {
      const prefix = lower.startsWith('position debug ') ? 'position debug ' : 'pos debug ';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        console.log(chalk.yellow(`  Usage: position debug <market>`));
        console.log(chalk.dim(`  Example: position debug sol`));
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      await this.handlePositionDebug(market);
      return;
    } else if (lower.startsWith('dryrun ') || lower.startsWith('dry-run ') || lower.startsWith('dry run ')) {
      const prefix = lower.startsWith('dryrun ') ? 'dryrun ' : lower.startsWith('dry-run ') ? 'dry-run ' : 'dry run ';
      const innerCmd = input.slice(prefix.length).trim();
      intent = { action: ActionType.DryRun, innerCommand: innerCmd } as ParsedIntent;
    } else if (lower.startsWith('analyze ') || lower.startsWith('analyse ')) {
      const prefix = lower.startsWith('analyze ') ? 'analyze ' : 'analyse ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.Analyze, market } as ParsedIntent;
    } else if (lower.startsWith('liquidations ') || lower.startsWith('liquidation ')) {
      const prefix = lower.startsWith('liquidations ') ? 'liquidations ' : 'liquidation ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.LiquidationMap, market } as ParsedIntent;
    } else if (lower.startsWith('funding ')) {
      const rawMarket = input.slice('funding '.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.FundingDashboard, market } as ParsedIntent;
    } else if (lower.startsWith('depth ')) {
      const rawMarket = input.slice('depth '.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.LiquidityDepth, market } as ParsedIntent;
    } else if (lower.startsWith('monitor ') || lower.startsWith('market monitor ')) {
      // Any monitor subcommand is no longer supported — only bare "monitor" works
      console.log(theme.dim('\n  Unknown command.\n'));
      return;
    } else if (lower === 'inspect pool' || lower.startsWith('inspect pool ')) {
      const poolInput = lower === 'inspect pool' ? '' : input.slice('inspect pool '.length).trim();
      const { POOL_NAMES } = await import('../config/index.js');
      if (!poolInput) {
        // Deduplicate pool names for display
        const uniqueNames = [...new Set(POOL_NAMES)];
        console.log(chalk.yellow(`  Usage: inspect pool <name>`));
        console.log(chalk.dim(`  Available pools: ${uniqueNames.join(', ')}`));
        return;
      }
      // Case-insensitive pool name matching
      const pool = POOL_NAMES.find((p: string) => p.toLowerCase() === poolInput.toLowerCase());
      if (!pool) {
        const uniqueNames = [...new Set(POOL_NAMES)];
        console.log(chalk.red(`  Unknown pool: ${poolInput}`));
        console.log(chalk.dim(`  Valid pools: ${uniqueNames.join(', ')}`));
        return;
      }
      intent = { action: ActionType.InspectPool, pool } as ParsedIntent;
    } else if (lower.startsWith('protocol fees ') || lower.startsWith('protocol fee ')) {
      const prefix = lower.startsWith('protocol fees ') ? 'protocol fees ' : 'protocol fee ';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        console.log(chalk.yellow('  Usage: protocol fees <market>  (e.g. protocol fees sol)'));
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        console.log(chalk.red(`  Unknown market: ${rawMarket}`));
        return;
      }
      await this.handleProtocolFees(market);
      return;
    } else if (lower.startsWith('source verify ') || lower.startsWith('verify source ')) {
      const prefix = lower.startsWith('source verify ') ? 'source verify ' : 'verify source ';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        console.log(chalk.yellow('  Usage: source verify <asset>  (e.g. source verify sol)'));
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        console.log(chalk.red(`  Unknown market: ${rawMarket}`));
        return;
      }
      await this.handleSourceVerify(market);
      return;
    } else if (lower === 'protocol verify' || lower === 'verify protocol' || lower === 'verify') {
      await this.handleProtocolVerify();
      return;
    } else if (lower.startsWith('inspect market ') || (lower.startsWith('inspect ') && !lower.startsWith('inspect pool') && !lower.startsWith('inspect protocol') && lower !== 'inspect')) {
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
    } else if (lower.startsWith('tx debug ')) {
      const rest = input.slice('tx debug '.length).trim();
      const showState = rest.includes('--state');
      const signature = rest.replace('--state', '').trim();
      intent = { action: ActionType.TxDebug, signature, showState } as ParsedIntent;
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
          if (execResult.success) {
            console.log(chalk.green(`  ✔ Confirmed in ${elapsed}s`));
          }
          console.log(execResult.message);

          // Post-trade verification (live mode only) — non-blocking
          if (!this.config.simulationMode && execResult.data?.market && execResult.data?.side) {
            const rec = getReconciler();
            if (rec) {
              rec.verifyTrade(
                execResult.data.market as string,
                execResult.data.side as string,
              ).then(verified => {
                if (!verified) {
                  console.log(chalk.yellow('  ⚠ Position not yet found on-chain. It may take a moment to settle.'));
                }
              }).catch(() => { /* non-critical background check */ });
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
   * Market monitor — professional full-screen market table with event velocity intelligence.
   * Uses diff-based rendering for flicker-free updates. Press 'q' to exit cleanly.
   *
   * Lifecycle:
   *   1. Isolate input (pause readline, set raw mode)
   *   2. Clear screen, show loading
   *   3. Fetch first dataset (block until data arrives)
   *   4. Render initial frame
   *   5. Start 5s refresh loop with diff rendering
   *   6. Exit cleanly on 'q'
   *
   * Data sources:
   *   Prices:        Pyth Hermes (same oracle as Flash protocol)
   *   Open Interest:  fstats API (aggregated Flash protocol state)
   */
  private async handleMarketMonitor(filterMarket?: string): Promise<void> {
    const { PriceService } = await import('../data/prices.js');
    const { TermRenderer } = await import('./renderer.js');
    const priceSvc = new PriceService();
    const { POOL_MARKETS } = await import('../config/index.js');

    // All unique market symbols from Flash SDK pool config
    let allSymbols = [...new Set(Object.values(POOL_MARKETS).flat().map(s => s.toUpperCase()))];
    if (filterMarket) {
      allSymbols = allSymbols.filter(s => s === filterMarket.toUpperCase());
    }

    let running = true;
    const REFRESH_MS = 5_000;
    const renderer = new TermRenderer();

    // ─── STEP 1: Isolate input BEFORE any rendering ──────────────
    this.rl.pause();
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Drain any buffered stdin (e.g. the Enter key from the command)
    // to prevent stale bytes from triggering the exit handler
    await new Promise<void>(resolve => {
      const drain = () => { /* discard */ };
      process.stdin.on('data', drain);
      setTimeout(() => {
        process.stdin.removeListener('data', drain);
        resolve();
      }, 50);
    });

    // ─── In-memory state for event detection ───────────────────────
    const prevPrices = new Map<string, number>();
    const prevOi = new Map<string, number>();
    const prevLongPct = new Map<string, number>();

    // Event thresholds — only fire on meaningful changes
    const PRICE_MOVE_PCT = 1.0;     // 1% price move between cycles
    const OI_CHANGE_USD = 10_000;   // $10k OI change between cycles
    const RATIO_SHIFT_PCT = 5;      // 5pp long/short ratio shift

    // ─── Rolling history buffer for velocity tracking ──────────────
    const HISTORY_DEPTH = 12;

    interface MarketSnapshot {
      timestamp: number;
      price: number;
      totalOi: number;
      longPct: number;
    }

    const marketHistory = new Map<string, MarketSnapshot[]>();

    const pushSnapshot = (sym: string, snap: MarketSnapshot) => {
      let buf = marketHistory.get(sym);
      if (!buf) {
        buf = [];
        marketHistory.set(sym, buf);
      }
      buf.push(snap);
      if (buf.length > HISTORY_DEPTH) {
        buf.splice(0, buf.length - HISTORY_DEPTH);
      }
    };

    const velocityLabel = (sym: string): string => {
      const buf = marketHistory.get(sym);
      if (!buf || buf.length < 2) return `${REFRESH_MS / 1000}s`;
      const elapsed = Math.round((buf[buf.length - 1].timestamp - buf[buf.length - 2].timestamp) / 1000);
      return `${elapsed > 0 ? elapsed : REFRESH_MS / 1000}s`;
    };

    interface MarketRow {
      symbol: string;
      price: number;
      change: number;
      totalOi: number;
      longPct: number;
      shortPct: number;
      priceDirection: 'up' | 'down' | 'flat';
    }

    interface MarketEvent {
      message: string;
      color: 'green' | 'red' | 'yellow';
      timestamp: number;
    }

    const MAX_EVENTS = 6;
    let recentEvents: MarketEvent[] = [];

    // ─── Telemetry state ────────────────────────────────────────────
    interface Telemetry {
      rpcLatencyMs: number;
      oracleLatencyMs: number;
      slot: number;
      slotLag: number;
      renderTimeMs: number;
    }
    let telemetry: Telemetry = { rpcLatencyMs: -1, oracleLatencyMs: -1, slot: -1, slotLag: -1, renderTimeMs: 0 };

    // Slot freeze detection — tracks consecutive cycles where slot doesn't advance
    let previousSlot = -1;
    let slotFreezeCount = 0;

    const fetchData = async (): Promise<MarketRow[]> => {
      const now = Date.now();

      // Measure oracle latency (prices) and fetch OI in parallel
      const oracleStart = performance.now();
      const [priceMap, oi] = await Promise.all([
        priceSvc.getPrices(allSymbols).catch(() => new Map()),
        this.fstats.getOpenInterest().catch(() => ({ markets: [] })),
      ]);
      telemetry.oracleLatencyMs = Math.round(performance.now() - oracleStart);

      // Measure RPC latency + get slot (lightweight — reuses cached values)
      if (this.rpcManager) {
        // If slot is unknown, trigger a health check to populate slot data
        if (this.rpcManager.activeSlot < 0) {
          await this.rpcManager.checkHealth(this.rpcManager.activeEndpoint).catch(() => {});
        }
        telemetry.rpcLatencyMs = this.rpcManager.activeLatencyMs;
        telemetry.slot = this.rpcManager.activeSlot;
        telemetry.slotLag = this.rpcManager.activeSlotLag;

        // Slot freeze detection
        if (telemetry.slot > 0) {
          if (telemetry.slot === previousSlot) {
            slotFreezeCount++;
          } else {
            slotFreezeCount = 0;
          }
          previousSlot = telemetry.slot;
        }
      }

      const rows: MarketRow[] = [];

      for (const sym of allSymbols) {
        const tp = priceMap.get(sym);
        if (!tp) continue;
        // Aggregate OI across all pool entries for this symbol
        let longOi = 0;
        let shortOi = 0;
        for (const oiEntry of oi.markets) {
          if (oiEntry.market.toUpperCase().includes(sym)) {
            longOi += oiEntry.longOi ?? 0;
            shortOi += oiEntry.shortOi ?? 0;
          }
        }
        const totalOi = longOi + shortOi;

        if (!filterMarket && totalOi <= 0) continue;

        const longPct = totalOi > 0 ? Math.round((longOi / totalOi) * 100) : 50;
        const shortPct = totalOi > 0 ? 100 - longPct : 50;

        const prev = prevPrices.get(sym);
        let priceDirection: 'up' | 'down' | 'flat' = 'flat';
        if (prev !== undefined) {
          if (tp.price > prev) priceDirection = 'up';
          else if (tp.price < prev) priceDirection = 'down';
        }

        // Event detection
        const vLabel = velocityLabel(sym);

        if (prev !== undefined && prev > 0) {
          const pricePctChange = ((tp.price - prev) / prev) * 100;
          if (Math.abs(pricePctChange) >= PRICE_MOVE_PCT) {
            const dir = pricePctChange > 0 ? '+' : '';
            recentEvents.push({
              message: `${sym} price moved ${dir}${pricePctChange.toFixed(2)}% (${vLabel})`,
              color: pricePctChange > 0 ? 'green' : 'red',
              timestamp: now,
            });
          }
        }

        const prevOiVal = prevOi.get(sym);
        if (prevOiVal !== undefined && prevOiVal > 0) {
          const oiDelta = totalOi - prevOiVal;
          if (Math.abs(oiDelta) >= OI_CHANGE_USD) {
            const dir = oiDelta > 0 ? '+' : '-';
            recentEvents.push({
              message: `${sym} OI ${dir}${formatUsd(Math.abs(oiDelta))} (${vLabel})`,
              color: oiDelta > 0 ? 'green' : 'yellow',
              timestamp: now,
            });
          }
        }

        const prevLong = prevLongPct.get(sym);
        if (prevLong !== undefined) {
          const shift = longPct - prevLong;
          if (Math.abs(shift) >= RATIO_SHIFT_PCT) {
            const desc = shift > 0 ? `longs +${shift}pp` : `shorts +${Math.abs(shift)}pp`;
            recentEvents.push({
              message: `${sym} ratio shifted: ${desc} (${vLabel})`,
              color: 'yellow',
              timestamp: now,
            });
          }
        }

        prevPrices.set(sym, tp.price);
        prevOi.set(sym, totalOi);
        prevLongPct.set(sym, longPct);
        pushSnapshot(sym, { timestamp: now, price: tp.price, totalOi, longPct });

        rows.push({ symbol: sym, price: tp.price, change: tp.priceChange24h, totalOi, longPct, shortPct, priceDirection });
      }

      if (recentEvents.length > MAX_EVENTS) {
        recentEvents = recentEvents.slice(-MAX_EVENTS);
      }

      rows.sort((a, b) => b.totalOi - a.totalOi);
      return rows;
    };

    const format1mMomentum = (sym: string): string | null => {
      const buf = marketHistory.get(sym);
      if (!buf || buf.length < 2) return null;

      const latest = buf[buf.length - 1];
      const oldest = buf[0];
      const elapsedSec = (latest.timestamp - oldest.timestamp) / 1000;
      if (elapsedSec < 10) return null;

      const priceDelta = oldest.price > 0
        ? ((latest.price - oldest.price) / oldest.price) * 100
        : 0;
      const oiDelta = latest.totalOi - oldest.totalOi;
      const ratioDelta = latest.longPct - oldest.longPct;

      const hasPriceMove = Math.abs(priceDelta) >= 0.1;
      const hasOiMove = Math.abs(oiDelta) >= 1000;
      const hasRatioMove = Math.abs(ratioDelta) >= 1;

      if (!hasPriceMove && !hasOiMove && !hasRatioMove) return null;

      const windowLabel = elapsedSec >= 55 ? '1m' : `${Math.round(elapsedSec)}s`;
      const parts: string[] = [];

      if (hasPriceMove) {
        const dir = priceDelta > 0 ? '+' : '';
        const pStr = `${dir}${priceDelta.toFixed(2)}%`;
        parts.push(priceDelta > 0 ? chalk.green(pStr) : chalk.red(pStr));
      }
      if (hasOiMove) {
        const dir = oiDelta > 0 ? '+' : '-';
        parts.push(chalk.cyan(`OI ${dir}${formatUsd(Math.abs(oiDelta))}`));
      }
      if (hasRatioMove) {
        const dir = ratioDelta > 0 ? `L+${ratioDelta}pp` : `S+${Math.abs(ratioDelta)}pp`;
        parts.push(chalk.yellow(dir));
      }

      return `  ${chalk.bold(sym.padEnd(6))} ${theme.dim(windowLabel.padEnd(4))} ${parts.join(theme.dim(' | '))}`;
    };

    /** Build frame — fits within terminal height, no scrolling */
    const buildFrame = (rows: MarketRow[]): string[] => {
      const termHeight = process.stdout.rows || 24;
      const now = new Date().toLocaleTimeString();

      // ── Telemetry status bar with health coloring ──
      const rpcMs = telemetry.rpcLatencyMs;
      const rpcStr = rpcMs < 0 ? theme.dim('RPC N/A')
        : rpcMs < 150 ? chalk.green(`RPC ${rpcMs}ms`)
        : rpcMs < 400 ? chalk.yellow(`RPC ${rpcMs}ms`)
        : chalk.red(`RPC ${rpcMs}ms`);

      const oMs = telemetry.oracleLatencyMs;
      const oracleStr = oMs < 0 ? theme.dim('Oracle N/A')
        : oMs <= 1000 ? chalk.green(`Oracle ${oMs}ms`)
        : chalk.red(`Oracle ${oMs}ms ⚠`);

      const slotStr = telemetry.slot < 0 ? theme.dim('Slot N/A')
        : slotFreezeCount >= 2 ? chalk.red(`Slot ${telemetry.slot} ⚠`)
        : chalk.green(`Slot ${telemetry.slot}`);

      const lag = telemetry.slotLag;
      const lagStr = lag < 0 ? theme.dim('Lag N/A')
        : lag === 0 ? chalk.green('Lag 0')
        : lag <= 5 ? chalk.yellow(`Lag ${lag}`)
        : chalk.red(`Lag ${lag}`);

      const renderStr = theme.dim(`Render ${telemetry.renderTimeMs}ms`);
      const refreshStr = theme.dim(`Refresh ${REFRESH_MS / 1000}s`);

      // Divergence status from protocol-liq module (sync — no await needed)
      const divStr = isDivergenceOk() ? chalk.green('Divergence OK') : chalk.yellow('Divergence ⚠');

      const telemetryLine = `  ${rpcStr}  ${theme.dim('|')}  ${oracleStr}  ${theme.dim('|')}  ${slotStr}  ${theme.dim('|')}  ${lagStr}  ${theme.dim('|')}  ${renderStr}  ${theme.dim('|')}  ${divStr}`;

      // Chrome: title(1) + telemetry(1) + time(1) + separator(1) + header(1) + separator(1) + footer separator(1) + source(1) = 8 fixed lines
      const CHROME_LINES = 8;
      const maxMarketRows = Math.max(5, termHeight - CHROME_LINES);
      const visibleRows = rows.slice(0, maxMarketRows);
      const truncated = rows.length > maxMarketRows;

      const hdr = [
        theme.tableHeader('  Asset'.padEnd(14)),
        theme.tableHeader('Price'.padStart(14)),
        theme.tableHeader('24h Change'.padStart(12)),
        theme.tableHeader('Open Interest'.padStart(16)),
        theme.tableHeader('Long / Short'.padStart(14)),
      ].join('');

      const lines: string[] = [
        `  ${theme.accentBold('FLASH TERMINAL')} ${theme.dim('—')} ${theme.accentBold('MARKET MONITOR')}`,
        telemetryLine,
        theme.dim(`  ${now}  |  Press ${chalk.bold('q')} to exit`),
        `  ${theme.separator(72)}`,
        hdr,
        `  ${theme.separator(72)}`,
      ];

      // Data rows
      for (const r of visibleRows) {
        const sym = chalk.bold(('  ' + r.symbol).padEnd(14));
        const priceStr = formatPrice(r.price).padStart(14);
        const coloredPrice = r.priceDirection === 'up'
          ? chalk.green(priceStr)
          : r.priceDirection === 'down'
            ? chalk.red(priceStr)
            : priceStr;
        const changeRaw = formatPercent(r.change).padStart(12);
        const change = r.change > 0 ? theme.positive(changeRaw) : r.change < 0 ? theme.negative(changeRaw) : theme.dim(changeRaw);
        const oiStr = formatUsd(r.totalOi).padStart(16);
        const ratio = `${r.longPct} / ${r.shortPct}`.padStart(14);
        const ratioColored = r.longPct > 60 ? theme.positive(ratio) : r.shortPct > 60 ? theme.negative(ratio) : theme.dim(ratio);
        lines.push(`${sym}${coloredPrice}${change}${oiStr}${ratioColored}`);
      }

      if (visibleRows.length === 0) {
        lines.push(theme.dim('  No active markets found.'));
      }
      if (truncated) {
        lines.push(theme.dim(`  ... +${rows.length - maxMarketRows} more (resize terminal to see all)`));
      }

      // Footer
      lines.push(`  ${theme.separator(72)}`);
      lines.push(theme.dim(`  Source: Pyth Hermes (oracle) | fstats (open interest)`));

      return lines;
    };

    // ─── STEP 2: Enter alternate screen and show loading ──────────
    renderer.enterAltScreen();
    renderer.clear();
    const loadingFrame = [
      '',
      `  ${theme.accentBold('FLASH TERMINAL')} ${theme.dim('—')} ${theme.accentBold('MARKET MONITOR')}`,
      '',
      theme.dim('  Loading market data...'),
      '',
    ];
    renderer.render(loadingFrame);

    // ─── STEP 3: Fetch first dataset (block until data arrives) ───
    let initialRows: MarketRow[];
    try {
      initialRows = await fetchData();
    } catch {
      renderer.leaveAltScreen();
      console.log(chalk.red('  Failed to fetch market data.'));
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw ?? false);
      }
      this.rl.resume();
      return;
    }

    // ─── STEP 4: Render initial frame (with data) ─────────────────
    renderer.clear();
    const renderStart0 = performance.now();
    const initialFrame = buildFrame(initialRows);
    renderer.render(initialFrame);
    telemetry.renderTimeMs = Math.round(performance.now() - renderStart0);

    // ─── STEP 5: Start refresh loop ──────────────────────────────
    let refreshInProgress = false;
    const interval = setInterval(async () => {
      if (!running || refreshInProgress) return;
      refreshInProgress = true;
      try {
        const rows = await fetchData();
        if (!running) return;
        const renderStart = performance.now();
        const frame = buildFrame(rows);
        // Skip render if nothing changed (diff check)
        if (renderer.hasChanged(frame)) {
          renderer.render(frame);
        }
        telemetry.renderTimeMs = Math.round(performance.now() - renderStart);
      } catch {
        // Skip failed refresh — keep last good render
      } finally {
        refreshInProgress = false;
      }
    }, REFRESH_MS);

    // ─── STEP 6: Exit on 'q' keypress ────────────────────────────
    await new Promise<void>((resolve) => {
      let exited = false;

      const cleanup = () => {
        if (exited) return;
        exited = true;

        process.stdin.removeListener('data', onKey);
        process.stdin.removeListener('error', onStdinError);
        process.stdin.removeListener('end', onStdinEnd);
        running = false;
        clearInterval(interval);

        // Leave alternate screen — restores original terminal content
        renderer.leaveAltScreen();
        renderer.reset();

        // Pause stdin FIRST to stop any further data events, then
        // switch out of raw mode so the 'q' keypress is not echoed
        // back into readline's buffer.
        process.stdin.pause();
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }

        // Drain any remaining stdin bytes before restoring readline.
        // Use a longer drain window to prevent the exit key from
        // leaking into the CLI prompt.
        const drainHandler = () => { /* discard */ };
        process.stdin.resume();
        process.stdin.on('data', drainHandler);
        setTimeout(() => {
          process.stdin.removeListener('data', drainHandler);
          process.stdin.pause();

          // Resume readline and clear any buffered partial line
          this.rl.resume();
          // Write an empty line reset to discard any leaked characters
          if (this.rl.terminal) {
            (this.rl as unknown as { line: string }).line = '';
            (this.rl as unknown as { cursor: number }).cursor = 0;
            this.rl.prompt();
          }
          resolve();
        }, 100);
      };

      const onKey = (buf: Buffer) => {
        const key = buf.toString();
        if (key !== 'q' && key !== 'Q' && key !== '\x03') return;
        cleanup();
      };

      const onStdinError = () => cleanup();
      const onStdinEnd = () => cleanup();

      process.stdin.on('data', onKey);
      process.stdin.on('error', onStdinError);
      process.stdin.on('end', onStdinEnd);
    });
  }

  /**
   * Position debug — protocol-level debugging view of an open position.
   *
   * Data sources:
   *   Position data:      Flash SDK perpClient.getUserPositions()
   *   Price data:         Pyth Hermes oracle (same as Flash protocol)
   *   Liquidation math:   Flash SDK getLiquidationPriceContractHelper()
   *   Fees/margin:        Flash SDK CustodyAccount (on-chain)
   *   Leverage limits:    Flash SDK PoolConfig MarketConfig
   */
  /**
   * Protocol fee verification — shows raw on-chain fee parameters from CustodyAccount.
   * Data source: CustodyAccount.fees.openPosition / closePosition via Flash SDK.
   */
  private async handleProtocolFees(market: string): Promise<void> {
    const upper = market.toUpperCase();
    const RATE_POWER = 1_000_000_000;
    const BPS_POWER = 10_000;

    console.log('');
    console.log(`  ${theme.accentBold(`FLASH PROTOCOL FEES — ${upper}`)}`);
    console.log(`  ${theme.separator(50)}`);
    console.log('');

    // Attempt on-chain fetch
    let rawOpen = 0;
    let rawClose = 0;
    let rawMaintenanceMargin = 0;
    let rawMaxLeverage = 0;
    let source = 'sdk-default';

    if (!this.config.simulationMode) {
      try {
        const { PoolConfig, CustodyAccount } = await import('flash-sdk');
        const { getPoolForMarket } = await import('../config/index.js');
        const poolName = getPoolForMarket(upper);
        if (poolName) {
          const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
          const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
          const custody = custodies.find(c => c.symbol.toUpperCase() === upper);
          const perpClient = (this.flashClient as any).perpClient;

          if (custody && perpClient?.program?.account?.custody) {
            const custodyData = await perpClient.program.account.custody.fetch(custody.custodyAccount);
            if (custodyData) {
              const custodyAcct = CustodyAccount.from(custody.custodyAccount, custodyData);
              rawOpen = parseFloat(custodyAcct.fees.openPosition.toString());
              rawClose = parseFloat(custodyAcct.fees.closePosition.toString());
              rawMaintenanceMargin = parseFloat((custodyAcct as any).pricing?.maintenanceMargin?.toString() ?? '0');
              const rawMaxLev = (custodyAcct as any).pricing?.maxLeverage;
              rawMaxLeverage = typeof rawMaxLev === 'object' && rawMaxLev?.toNumber
                ? rawMaxLev.toNumber()
                : typeof rawMaxLev === 'number' ? rawMaxLev : 0;
              source = 'on-chain';

              console.log(theme.pair('Source', chalk.green('CustodyAccount (on-chain)')));
              console.log(theme.pair('Custody', chalk.dim(custody.custodyAccount.toString())));
              console.log(theme.pair('Pool', chalk.dim(poolName)));
              console.log('');

              console.log(`  ${theme.section('Raw Values')}`);
              console.log(theme.pair('openPosition', rawOpen.toString()));
              console.log(theme.pair('closePosition', rawClose.toString()));
              console.log(theme.pair('maintenanceMargin', rawMaintenanceMargin.toString()));
              console.log(theme.pair('maxLeverage', rawMaxLeverage.toString()));
              console.log(theme.pair('RATE_POWER', RATE_POWER.toString()));
              console.log(theme.pair('BPS_POWER', BPS_POWER.toString()));
              console.log('');

              const openRate = rawOpen / RATE_POWER;
              const closeRate = rawClose / RATE_POWER;
              const maxLev = rawMaxLeverage > 0 ? rawMaxLeverage / BPS_POWER : 0;
              const derivedMarginRate = maxLev > 0 ? 1 / maxLev : 0;

              console.log(`  ${theme.section('Converted Rates')}`);
              console.log(theme.pair('openFeeRate', `${openRate} (${(openRate * 100).toFixed(4)}%)`));
              console.log(theme.pair('closeFeeRate', `${closeRate} (${(closeRate * 100).toFixed(4)}%)`));
              if (maxLev > 0) {
                console.log(theme.pair('maxLeverage', `${maxLev}x`));
                console.log(theme.pair('maintMarginRate', `1/${maxLev} = ${derivedMarginRate} (${(derivedMarginRate * 100).toFixed(4)}%)`));
              }
              console.log('');

              // Verify against getProtocolFeeRates
              const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
              const feeRates = await getProtocolFeeRates(upper, perpClient);
              console.log(`  ${theme.section('getProtocolFeeRates() Output')}`);
              console.log(theme.pair('openFeeRate', `${feeRates.openFeeRate} (${(feeRates.openFeeRate * 100).toFixed(4)}%)`));
              console.log(theme.pair('closeFeeRate', `${feeRates.closeFeeRate} (${(feeRates.closeFeeRate * 100).toFixed(4)}%)`));
              console.log(theme.pair('maxLeverage', `${feeRates.maxLeverage}x`));
              console.log(theme.pair('maintMarginRate', `${feeRates.maintenanceMarginRate} (${(feeRates.maintenanceMarginRate * 100).toFixed(4)}%)`));
              console.log(theme.pair('source', feeRates.source));
              console.log('');

              // Cross-check
              const openMatch = Math.abs(openRate - feeRates.openFeeRate) < 1e-12;
              const closeMatch = Math.abs(closeRate - feeRates.closeFeeRate) < 1e-12;
              const marginMatch = Math.abs(derivedMarginRate - feeRates.maintenanceMarginRate) < 1e-9;
              const levMatch = maxLev > 0 && Math.abs(maxLev - feeRates.maxLeverage) < 1e-9;
              if (openMatch && closeMatch && marginMatch && levMatch) {
                console.log(chalk.green('  ✓ CustodyAccount and getProtocolFeeRates() match'));
              } else {
                console.log(chalk.red('  ✗ MISMATCH between CustodyAccount and getProtocolFeeRates()'));
                if (!openMatch) console.log(chalk.red(`    open: ${openRate} vs ${feeRates.openFeeRate}`));
                if (!closeMatch) console.log(chalk.red(`    close: ${closeRate} vs ${feeRates.closeFeeRate}`));
                if (!marginMatch) console.log(chalk.red(`    margin: ${derivedMarginRate} vs ${feeRates.maintenanceMarginRate}`));
                if (!levMatch) console.log(chalk.red(`    leverage: ${maxLev} vs ${feeRates.maxLeverage}`));
              }
              console.log('');
              return;
            }
          }
        }
      } catch (e: unknown) {
        console.log(chalk.yellow(`  Failed to fetch on-chain data: ${getErrorMessage(e)}`));
        console.log('');
      }
    }

    // Fallback: show defaults
    const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
    const feeRates = await getProtocolFeeRates(upper, null);
    console.log(theme.pair('Source', chalk.yellow(feeRates.source)));
    console.log('');
    console.log(`  ${theme.section('Fee Rates (default fallback)')}`);
    console.log(theme.pair('openFeeRate', `${feeRates.openFeeRate} (${(feeRates.openFeeRate * 100).toFixed(4)}%)`));
    console.log(theme.pair('closeFeeRate', `${feeRates.closeFeeRate} (${(feeRates.closeFeeRate * 100).toFixed(4)}%)`));
    console.log(theme.pair('maintMarginRate', `${feeRates.maintenanceMarginRate} (${(feeRates.maintenanceMarginRate * 100).toFixed(2)}%)`));
    console.log('');
    console.log(chalk.yellow('  ⚠ Showing SDK defaults — connect in live mode for on-chain values'));
    console.log('');
  }

  /**
   * protocol verify — Full protocol alignment audit.
   * Runs all checks in parallel with per-task timeout protection.
   */
  private async handleProtocolVerify(): Promise<void> {
    const startTime = Date.now();
    const TASK_TIMEOUT_MS = 1500;

    console.log('');
    console.log(`  ${theme.accentBold('FLASH TERMINAL — PROTOCOL VERIFY')}`);
    console.log(`  ${theme.separator(50)}`);
    console.log('');

    interface CheckResult {
      label: string;
      ok: boolean;
      detail: string;
      error?: string;
    }

    const timedTask = <T>(task: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        task,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out`)), TASK_TIMEOUT_MS),
        ),
      ]);

    // ── 1. RPC Health ──
    const checkRpcHealth = async (): Promise<CheckResult> => {
      try {
        const latency = this.rpcManager.activeLatencyMs;
        const ep = this.rpcManager.activeEndpoint;
        const slot = await timedTask(
          this.rpcManager.connection.getSlot('processed'),
          'RPC slot fetch',
        );
        if (!Number.isFinite(slot) || slot <= 0) {
          return { label: 'RPC', ok: false, detail: '', error: 'Slot not advancing' };
        }
        const latStr = latency > 0 ? `${latency}ms` : 'N/A';
        if (latency > 500) {
          return { label: 'RPC', ok: false, detail: `${ep.label} — ${latStr}`, error: `Latency ${latStr} exceeds 500ms threshold` };
        }
        return { label: 'RPC', ok: true, detail: `reachable (${ep.label} — ${latStr}, slot ${slot})` };
      } catch (err: unknown) {
        return { label: 'RPC', ok: false, detail: '', error: getErrorMessage(err) };
      }
    };

    // ── 2. Oracle Health ──
    const checkOracleHealth = async (): Promise<CheckResult> => {
      try {
        const { PriceService } = await import('../data/prices.js');
        const priceSvc = new PriceService();
        const oracleStart = Date.now();
        const price = await timedTask(priceSvc.getPrice('SOL'), 'Oracle fetch');
        const oracleMs = Date.now() - oracleStart;
        if (!price || !Number.isFinite(price.price) || price.price <= 0) {
          return { label: 'Oracle', ok: false, detail: '', error: 'Failed to fetch SOL price from Pyth Hermes' };
        }
        // Check timestamp freshness (< 5 seconds)
        const age = price.timestamp ? (Date.now() / 1000 - price.timestamp) : 0;
        if (age > 5) {
          return { label: 'Oracle', ok: false, detail: '', error: `Oracle data stale (${age.toFixed(0)}s old)` };
        }
        return { label: 'Oracle', ok: true, detail: `healthy (Pyth Hermes — ${oracleMs}ms)` };
      } catch (err: unknown) {
        return { label: 'Oracle', ok: false, detail: '', error: getErrorMessage(err) };
      }
    };

    // ── 3. Custody Account Validation ──
    const validateCustodyAccounts = async (): Promise<CheckResult> => {
      const markets = ['SOL', 'BTC', 'ETH'];
      const passed: string[] = [];
      const failed: string[] = [];

      const perpClient = this.config.simulationMode ? null : (this.flashClient as any).perpClient ?? null;

      for (const mkt of markets) {
        try {
          const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
          const rates = await timedTask(getProtocolFeeRates(mkt, perpClient), `Custody ${mkt}`);
          if (rates.source === 'on-chain') {
            passed.push(mkt);
          } else {
            // sdk-default means we couldn't get on-chain data
            passed.push(`${mkt} (default)`);
          }
        } catch (err: unknown) {
          failed.push(`${mkt}: ${getErrorMessage(err)}`);
        }
      }

      if (failed.length > 0) {
        return { label: 'Custody accounts', ok: false, detail: '', error: failed.join('; ') };
      }
      return { label: 'Custody accounts', ok: true, detail: `valid (${passed.join(', ')})` };
    };

    // ── 4. Fee Engine Verification ──
    const verifyFeeEngine = async (): Promise<CheckResult> => {
      if (this.config.simulationMode) {
        return { label: 'Fee engine', ok: true, detail: 'skipped (simulation mode — no perpClient)' };
      }

      const perpClient = (this.flashClient as any).perpClient ?? null;
      if (!perpClient?.program?.account?.custody) {
        return { label: 'Fee engine', ok: true, detail: 'skipped (no perpClient)' };
      }

      try {
        const { PoolConfig, CustodyAccount } = await import('flash-sdk');
        const { getPoolForMarket } = await import('../config/index.js');
        const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
        const RATE_POWER = 1_000_000_000;

        const mismatches: string[] = [];
        for (const mkt of ['SOL', 'BTC', 'ETH']) {
          const poolName = getPoolForMarket(mkt);
          if (!poolName) continue;
          const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
          const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
          const custody = custodies.find(c => c.symbol.toUpperCase() === mkt);
          if (!custody) continue;

          const rawData = await timedTask(
            perpClient.program.account.custody.fetch(custody.custodyAccount),
            `Fee engine ${mkt}`,
          ) as any;
          const custodyAcct = CustodyAccount.from(custody.custodyAccount, rawData);
          const custodyOpen = parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER;
          const custodyClose = parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER;

          const engineRates = await getProtocolFeeRates(mkt, perpClient);

          if (Math.abs(custodyOpen - engineRates.openFeeRate) > 0.00001) {
            mismatches.push(`${mkt} open: custody=${custodyOpen}, engine=${engineRates.openFeeRate}`);
          }
          if (Math.abs(custodyClose - engineRates.closeFeeRate) > 0.00001) {
            mismatches.push(`${mkt} close: custody=${custodyClose}, engine=${engineRates.closeFeeRate}`);
          }
        }

        if (mismatches.length > 0) {
          return { label: 'Fee engine', ok: false, detail: '', error: mismatches.join('; ') };
        }
        return { label: 'Fee engine', ok: true, detail: 'matches on-chain values' };
      } catch (err: unknown) {
        return { label: 'Fee engine', ok: false, detail: '', error: getErrorMessage(err) };
      }
    };

    // ── 5. Liquidation Engine Verification ──
    const verifyLiquidationEngine = async (): Promise<CheckResult> => {
      try {
        const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
        const perpClient = this.config.simulationMode ? null : (this.flashClient as any).perpClient ?? null;
        const rates = await getProtocolFeeRates('SOL', perpClient);

        // Compute CLI liquidation for a reference position
        const entryPrice = 100; // normalized reference
        const sizeUsd = 1000;
        const collateralUsd = 100; // 10x leverage
        const cliLiqLong = computeSimulationLiquidationPrice(
          entryPrice, sizeUsd, collateralUsd, TradeSide.Long,
          rates.maintenanceMarginRate, rates.closeFeeRate,
        );
        const cliLiqShort = computeSimulationLiquidationPrice(
          entryPrice, sizeUsd, collateralUsd, TradeSide.Short,
          rates.maintenanceMarginRate, rates.closeFeeRate,
        );

        // Sanity checks: long liq < entry, short liq > entry
        if (cliLiqLong <= 0 || cliLiqLong >= entryPrice) {
          return { label: 'Liquidation engine', ok: false, detail: '', error: `Long liq price ${cliLiqLong} invalid for entry ${entryPrice}` };
        }
        if (cliLiqShort <= entryPrice) {
          return { label: 'Liquidation engine', ok: false, detail: '', error: `Short liq price ${cliLiqShort} invalid for entry ${entryPrice}` };
        }

        // Verify symmetry: |longDist - shortDist| should be ~0
        const longDist = entryPrice - cliLiqLong;
        const shortDist = cliLiqShort - entryPrice;
        if (Math.abs(longDist - shortDist) > 0.001) {
          return { label: 'Liquidation engine', ok: false, detail: '', error: `Asymmetric liq distances: long=${longDist.toFixed(4)}, short=${shortDist.toFixed(4)}` };
        }

        // If live mode with SDK, compare against SDK helper
        const divStatus = isDivergenceOk() ? 'aligned' : 'divergence detected';
        return { label: 'Liquidation engine', ok: isDivergenceOk(), detail: `${divStatus} (long liq=$${cliLiqLong.toFixed(2)}, short liq=$${cliLiqShort.toFixed(2)})` };
      } catch (err: unknown) {
        return { label: 'Liquidation engine', ok: false, detail: '', error: getErrorMessage(err) };
      }
    };

    // ── 6. Protocol Parameter Validation ──
    const validateProtocolParameters = async (): Promise<CheckResult> => {
      try {
        const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
        const perpClient = this.config.simulationMode ? null : (this.flashClient as any).perpClient ?? null;
        const violations: string[] = [];

        for (const mkt of ['SOL', 'BTC', 'ETH']) {
          const rates = await getProtocolFeeRates(mkt, perpClient);
          if (rates.maxLeverage <= 0) violations.push(`${mkt}: maxLeverage=${rates.maxLeverage}`);
          if (rates.maintenanceMarginRate >= 1) violations.push(`${mkt}: margin≥100%`);
          if (rates.openFeeRate < 0) violations.push(`${mkt}: negative openFee`);
          if (rates.closeFeeRate < 0) violations.push(`${mkt}: negative closeFee`);
        }

        if (violations.length > 0) {
          return { label: 'Protocol parameters', ok: false, detail: '', error: violations.join('; ') };
        }
        return { label: 'Protocol parameters', ok: true, detail: 'valid' };
      } catch (err: unknown) {
        return { label: 'Protocol parameters', ok: false, detail: '', error: getErrorMessage(err) };
      }
    };

    // ── Run all checks in parallel ──
    const results = await Promise.all([
      checkRpcHealth(),
      checkOracleHealth(),
      validateCustodyAccounts(),
      verifyFeeEngine(),
      verifyLiquidationEngine(),
      validateProtocolParameters(),
    ]);

    // ── Display results ──
    let allOk = true;
    for (const r of results) {
      if (r.ok) {
        console.log(chalk.green(`  ✓ ${r.label} ${r.detail}`));
      } else {
        allOk = false;
        console.log(chalk.red(`  ✗ ${r.label} failed`));
        if (r.error) {
          console.log(chalk.dim(`    ${r.error}`));
        }
      }
    }

    console.log('');
    const elapsed = Date.now() - startTime;
    if (allOk) {
      console.log(chalk.green(`  System Status: HEALTHY`));
    } else {
      console.log(chalk.red(`  System Status: DEGRADED`));
    }
    console.log(theme.dim(`  Completed in ${elapsed}ms`));
    console.log('');
  }

  private async handleSourceVerify(market: string): Promise<void> {
    const upper = market.toUpperCase();

    console.log('');
    console.log(`  ${theme.accentBold('DATA PROVENANCE VERIFICATION')}  ${theme.dim(`— ${upper}`)}`);
    console.log(`  ${theme.separator(50)}`);

    const checks: string[] = [];
    let allOk = true;

    // ── Section 1: Price Source ──
    console.log(theme.titleBlock('Price Source'));
    try {
      const { PriceService } = await import('../data/prices.js');
      const priceSvc = new PriceService();

      const priceData = await priceSvc.getPrice(upper);
      if (priceData && Number.isFinite(priceData.price) && priceData.price > 0) {
        // Fetch raw Pyth data for confidence interval
        let confidence = 'N/A';
        let publishSlot = 'N/A';
        const { getPythFeedId } = await import('../data/prices.js');
        const feedId = getPythFeedId(upper) ?? 'N/A';

        try {
          if (feedId === 'N/A') throw new Error('No feed ID');
          const rawUrl = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}&parsed=true`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const res = await fetch(rawUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
            if (res.ok) {
              const raw = await res.json() as { parsed?: Array<{ price: { price: string; expo: number; publish_time: number; conf: string } }> };
              const entry = raw.parsed?.[0];
              if (entry) {
                const price = parseInt(entry.price.price, 10) * Math.pow(10, entry.price.expo);
                const conf = parseInt(entry.price.conf ?? '0', 10) * Math.pow(10, entry.price.expo);
                if (Number.isFinite(price) && price > 0 && Number.isFinite(conf)) {
                  confidence = `${((conf / price) * 100).toFixed(4)}%`;
                }
                publishSlot = entry.price.publish_time ? String(entry.price.publish_time) : 'N/A';
              }
            }
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          // Raw fetch failed — non-critical
        }

        console.log(theme.pair('Oracle', 'Pyth Hermes'));
        console.log(theme.pair('Feed', `${upper}/USD`));
        console.log(theme.pair('Price', `$${priceData.price.toFixed(4)}`));
        console.log(theme.pair('Publish Time', publishSlot));
        console.log(theme.pair('Confidence', confidence));
        console.log(theme.pair('Endpoint', 'hermes.pyth.network'));
        checks.push('Oracle price verified');
      } else {
        console.log(chalk.red(`  Failed to fetch price for ${upper}`));
        allOk = false;
      }
    } catch (err: unknown) {
      console.log(chalk.red(`  Price fetch error: ${getErrorMessage(err)}`));
      allOk = false;
    }

    // ── Section 2: Protocol Fee Source ──
    console.log(theme.titleBlock('Protocol Fees'));
    try {
      const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
      const perpClient = this.config.simulationMode ? null : (this.flashClient as any).perpClient ?? null;
      const rates = await getProtocolFeeRates(upper, perpClient);

      // Get custody account address
      let custodyAddress = 'N/A';
      try {
        const { PoolConfig } = await import('flash-sdk');
        const { getPoolForMarket } = await import('../config/index.js');
        const poolName = getPoolForMarket(upper);
        if (poolName) {
          const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
          const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
          const custody = custodies.find(c => c.symbol.toUpperCase() === upper);
          if (custody) {
            custodyAddress = custody.custodyAccount.toString();
          }
        }
      } catch {
        // Non-critical — address display only
      }

      console.log(theme.pair('CustodyAccount', custodyAddress));
      console.log(theme.pair('Open Fee', `${(rates.openFeeRate * 100).toFixed(4)}%`));
      console.log(theme.pair('Close Fee', `${(rates.closeFeeRate * 100).toFixed(4)}%`));
      console.log(theme.pair('Max Leverage', `${rates.maxLeverage}x`));
      console.log(theme.pair('Source', rates.source === 'on-chain'
        ? theme.positive('On-chain protocol data')
        : theme.warning('SDK defaults (simulation mode)')));
      checks.push('Protocol fees ' + (rates.source === 'on-chain' ? 'on-chain' : 'sdk-default'));
    } catch (err: unknown) {
      console.log(chalk.red(`  Fee fetch error: ${getErrorMessage(err)}`));
      allOk = false;
    }

    // ── Section 3: Position Data Source ──
    console.log(theme.titleBlock('Position Data'));
    const { FLASH_PROGRAM_ID } = await import('../config/index.js');
    if (this.config.simulationMode) {
      console.log(theme.pair('Source', 'SimulatedFlashClient'));
      console.log(theme.pair('Method', 'In-memory SimulationState'));
      console.log(theme.pair('Account Type', 'N/A (simulation)'));
      console.log(theme.pair('Program', theme.dim(FLASH_PROGRAM_ID)));
      checks.push('Positions from simulation state');
    } else {
      console.log(theme.pair('Source', 'Flash SDK'));
      console.log(theme.pair('Method', 'perpClient.getPositions()'));
      console.log(theme.pair('Account Type', 'UserPosition PDA'));
      console.log(theme.pair('Program', theme.accent(FLASH_PROGRAM_ID)));
      checks.push('Positions from protocol accounts');
    }

    // ── Section 4: Liquidation Engine ──
    console.log(theme.titleBlock('Liquidation Engine'));
    if (this.config.simulationMode) {
      console.log(theme.pair('Calculation', 'CLI formula'));
      console.log(theme.pair('Method', 'computeSimulationLiquidationPrice()'));
      console.log(theme.pair('Parameters', 'SDK-default fee rates'));
      checks.push('Simulation liquidation engine');
    } else {
      console.log(theme.pair('Calculation', 'SDK helper'));
      console.log(theme.pair('Method', 'getLiquidationPriceContractHelper()'));
      console.log(theme.pair('Parameters', 'CustodyAccount pricing data'));
      console.log(theme.pair('Divergence Check', 'Enabled (0.5% threshold)'));
      checks.push('SDK liquidation engine');
    }

    // ── Section 5: Analytics Data ──
    console.log(theme.titleBlock('Analytics Data'));
    const { FSTATS_BASE_URL } = await import('../config/index.js');
    console.log(theme.pair('Open Interest', 'fstats API'));
    console.log(theme.pair('Endpoint', '/positions/open-interest'));
    console.log(theme.pair('Volume Data', '/volume/daily'));
    console.log(theme.pair('Base URL', FSTATS_BASE_URL));

    // Verify fstats is reachable
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${FSTATS_BASE_URL}/overview/stats?period=7d`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          console.log(theme.pair('Status', theme.positive('Reachable')));
          checks.push('Analytics from external API');
        } else {
          console.log(theme.pair('Status', theme.warning(`HTTP ${res.status}`)));
          allOk = false;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      console.log(theme.pair('Status', theme.negative('Unreachable')));
      allOk = false;
    }

    // ── Section 6: Verification Summary ──
    console.log(theme.titleBlock('Verification'));
    for (const check of checks) {
      console.log(chalk.green(`  ✓ ${check}`));
    }
    if (!allOk) {
      console.log(chalk.yellow(`  ! Some checks could not be completed`));
    }

    console.log('');
    console.log(theme.dim(`  Mode: ${this.config.simulationMode ? 'Simulation' : 'Live'}`));
    console.log('');
  }

  private async handlePositionDebug(market: string): Promise<void> {
    const upper = market.toUpperCase();

    // Fetch protocol fee rates for liquidation calculations
    const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
    const debugFeeRates = await getProtocolFeeRates(upper, null);

    // ─── 1. Fetch position ──────────────────────────────────────────
    let positions: Position[];
    try {
      positions = await this.flashClient.getPositions();
    } catch (e: unknown) {
      console.log(chalk.red(`  Failed to fetch positions: ${getErrorMessage(e)}`));
      return;
    }

    const pos = positions.find(p => p.market.toUpperCase() === upper);
    if (!pos) {
      console.log('');
      console.log(chalk.yellow(`  No open position found for ${upper}`));
      console.log(chalk.dim(`  Open one with: open 5x long ${upper} $100`));
      console.log('');
      return;
    }

    // ─── 2. Load protocol parameters (live mode only) ──────────────
    let openFeePct = 0;
    let closeFeePct = 0;
    let maintenanceMarginPct = 0;
    let maxLeverage = 0;
    let protocolParamsAvailable = false;
    const RATE_POWER = 1_000_000_000; // Flash SDK RATE_DECIMALS = 9

    // SDK objects retained for collateral scenario calculations
    let sdkCustodyAcct: any = null;
    let sdkEntryOraclePrice: any = null;
    let sdkRawPosition: any = null;
    let sdkSide: any = null;
    let sdkPerpClient: any = null;

    if (!this.config.simulationMode) {
      try {
        const {
          PoolConfig: SDKPoolConfig,
          CustodyAccount: SDKCustodyAccount,
          OraclePrice: SDKOraclePrice,
          PositionAccount: SDKPositionAccount,
          Side: SDKSide,
          BN_ZERO: SDK_BN_ZERO,
        } = await import('flash-sdk');
        const BN = (await import('bn.js')).default;
        const { getPoolForMarket } = await import('../config/index.js');
        const poolName = getPoolForMarket(upper);
        if (poolName) {
          const pc = SDKPoolConfig.fromIdsByName(poolName, this.config.network);
          const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
          const tokens = pc.tokens as Array<{ symbol: string; mintKey: any }>;
          const targetToken = tokens.find(t => t.symbol.toUpperCase() === upper);
          const perpClient = (this.flashClient as any).perpClient;

          if (targetToken && perpClient) {
            sdkPerpClient = perpClient;
            const custodyInfo = custodies.find(c => c.symbol === targetToken.symbol);
            if (custodyInfo) {
              // Fetch on-chain custody account for fee and margin data
              const custodyData = await perpClient.program?.account?.custody?.fetch(custodyInfo.custodyAccount);
              if (custodyData) {
                const custodyAcct = SDKCustodyAccount.from(custodyInfo.custodyAccount, custodyData);
                sdkCustodyAcct = custodyAcct;
                openFeePct = parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER * 100;
                closeFeePct = parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER * 100;
                // Maintenance margin from pricing params.
                // pricing.maxLeverage is a u32 in BPS units (e.g. 10000000 = 1000x leverage).
                // SDK formula: liabilities = sizeUsd * BPS_POWER / maxLeverage
                // Human max leverage = maxLeverage / BPS_POWER
                // Maintenance margin % = BPS_POWER / maxLeverage * 100
                const BPS_POWER = 10_000;
                const rawMaxLev = (custodyAcct as any).pricing?.maxLeverage;
                const rawNum = typeof rawMaxLev === 'object' && rawMaxLev?.toNumber
                  ? rawMaxLev.toNumber()
                  : typeof rawMaxLev === 'number' ? rawMaxLev : 0;
                if (Number.isFinite(rawNum) && rawNum > 0) {
                  const humanMaxLev = rawNum / BPS_POWER;
                  if (humanMaxLev > 0 && humanMaxLev <= 2000) {
                    maxLeverage = humanMaxLev;
                    maintenanceMarginPct = (BPS_POWER / rawNum) * 100;
                  }
                }
                protocolParamsAvailable = true;
              }
            }

            // Fetch raw position for SDK liquidation math in collateral scenarios
            const markets = pc.markets as Array<{ marketAccount: any; targetMint: any; side: any }>;
            const positionSide = pos.side === TradeSide.Long ? SDKSide.Long : SDKSide.Short;
            sdkSide = positionSide;
            const marketConfig = markets.find(
              m => m.targetMint.equals(targetToken.mintKey) && m.side === positionSide,
            );

            if (marketConfig && perpClient.program?.account?.position) {
              try {
                const wallet = (this.flashClient as any).wallet?.publicKey;
                if (wallet) {
                  const allPositions = await perpClient.program.account.position.all([
                    { memcmp: { offset: 8, bytes: wallet.toBase58() } },
                  ]);
                  // Find the raw position matching this market/side
                  for (const rawPos of allPositions) {
                    const raw = rawPos.account;
                    if (raw.market?.equals?.(marketConfig.marketAccount)) {
                      sdkRawPosition = { ...raw, pubkey: rawPos.publicKey };
                      // Build entry oracle price from raw position
                      if (raw.entryPrice && typeof raw.entryPrice === 'object' && 'price' in raw.entryPrice && 'exponent' in raw.entryPrice) {
                        sdkEntryOraclePrice = SDKOraclePrice.from({
                          price: raw.entryPrice.price,
                          exponent: new BN(raw.entryPrice.exponent),
                          confidence: SDK_BN_ZERO,
                          timestamp: SDK_BN_ZERO,
                        });
                      }
                      break;
                    }
                  }
                }
              } catch {
                // Non-critical: raw position fetch failed, collateral scenarios will fall back
              }
            }
          }
        }
      } catch {
        // Protocol params unavailable — proceed with position data only
      }
    }

    // Fallback max leverage from config
    if (maxLeverage === 0) {
      const { getMaxLeverage: getMaxLev } = await import('../config/index.js');
      maxLeverage = getMaxLev(upper, false);
      if (maintenanceMarginPct === 0 && maxLeverage > 0) {
        maintenanceMarginPct = (1 / maxLeverage) * 100;
      }
    }

    // SDK-exact collateral scenarios available when all raw data is loaded
    const canUseSDK = !!(sdkPerpClient && sdkCustodyAcct && sdkEntryOraclePrice && sdkRawPosition && sdkSide !== null);

    // ─── 3. Derived values ──────────────────────────────────────────
    const distToLiq = pos.liquidationPrice > 0 && pos.currentPrice > 0
      ? Math.abs(pos.currentPrice - pos.liquidationPrice) / pos.currentPrice * 100
      : 0;

    const pnlPct = pos.collateralUsd > 0 ? (pos.unrealizedPnl / pos.collateralUsd) * 100 : 0;
    const sideLabel = pos.side === TradeSide.Long ? 'Long' : 'Short';

    // ─── 4. Render position debug ───────────────────────────────────
    const lines: string[] = [''];
    const sec = theme.section;
    const pair = theme.pair;
    const dim = theme.dim;
    const sep = theme.separator;

    lines.push(`  ${theme.accentBold(`Position Debug — ${upper} ${sideLabel}`)}`);
    lines.push(`  ${sep(44)}`);
    lines.push('');

    // Position structure
    lines.push(`  ${sec('Position')}`);
    lines.push(pair('Size', formatUsd(pos.sizeUsd)));
    lines.push(pair('Collateral', formatUsd(pos.collateralUsd)));
    lines.push(pair('Entry Price', formatPrice(pos.entryPrice)));
    lines.push(pair('Current Price', formatPrice(pos.currentPrice)));
    lines.push(pair('Leverage', `${pos.leverage.toFixed(2)}x`));
    lines.push('');

    // PnL
    lines.push(`  ${sec('PnL')}`);
    lines.push(pair('Unrealized PnL', colorPnl(pos.unrealizedPnl)));
    lines.push(pair('PnL %', `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`));
    lines.push('');

    // Margin & liquidation
    lines.push(`  ${sec('Margin & Liquidation')}`);
    if (maintenanceMarginPct > 0) {
      lines.push(pair('Maint. Margin', `${maintenanceMarginPct.toFixed(2)}%`));
    }
    if (maxLeverage > 0) {
      lines.push(pair('Max Leverage', `${maxLeverage}x`));
    }
    if (pos.liquidationPrice > 0) {
      lines.push(pair('Liquidation Price', chalk.yellow(formatPrice(pos.liquidationPrice))));
      lines.push(pair('Distance to Liq', `${distToLiq.toFixed(1)}%`));
    } else {
      lines.push(pair('Liquidation Price', dim('Unavailable')));
    }
    lines.push('');

    // Fees (from protocol)
    lines.push(`  ${sec('Fees')}`);
    if (protocolParamsAvailable) {
      lines.push(pair('Open Fee Rate', `${openFeePct.toFixed(4)}%`));
      lines.push(pair('Close Fee Rate', `${closeFeePct.toFixed(4)}%`));
    }
    lines.push(pair('Unsettled Fees', formatUsd(pos.totalFees)));
    lines.push('');

    // ─── 5. Price impact scenarios ──────────────────────────────────
    lines.push(`  ${sec('What If Scenarios')}`);
    lines.push(`  ${sep(44)}`);
    lines.push('');

    const scenarios = [-15, -10, -5, 5, 10, 15];
    for (const pctMove of scenarios) {
      const simPrice = pos.currentPrice * (1 + pctMove / 100);
      const priceDelta = simPrice - pos.entryPrice;
      const mult = pos.side === TradeSide.Long ? 1 : -1;
      const simPnl = pos.entryPrice > 0 ? (priceDelta / pos.entryPrice) * pos.sizeUsd * mult : 0;

      // Check if this scenario would be liquidated
      const isLiquidated = pos.liquidationPrice > 0 && (
        (pos.side === TradeSide.Long && simPrice <= pos.liquidationPrice) ||
        (pos.side === TradeSide.Short && simPrice >= pos.liquidationPrice)
      );

      if (isLiquidated) {
        const liqDistAtScenario = Math.abs(simPrice - pos.liquidationPrice) / simPrice * 100;
        lines.push(`  Price ${pctMove > 0 ? '+' : ''}${pctMove}%     → ${chalk.red('LIQUIDATED')}`);
      } else {
        const scenarioLiqDist = pos.liquidationPrice > 0
          ? Math.abs(simPrice - pos.liquidationPrice) / simPrice * 100
          : 0;
        // Pad the raw PnL string BEFORE colorizing to avoid ANSI codes breaking alignment
        const rawPnl = simPnl >= 0 ? `$${simPnl.toFixed(2)}` : `-$${Math.abs(simPnl).toFixed(2)}`;
        const paddedPnl = rawPnl.padEnd(12);
        const pnlStr = simPnl >= 0 ? chalk.green(paddedPnl) : chalk.red(paddedPnl);
        const liqStr = scenarioLiqDist > 0 ? `Liq Distance: ${scenarioLiqDist.toFixed(1)}%` : '';
        lines.push(`  Price ${(pctMove > 0 ? '+' : '') + pctMove + '%'}${' '.repeat(Math.max(1, 6 - String(pctMove).length))} → PnL: ${pnlStr}  ${liqStr}`);
      }
    }
    lines.push('');

    // ─── 6. Collateral adjustment simulation ────────────────────────
    if (pos.liquidationPrice > 0) {
      lines.push(`  ${sec('Add Collateral Scenarios')}`);
      lines.push(`  ${sep(44)}`);
      lines.push('');

      const addAmounts = [50, 100, 200, 500];
      const USD_DECIMALS = 6;

      for (const addAmt of addAmounts) {
        const newCollateral = pos.collateralUsd + addAmt;
        const newLeverage = pos.sizeUsd / newCollateral;

        if (canUseSDK) {
          // SDK-exact: clone raw position with increased collateral, compute exact liq price
          try {
            const BN = (await import('bn.js')).default;
            const { PositionAccount: SDKPositionAccount } = await import('flash-sdk');
            const addBN = new BN(Math.round(addAmt * Math.pow(10, USD_DECIMALS)));
            const newCollateralBN = sdkRawPosition.collateralUsd.add(addBN);
            // Create modified position with increased collateral
            const modifiedRaw = { ...sdkRawPosition, collateralUsd: newCollateralBN };
            const modPosAcct = SDKPositionAccount.from(
              sdkRawPosition.pubkey,
              modifiedRaw as unknown as ConstructorParameters<typeof SDKPositionAccount>[1],
            );
            const unsettledFees = sdkRawPosition.unsettledFeesUsd ?? new BN(0);
            const liqOraclePrice = sdkPerpClient.getLiquidationPriceContractHelper(
              sdkEntryOraclePrice, unsettledFees, sdkSide, sdkCustodyAcct, modPosAcct,
            );
            const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
            if (Number.isFinite(liqUi) && liqUi > 0) {
              lines.push(`  Add ${formatUsd(addAmt).padEnd(8)} → Liq Price: ${chalk.yellow(formatPrice(liqUi))}  (${newLeverage.toFixed(1)}x leverage)`);
              continue;
            }
          } catch {
            // Fall through to approximation
          }
        }

        // Fallback: use protocol-aligned formula (matches getLiquidationPriceContractHelper)
        if (newLeverage < 1) {
          // Fully collateralized — collateral exceeds position size, no liquidation risk
          lines.push(`  Add ${formatUsd(addAmt).padEnd(8)} → ${chalk.green('Liquidation: None')}  ${dim(`(fully collateralized, ${newLeverage.toFixed(2)}x effective leverage)`)}`);
        } else if (pos.sizeUsd > 0 && pos.entryPrice > 0) {
          const fallbackLiqPrice = computeSimulationLiquidationPrice(
            pos.entryPrice, pos.sizeUsd, newCollateral, pos.side, debugFeeRates.maintenanceMarginRate, debugFeeRates.closeFeeRate,
          );
          if (Number.isFinite(fallbackLiqPrice) && fallbackLiqPrice > 0) {
            lines.push(`  Add ${formatUsd(addAmt).padEnd(8)} → Liq Price: ${chalk.yellow(formatPrice(fallbackLiqPrice))}  (${newLeverage.toFixed(1)}x leverage)`);
          }
        }
      }
      lines.push('');
    }

    // ─── 7. Reduce position size scenarios ──────────────────────────
    if (pos.liquidationPrice > 0 && pos.leverage > 1 && pos.collateralUsd > 0) {
      // Generate leverage targets below current, down to 1x
      // For fractional leverage (e.g. 1.33x), start from floor and include 1x
      const targetLeverages: number[] = [];
      // If leverage > 2, show integer steps down
      for (let lev = Math.floor(pos.leverage) - 1; lev >= 1 && targetLeverages.length < 4; lev--) {
        targetLeverages.push(lev);
      }
      // If current leverage is fractional and > 1 but < 2, show 1x explicitly
      if (targetLeverages.length === 0 && pos.leverage > 1) {
        targetLeverages.push(1);
      }

      if (targetLeverages.length > 0) {
        lines.push(`  ${sec('Reduce Position Size')}`);
        lines.push(`  ${sep(44)}`);
        lines.push('');

        const USD_DECIMALS_SIZE = 6;

        for (const targetLev of targetLeverages) {
          const newSizeUsd = pos.collateralUsd * targetLev;

          if (canUseSDK) {
            // SDK-exact: clone raw position with reduced sizeUsd, compute exact liq price
            try {
              const BN = (await import('bn.js')).default;
              const { PositionAccount: SDKPositionAccount } = await import('flash-sdk');
              const newSizeBN = new BN(Math.round(newSizeUsd * Math.pow(10, USD_DECIMALS_SIZE)));
              const modifiedRaw = { ...sdkRawPosition, sizeUsd: newSizeBN };
              const modPosAcct = SDKPositionAccount.from(
                sdkRawPosition.pubkey,
                modifiedRaw as unknown as ConstructorParameters<typeof SDKPositionAccount>[1],
              );
              const unsettledFees = sdkRawPosition.unsettledFeesUsd ?? new BN(0);
              const liqOraclePrice = sdkPerpClient.getLiquidationPriceContractHelper(
                sdkEntryOraclePrice, unsettledFees, sdkSide, sdkCustodyAcct, modPosAcct,
              );
              const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
              if (Number.isFinite(liqUi) && liqUi > 0) {
                lines.push(`  Reduce to ${targetLev}x → Size: ${formatUsd(newSizeUsd).padEnd(10)} → Liq Price: ${chalk.yellow(formatPrice(liqUi))}`);
                continue;
              }
            } catch {
              // Fall through to approximation
            }
          }

          // Fallback: use protocol-aligned liquidation formula
          if (targetLev >= 1 && pos.entryPrice > 0) {
            const fallbackLiq = computeSimulationLiquidationPrice(
              pos.entryPrice, newSizeUsd, pos.collateralUsd, pos.side, debugFeeRates.maintenanceMarginRate, debugFeeRates.closeFeeRate,
            );
            if (Number.isFinite(fallbackLiq) && fallbackLiq > 0) {
              lines.push(`  Reduce to ${targetLev}x → Size: ${formatUsd(newSizeUsd).padEnd(10)} → Liq Price: ${chalk.yellow(formatPrice(fallbackLiq))}`);
            }
          }
        }
        lines.push('');
      }
    }

    // ─── 8. Data source labels ──────────────────────────────────────
    lines.push(`  ${sep(44)}`);
    lines.push(dim(`  Price Source:       Pyth Hermes`));
    const sdkLabel = canUseSDK ? ' (on-chain CustodyAccount + getLiquidationPriceContractHelper)' : protocolParamsAvailable ? ' (on-chain CustodyAccount)' : '';
    lines.push(dim(`  Liquidation Math:  Flash SDK${sdkLabel}`));
    lines.push(dim(`  Position Data:     ${this.config.simulationMode ? 'Simulation' : 'Flash SDK perpClient.getUserPositions()'}`));
    lines.push('');

    console.log(lines.join('\n'));
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

    // Analytics commands with market argument — ensure alias resolution
    if (lower.startsWith('analyze ') || lower.startsWith('analyse ')) {
      const prefix = lower.startsWith('analyze ') ? 'analyze ' : 'analyse ';
      const market = resolveMarketAlias(input.slice(prefix.length).trim());
      return { action: ActionType.Analyze, market } as ParsedIntent;
    }
    if (lower.startsWith('liquidations ') || lower.startsWith('liquidation ')) {
      const prefix = lower.startsWith('liquidations ') ? 'liquidations ' : 'liquidation ';
      const market = resolveMarketAlias(input.slice(prefix.length).trim());
      return { action: ActionType.LiquidationMap, market } as ParsedIntent;
    }
    if (lower.startsWith('funding ')) {
      const market = resolveMarketAlias(input.slice('funding '.length).trim());
      return { action: ActionType.FundingDashboard, market } as ParsedIntent;
    }
    if (lower.startsWith('depth ')) {
      const market = resolveMarketAlias(input.slice('depth '.length).trim());
      return { action: ActionType.LiquidityDepth, market } as ParsedIntent;
    }

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
      const errMsg = getErrorMessage(error);
      const humanized = humanizeSdkError(errMsg, collateral, leverage);
      console.log(chalk.red(`  Dry run failed: ${humanized}`));
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
          // Map raw Solana errors to human-readable explanations
          const rawErr = preview.simulationError;
          const isInvalidArg = rawErr.includes('InvalidArgument') || rawErr.includes('invalid program argument');
          if (isInvalidArg) {
            console.log(`    Error:          ${chalk.red('Protocol rejected parameters')}`);
            console.log('');
            console.log(chalk.dim('  Possible causes:'));
            console.log(chalk.dim('    • Leverage exceeds market limit'));
            console.log(chalk.dim('    • Insufficient pool liquidity'));
            console.log(chalk.dim('    • Position size exceeds protocol limits'));
            console.log(chalk.dim('    • Duplicate position on same market/side'));
          } else {
            console.log(`    Error:          ${chalk.red(humanizeSdkError(rawErr))}`);
          }
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

      // Check if user pre-typed a response while the command was processing.
      // In live mode, discard buffered input so the user must see the trade
      // summary before confirming — prevents accidental auto-confirmation.
      if (this.bufferedLine) {
        if (this.config.simulationMode) {
          const answer = this.bufferedLine;
          this.bufferedLine = null;
          resolve(
            answer.toLowerCase() === 'yes' ||
            answer.toLowerCase() === 'y'
          );
          return;
        }
        // Live mode: discard pre-typed input — user must confirm after seeing details
        this.bufferedLine = null;
      }

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

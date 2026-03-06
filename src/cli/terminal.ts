import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { AIInterpreter, OfflineInterpreter } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import { ToolContext, ToolResult, FlashConfig, IFlashClient, ActionType, ParsedIntent } from '../types/index.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { WalletManager, createConnection } from '../wallet/index.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { banner, shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { initLogger } from '../utils/logger.js';
import { getAutopilot, setClawdApiKey } from '../clawd/clawd-tools.js';

const COMMAND_TIMEOUT_MS = 10_000;
const SLOW_COMMAND_MS = 2_000;
const HISTORY_FILE = join(homedir(), '.flash_terminal_history');
const MAX_HISTORY = 1000;

/** Phase 11: Single-token fast dispatch — skips interpreter entirely */
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
};

/** Phase 3: Timeout wrapper for command execution */
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

export class FlashTerminal {
  private config: FlashConfig;
  private interpreter: AIInterpreter | OfflineInterpreter;
  private engine!: ToolEngine;
  private context!: ToolContext;
  private rl!: Interface;
  private flashClient!: IFlashClient;
  private fstats: FStatsClient;
  private walletManager: WalletManager;
  /** Phase 8: Confirmation callback for the next line input */
  private pendingConfirmation: ((answer: string) => void) | null = null;
  /** Phase 8: Prevent concurrent command processing */
  private processing = false;

  constructor(config: FlashConfig) {
    this.config = config;
    this.fstats = new FStatsClient();
    const connection = createConnection(config.rpcUrl);
    this.walletManager = new WalletManager(connection);

    initLogger(config.logFile ? { logFile: config.logFile } : undefined);

    if (config.anthropicApiKey && config.anthropicApiKey !== 'sk-ant-...') {
      this.interpreter = new AIInterpreter(config.anthropicApiKey);
    } else {
      this.interpreter = new OfflineInterpreter();
    }
  }

  async start(): Promise<void> {
    // Phase 10: Startup safety checks
    this.validateStartup();

    // Create readline early — needed for wallet prompt
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: MAX_HISTORY,
    });

    this.loadHistory();

    // Print banner (mode determined after config is loaded)
    console.log(banner(this.config.simulationMode));

    // ─── Auto-Load Default Wallet ──────────────────────────────────────
    let walletInfo: { address: string } | null = null;
    const store = new WalletStore();
    const defaultWallet = store.getDefault();

    if (defaultWallet) {
      try {
        const walletPath = store.getWalletPath(defaultWallet);
        walletInfo = this.tryConnectWallet(walletPath);
        if (walletInfo) {
          console.log(chalk.green(`\n  Wallet: ${walletInfo.address} (${defaultWallet})`));
        }
      } catch {
        console.log(chalk.dim(`\n  Default wallet "${defaultWallet}" not found.`));
      }
    }

    // ─── Live Mode Wallet Gate ──────────────────────────────────────────
    // If live mode was requested but no wallet is connected, pause and ask.
    // Never silently switch to simulation.
    const isLiveRequested = !this.config.simulationMode;
    const canSign = this.walletManager.isConnected;

    if (isLiveRequested && (!walletInfo || !canSign)) {
      const choice = await this.showLiveWalletMenu(store);

      if (choice === 'exit') {
        console.log(chalk.dim('\n  Goodbye.\n'));
        this.rl.close();
        process.exit(0);
      }

      if (choice === 'simulation') {
        this.config.simulationMode = true;
      }

      // Re-check after wallet setup
      walletInfo = this.walletManager.isConnected
        ? { address: this.walletManager.address! }
        : walletInfo;
    }

    if (!walletInfo && this.config.simulationMode) {
      console.log(chalk.dim('\n  No wallet connected. Use: wallet import <name> <path>'));
    }

    // ─── Initialize Client ───────────────────────────────────────────────
    const connection = createConnection(this.config.rpcUrl);

    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient(10_000);
    } else if (!this.walletManager.isConnected) {
      // Should not reach here — the gate above ensures wallet or simulation.
      // Defensive fallback.
      console.log(chalk.red('  No wallet available for live trading.'));
      console.log(chalk.yellow('  Switching to simulation mode.'));
      this.config.simulationMode = true;
      this.flashClient = new SimulatedFlashClient(10_000);
    } else {
      try {
        const { FlashClient } = await import('../client/flash-client.js');
        this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      } catch (error: unknown) {
        console.log(chalk.red(`  Failed to initialize live client: ${getErrorMessage(error)}`));
        console.log(chalk.yellow('  Switching to simulation mode.'));
        this.config.simulationMode = true;
        this.flashClient = new SimulatedFlashClient(10_000);
      }
    }

    // Build tool context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      walletAddress: walletInfo?.address ?? this.flashClient.walletAddress ?? 'unknown',
      walletManager: this.walletManager,
    };

    setClawdApiKey(this.config.anthropicApiKey);
    this.engine = new ToolEngine(this.context);

    // Set prompt based on mode
    this.updatePrompt();

    // ─── Display Status ──────────────────────────────────────────────────
    console.log('');
    if (this.config.simulationMode) {
      const modeTag = chalk.bgYellow.black(' SIMULATION ');
      console.log(`  ${modeTag} ${chalk.dim('Pool:')} ${chalk.bold(this.config.defaultPool)}`);

      if (walletInfo) {
        console.log(`  Wallet: ${chalk.cyan(walletInfo.address)}`);
      } else {
        console.log(`  Wallet: ${chalk.cyan(shortAddress(this.context.walletAddress))}`);
      }

      console.log(`  Balance: ${chalk.green('$' + this.flashClient.getBalance().toFixed(2))}`);
    } else {
      const modeTag = chalk.bgRed.white.bold(' LIVE TRADING ENABLED ');
      console.log(`  ${modeTag}`);
      console.log('');
      console.log(`  Wallet:  ${chalk.cyan(walletInfo!.address)}`);
      console.log(`  Network: ${chalk.bold(this.config.network)}`);
      console.log(`  Pool:    ${chalk.bold(this.config.defaultPool)}`);

      try {
        const bal = await this.walletManager.getBalance();
        console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
      } catch {
        // silently ignore balance fetch errors at startup
      }
    }

    console.log(chalk.dim('\n  Type "help" for commands, "exit" to quit.\n'));

    // ─── Signal Handlers ──────────────────────────────────────────────────
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    // ─── Start Line Handler ──────────────────────────────────────────────
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

      const trimmed = line.trim();

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

  /** Try to connect a wallet from a file path. Returns info on success, null on failure. */
  private tryConnectWallet(path: string): { address: string } | null {
    try {
      const result = this.walletManager.loadFromFile(path);
      console.log(chalk.green(`  Connected: ${result.address}`));
      return { address: result.address };
    } catch (error: unknown) {
      console.log(chalk.red(`  Failed to load wallet: ${getErrorMessage(error)}`));
      return null;
    }
  }

  /** Blocking question prompt for startup flows. */
  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, resolve);
    });
  }

  /**
   * Read a line of input with echo disabled.
   * Used for private key entry — input is never displayed on screen.
   */
  private readHidden(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;

      stdout.write(prompt);

      // Pause readline so it doesn't intercept raw keystrokes
      this.rl.pause();

      const wasRaw = stdin.isRaw ?? false;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      let input = '';

      const onData = (ch: string): void => {
        const char = ch.toString();

        switch (char) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl+D
            stdin.setRawMode(wasRaw);
            stdin.removeListener('data', onData);
            stdout.write('\n');
            this.rl.resume();
            resolve(input.trim());
            return;

          case '\u0003': // Ctrl+C
            stdin.setRawMode(wasRaw);
            stdin.removeListener('data', onData);
            stdout.write('\n');
            this.rl.resume();
            resolve('');
            return;

          case '\u007F': // Backspace
          case '\b':
            if (input.length > 0) {
              input = input.slice(0, -1);
            }
            return;

          default:
            input += char;
            return;
        }
      };

      stdin.on('data', onData);
    });
  }

  /**
   * Interactive wallet setup menu shown in live mode when no wallet is connected.
   * Returns the user's chosen path: 'connected' | 'simulation' | 'exit'.
   */
  private async showLiveWalletMenu(store: WalletStore): Promise<'connected' | 'simulation' | 'exit'> {
    const printOptions = (): void => {
      console.log('');
      console.log(chalk.bold('  Choose an option:'));
      console.log('');
      console.log(`    ${chalk.cyan('1')}  wallet import`);
      console.log(`    ${chalk.cyan('2')}  wallet connect <path>`);
      console.log(`    ${chalk.cyan('3')}  continue in simulation`);
      console.log(`    ${chalk.cyan('4')}  exit`);
      console.log('');
    };

    console.log('');
    console.log(chalk.bold.red('  LIVE TRADING MODE'));
    console.log('');
    console.log(chalk.yellow('  No wallet connected.'));
    printOptions();

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1': {
          const result = await this.handleWalletImportFlow(store);
          if (result) return 'connected';
          printOptions();
          continue;
        }

        case '2': {
          const result = await this.handleWalletConnectFlow();
          if (result) return 'connected';
          printOptions();
          continue;
        }

        case '3':
          console.log(chalk.yellow('\n  Switching to simulation mode.\n'));
          return 'simulation';

        case '4':
          return 'exit';

        default:
          console.log(chalk.dim('  Enter 1, 2, 3, or 4.'));
          continue;
      }
    }
  }

  /**
   * Interactive wallet import: prompts for name and private key array,
   * validates, stores to ~/.flash/wallets/, and connects.
   */
  private async handleWalletImportFlow(store: WalletStore): Promise<boolean> {
    console.log('');

    const name = (await this.ask(`  ${chalk.yellow('Enter wallet name:')} `)).trim();
    if (!name) {
      console.log(chalk.red('  Wallet name cannot be empty.'));
      return false;
    }

    // Sanitize check: alphanumeric/hyphen/underscore, 1-64 chars
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
      return false;
    }

    console.log(chalk.dim('  Paste Solana private key (input hidden):'));
    const keyInput = await this.readHidden(`  ${chalk.yellow('>')} `);

    if (!keyInput) {
      console.log(chalk.red('  No key provided.'));
      return false;
    }

    let secretKey: number[] | undefined;
    try {
      const parsed: unknown = JSON.parse(keyInput);
      if (!Array.isArray(parsed)) {
        console.log(chalk.red('  Invalid key format. Expected JSON array of 64 numbers.'));
        return false;
      }
      secretKey = parsed as number[];
    } catch {
      console.log(chalk.red('  Invalid key format. Expected JSON array of 64 numbers.'));
      return false;
    }

    try {
      const result = store.importWallet(name, secretKey);
      store.setDefault(name);

      // Connect the wallet
      this.walletManager.loadFromFile(result.path);

      console.log('');
      console.log(chalk.green('  Wallet imported successfully'));
      console.log(`  Address: ${chalk.cyan(result.address)}`);
      console.log('');

      return true;
    } catch (error: unknown) {
      console.log(chalk.red(`  Import failed: ${getErrorMessage(error)}`));
      return false;
    } finally {
      // Zero out sensitive data from memory
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

    const rawPath = (await this.ask(`  ${chalk.yellow('Enter keypair path:')} `)).trim();
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

  /** Handle wallet disconnect: stop autopilot, switch to sim, swap client, update prompt. */
  private handleDisconnect(): void {
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

    // Switch to simulation mode
    if (!this.config.simulationMode) {
      this.config.simulationMode = true;
      this.context.simulationMode = true;
    }

    // Swap to simulation client
    this.flashClient = new SimulatedFlashClient(10_000);
    this.context.flashClient = this.flashClient;

    // Rebuild tool engine with updated context
    this.engine = new ToolEngine(this.context);

    this.updatePrompt();
  }

  /** Handle wallet connected: switch to live mode, reinitialize client, update prompt. */
  private async handleWalletConnected(): Promise<void> {
    // Already live — just rebuild the client with the new wallet
    // Or switching from sim to live
    this.config.simulationMode = false;
    this.context.simulationMode = false;

    const connection = createConnection(this.config.rpcUrl);

    try {
      const { FlashClient } = await import('../client/flash-client.js');
      this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      this.context.flashClient = this.flashClient;
    } catch (error: unknown) {
      // If live client fails to init, stay in simulation
      console.log(chalk.red(`  Failed to initialize live client: ${getErrorMessage(error)}`));
      console.log(chalk.yellow('  Remaining in simulation mode.'));
      this.config.simulationMode = true;
      this.context.simulationMode = true;
      this.flashClient = new SimulatedFlashClient(10_000);
      this.context.flashClient = this.flashClient;
    }

    // Rebuild tool engine with updated context
    this.engine = new ToolEngine(this.context);

    this.updatePrompt();
  }

  /** Phase 2: Update prompt prefix based on current mode */
  private updatePrompt(): void {
    const prefix = this.config.simulationMode
      ? chalk.yellow('flash [sim]')
      : chalk.red('flash [live]');
    this.rl.setPrompt(`${prefix} > `);
  }

  /** Phase 10: Validate configuration at startup */
  private validateStartup(): void {
    const warnings: string[] = [];

    if (!this.config.rpcUrl || this.config.rpcUrl === 'https://api.mainnet-beta.solana.com') {
      warnings.push('Using default public RPC — set RPC_URL for better performance');
    }

    if (!this.config.anthropicApiKey || this.config.anthropicApiKey === 'sk-ant-...') {
      warnings.push('No ANTHROPIC_API_KEY — AI features disabled, using local parsing only');
    }

    if (!this.config.simulationMode) {
      warnings.push('LIVE MODE active — real transactions will be submitted');
    }

    if (warnings.length > 0) {
      console.log('');
      for (const w of warnings) {
        console.log(chalk.dim(`  [startup] ${w}`));
      }
    }
  }

  /** Phase 5: Load command history from file */
  private loadHistory(): void {
    try {
      const data = readFileSync(HISTORY_FILE, 'utf-8');
      const lines = data.split('\n').filter(Boolean).slice(-MAX_HISTORY);
      // readline stores history newest-first internally
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        rlAny.history = lines.reverse();
      }
    } catch {
      // No history file yet — that's fine
    }
  }

  /** Phase 5: Save command history to file */
  private saveHistory(): void {
    try {
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        const lines = [...rlAny.history].reverse().slice(-MAX_HISTORY);
        writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
      }
    } catch {
      // Best-effort — don't fail on history save
    }
  }

  /** Phase 9: Clean shutdown */
  private shutdown(): void {
    this.saveHistory();
    try {
      const autopilot = getAutopilot(this.context);
      if (autopilot.state.active) autopilot.stop();
    } catch {
      // Best-effort cleanup
    }
    console.log(chalk.dim('\n  Goodbye.\n'));
    this.rl.close();
    process.exit(0);
  }

  private async handleInput(input: string): Promise<void> {
    // Phase 12: Start timing
    const startTime = Date.now();

    // Phase 11: Fast dispatch for single-token commands
    let intent: ParsedIntent;
    const lower = input.toLowerCase();
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) {
      intent = fastIntent;
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

    // Handle wallet disconnect: stop autopilot, switch to simulation, update prompt
    if (result.data?.disconnected) {
      this.handleDisconnect();
    }

    // Handle wallet connected: switch to live mode, reinitialize client, update prompt
    if (result.data?.walletConnected) {
      await this.handleWalletConnected();
    }

    // Handle confirmation flow
    if (result.requiresConfirmation && result.data?.executeAction) {
      const confirmed = await this.confirm(result.confirmationPrompt ?? 'Confirm?');
      if (confirmed) {
        process.stdout.write(chalk.dim('  Submitting...\r'));

        try {
          const execResult = await withTimeout(
            result.data.executeAction(),
            COMMAND_TIMEOUT_MS,
            'transaction',
          );
          process.stdout.write('                \r');
          console.log(execResult.message);
        } catch (error: unknown) {
          console.log(chalk.red(`  Transaction failed: ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
    }

    // Phase 12: Slow command warning
    const elapsed = Date.now() - startTime;
    if (elapsed > SLOW_COMMAND_MS) {
      console.log(chalk.dim(`  [${(elapsed / 1000).toFixed(1)}s]`));
    }
  }

  /** Phase 8: Confirmation via pendingConfirmation callback */
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

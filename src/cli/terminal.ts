import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { AIInterpreter, OfflineInterpreter } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import { ToolContext, ToolResult, FlashConfig, IFlashClient, ActionType, ParsedIntent } from '../types/index.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { WalletManager, createConnection } from '../wallet/index.js';
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
  'markets':     { action: ActionType.GetMarketData },
  'market':      { action: ActionType.GetMarketData },
  'leaderboard': { action: ActionType.GetLeaderboard },
  'rankings':    { action: ActionType.GetLeaderboard },
  'dashboard':   { action: ActionType.Dashboard },
  'dash':        { action: ActionType.Dashboard },
  'risk':        { action: ActionType.RiskReport },
  'scan':        { action: ActionType.ScanMarkets },
  'rebalance':   { action: ActionType.PortfolioRebalance },
  'exposure':    { action: ActionType.PortfolioExposure },
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

    const walletInfo = this.walletManager.tryDetect(this.config.walletPath);
    const connection = createConnection(this.config.rpcUrl);

    // Initialize client (simulation or real)
    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient(10_000);
    } else {
      if (!walletInfo) {
        console.log(chalk.yellow('  No wallet found at ' + this.config.walletPath + '. Falling back to simulation mode.'));
        this.config.simulationMode = true;
        this.flashClient = new SimulatedFlashClient(10_000);
      } else {
        try {
          const { FlashClient } = await import('../client/flash-client.js');
          this.flashClient = new FlashClient(connection, this.walletManager, this.config);
        } catch (error: unknown) {
          console.log(chalk.red(`  Failed to initialize live client: ${getErrorMessage(error)}`));
          console.log(chalk.yellow('  Falling back to simulation mode.'));
          this.config.simulationMode = true;
          this.flashClient = new SimulatedFlashClient(10_000);
        }
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

    // Phase 2 & 5: Create readline with history support
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: MAX_HISTORY,
    });

    // Phase 5: Load persistent history
    this.loadHistory();

    // Phase 2: Set prompt string
    this.updatePrompt();

    // Phase 9: Graceful exit on EOF / terminal close
    this.rl.on('close', () => {
      this.shutdown();
    });

    // Phase 1: Event-based line handler (replaces recursive rl.question)
    this.rl.on('line', async (line) => {
      // Phase 8: If waiting for confirmation, route to confirmation handler
      if (this.pendingConfirmation) {
        const cb = this.pendingConfirmation;
        this.pendingConfirmation = null;
        cb(line);
        return;
      }

      const trimmed = line.trim();

      // Phase 7: Reject empty input
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Phase 7: Input length limit
      if (trimmed.length > 1000) {
        console.log(chalk.red('  Input too long (max 1000 characters).'));
        this.rl.prompt();
        return;
      }

      // Phase 9: Exit commands
      const lower = trimmed.toLowerCase();
      if (lower === 'exit' || lower === 'quit') {
        this.shutdown();
        return;
      }

      // Phase 8: Block concurrent commands
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

    // Print banner
    console.log(banner());

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

      this.walletManager.getBalance().then(bal => {
        console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
      }).catch(() => {
        // silently ignore balance fetch errors at startup
      });
    }

    console.log(chalk.dim('\n  Type "help" for commands, "exit" to quit.\n'));

    // Phase 2: Show initial prompt
    this.rl.prompt();
  }

  /** Phase 2: Update prompt prefix based on current mode */
  private updatePrompt(): void {
    const prefix = this.config.simulationMode
      ? chalk.yellow('flash [sim]')
      : chalk.green('flash');
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

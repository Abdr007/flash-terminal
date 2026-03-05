import { createInterface, Interface } from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { AIInterpreter, OfflineInterpreter } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import { ToolContext, ToolResult, FlashConfig, IFlashClient } from '../types/index.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { banner, shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { initLogger } from '../utils/logger.js';

export class FlashTerminal {
  private config: FlashConfig;
  private interpreter: AIInterpreter | OfflineInterpreter;
  private engine!: ToolEngine;
  private context!: ToolContext;
  private rl!: Interface;
  private flashClient!: IFlashClient;
  private fstats: FStatsClient;
  private running = false;

  constructor(config: FlashConfig) {
    this.config = config;
    this.fstats = new FStatsClient();

    // Initialize logger
    initLogger(config.logFile ? { logFile: config.logFile } : undefined);

    // Initialize interpreter
    if (config.anthropicApiKey && config.anthropicApiKey !== 'sk-ant-...') {
      this.interpreter = new AIInterpreter(config.anthropicApiKey);
    } else {
      this.interpreter = new OfflineInterpreter();
    }
  }

  async start(): Promise<void> {
    // Initialize client (simulation or real)
    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient(10_000);
    } else {
      const { FlashClient } = await import('../client/flash-client.js');
      this.flashClient = new FlashClient(this.config);
    }

    // Build tool context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      walletAddress: this.flashClient.walletAddress ?? 'unknown',
    };

    this.engine = new ToolEngine(this.context);

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Graceful shutdown
    const shutdown = () => {
      console.log(chalk.dim('\n  Goodbye.\n'));
      this.running = false;
      this.rl.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Print banner
    console.log(banner());

    const modeTag = this.config.simulationMode
      ? chalk.bgYellow.black(' SIMULATION ')
      : chalk.bgGreen.black(' LIVE ');

    console.log(`  ${modeTag} ${chalk.dim('Pool:')} ${chalk.bold(this.config.defaultPool)}`);
    console.log(`  Wallet: ${chalk.cyan(shortAddress(this.context.walletAddress))}`);

    if (this.config.simulationMode) {
      console.log(`  Balance: ${chalk.green('$' + this.flashClient.getBalance().toFixed(2))}`);
    }

    console.log(chalk.dim('\n  Type "help" for commands, "exit" to quit.\n'));

    // Main loop
    this.running = true;
    while (this.running) {
      const input = await this.prompt();
      if (input === null) break;

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        shutdown();
        return;
      }

      await this.handleInput(trimmed);
    }
  }

  private prompt(): Promise<string | null> {
    const prefix = this.config.simulationMode
      ? chalk.yellow('flash [sim]')
      : chalk.green('flash');

    return new Promise((resolve) => {
      this.rl.question(`${prefix} > `, (answer) => resolve(answer));
      this.rl.once('close', () => resolve(null));
    });
  }

  private async handleInput(input: string): Promise<void> {
    // Parse intent
    const spinner = ora({
      text: chalk.dim('Parsing...'),
      spinner: 'dots',
    }).start();

    let intent;
    try {
      intent = await this.interpreter.parseIntent(input);
      spinner.stop();
    } catch (error: unknown) {
      spinner.fail(chalk.red(`Parse error: ${getErrorMessage(error)}`));
      return;
    }

    // Execute tool
    const execSpinner = ora({
      text: chalk.dim('Executing...'),
      spinner: 'dots',
    }).start();

    let result: ToolResult;
    try {
      result = await this.engine.dispatch(intent);
      execSpinner.stop();
    } catch (error: unknown) {
      execSpinner.fail(chalk.red(`Execution error: ${getErrorMessage(error)}`));
      return;
    }

    // Display result
    console.log(result.message);

    // Handle confirmation flow
    if (result.requiresConfirmation && result.data?.executeAction) {
      const confirmed = await this.confirm(result.confirmationPrompt ?? 'Confirm?');
      if (confirmed) {
        const confirmSpinner = ora({
          text: chalk.dim('Submitting...'),
          spinner: 'dots',
        }).start();

        try {
          const execResult = await result.data.executeAction();
          confirmSpinner.stop();
          console.log(execResult.message);
        } catch (error: unknown) {
          confirmSpinner.fail(chalk.red(`Transaction failed: ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
    }
  }

  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.rl.question(
        `  ${chalk.yellow(prompt)} ${chalk.dim('(yes/no)')} `,
        (answer) => {
          resolve(
            answer.toLowerCase() === 'yes' ||
            answer.toLowerCase() === 'y'
          );
        }
      );
    });
  }
}

import * as readline from 'readline';
import chalk from 'chalk';
import { ToolEngine } from '../tools/engine.js';
import { ParsedIntent, ToolResult } from '../types/index.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Watch Mode ─────────────────────────────────────────────────────────────
//
// Repeatedly executes a read-only CLI command and refreshes the output,
// similar to the Linux `watch` utility.
//
// Design constraints:
//   • Read-only — trading commands are rejected before execution
//   • Uses ANSI cursor control for flicker-free rendering
//   • Cleans up timers and raw mode on exit
//   • Does not modify any other subsystem

const REFRESH_INTERVAL_MS = 5_000;

/** Commands that mutate state — blocked in watch mode */
const BLOCKED_PREFIXES = [
  'open',
  'close',
  'add',
  'remove',
  'wallet import',
  'wallet connect',
  'wallet disconnect',
  'wallet use',
  'wallet remove',
  'autopilot start',
  'autopilot stop',
  'dryrun',
  'dry-run',
  'dry run',
  'doctor',
  'watch',
];

/**
 * Returns an error string if the command is blocked, or null if allowed.
 */
function validateWatchCommand(command: string): string | null {
  const lower = command.toLowerCase().trim();

  for (const prefix of BLOCKED_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + ' ')) {
      return 'watch does not support trading commands.';
    }
  }

  return null;
}

export interface WatchDeps {
  engine: ToolEngine;
  parseCommand: (input: string) => Promise<ParsedIntent>;
  rl: readline.Interface;
}

/**
 * Start watch mode — repeatedly runs a read-only command every 5 seconds.
 * Resolves when the user presses 'q' to exit.
 */
export async function startWatch(
  command: string,
  deps: WatchDeps,
): Promise<void> {
  // ─── Validate command ──────────────────────────────────────────
  const blockReason = validateWatchCommand(command);
  if (blockReason) {
    console.log('');
    console.log(chalk.red(`  Error: ${blockReason}`));
    console.log('');
    return;
  }

  // ─── Parse the inner command once to verify it's valid ─────────
  let intent: ParsedIntent;
  try {
    intent = await deps.parseCommand(command);
  } catch (err) {
    console.log(chalk.red(`  Error parsing command: ${getErrorMessage(err)}`));
    return;
  }

  // ─── State ─────────────────────────────────────────────────────
  let running = true;
  let refreshing = false;

  const header = () => {
    const now = new Date().toLocaleTimeString();
    return [
      '',
      chalk.bold.yellow('  WATCH MODE'),
      chalk.dim(`  ${now}  |  Watching: ${chalk.white(command)}  |  Refresh ${REFRESH_INTERVAL_MS / 1000}s  |  Press ${chalk.white('q')} to exit`),
      chalk.dim('  ' + '─'.repeat(Math.min(process.stdout.columns || 80, 80))),
    ].join('\n');
  };

  const renderOutput = async (): Promise<string> => {
    // Re-parse each refresh so data is fresh (intent may reference cached data)
    let freshIntent: ParsedIntent;
    try {
      freshIntent = await deps.parseCommand(command);
    } catch {
      freshIntent = intent;
    }

    const result: ToolResult = await deps.engine.dispatch(freshIntent);
    return result.message;
  };

  const render = async () => {
    if (!running || refreshing) return;
    refreshing = true;

    try {
      const output = await renderOutput();

      // Move cursor to top-left and clear everything below
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);

      // Print header + output
      process.stdout.write(header() + '\n');
      process.stdout.write(output + '\n');
    } catch (err) {
      // On error, show the error in-place without crashing watch mode
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(header() + '\n');
      process.stdout.write(chalk.red(`\n  Refresh error: ${getErrorMessage(err)}\n`));
    } finally {
      refreshing = false;
    }
  };

  // ─── Initial render ────────────────────────────────────────────
  await render();

  // ─── Refresh interval ─────────────────────────────────────────
  const interval = setInterval(() => {
    if (running && !refreshing) {
      render().catch(() => {});
    }
  }, REFRESH_INTERVAL_MS);
  interval.unref();

  // ─── Key listener — exit on 'q' ───────────────────────────────
  await new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onKey = (data: Buffer) => {
      const key = data.toString();

      // Exit on 'q', 'Q', or Ctrl+C (0x03)
      if (key === 'q' || key === 'Q' || key === '\x03') {
        running = false;
        clearInterval(interval);
        process.stdin.removeListener('data', onKey);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }

        // Clear screen and show exit message
        readline.cursorTo(process.stdout, 0, 0);
        readline.clearScreenDown(process.stdout);
        console.log(chalk.dim('  Watch mode stopped.\n'));
        resolve();
      }
    };

    process.stdin.on('data', onKey);
  });
}

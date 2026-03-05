import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  [LogLevel.Debug]: chalk.gray,
  [LogLevel.Info]: chalk.cyan,
  [LogLevel.Warn]: chalk.yellow,
  [LogLevel.Error]: chalk.red,
};

export class Logger {
  private level: LogLevel;
  private logFilePath: string | null;
  private showInCli: boolean;

  constructor(opts?: {
    level?: LogLevel;
    logFile?: string;
    showInCli?: boolean;
  }) {
    this.level = opts?.level ?? LogLevel.Info;
    this.logFilePath = opts?.logFile ?? null;
    this.showInCli = opts?.showInCli ?? false;

    if (this.logFilePath) {
      const dir = dirname(this.logFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Info, category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Error, category, message, data);
  }

  trade(action: string, details: Record<string, unknown>): void {
    this.info('TRADE', `${action}`, details);
  }

  api(endpoint: string, details?: Record<string, unknown>): void {
    this.debug('API', endpoint, details);
  }

  private log(
    level: LogLevel,
    category: string,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    // Write to file
    if (this.logFilePath) {
      this.writeToFile(entry);
    }

    // Show in CLI (only for warn/error by default, or if showInCli is true)
    if (this.showInCli || level >= LogLevel.Warn) {
      this.writeToConsole(entry);
    }
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.logFilePath) return;
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    const line = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}] ${entry.message}${dataStr}\n`;
    try {
      appendFileSync(this.logFilePath, line);
    } catch {
      // Silently fail file writes to avoid crashing the CLI
    }
  }

  private writeToConsole(entry: LogEntry): void {
    const colorFn = LEVEL_COLORS[entry.level];
    const label = colorFn(`[${LEVEL_LABELS[entry.level]}]`);
    const cat = chalk.dim(`[${entry.category}]`);
    const msg = entry.level >= LogLevel.Error ? chalk.red(entry.message) : entry.message;
    console.error(`  ${label} ${cat} ${msg}`);
  }
}

// Singleton logger instance
let _logger: Logger | null = null;

export function initLogger(opts?: {
  level?: LogLevel;
  logFile?: string;
  showInCli?: boolean;
}): Logger {
  _logger = new Logger(opts);
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    _logger = new Logger();
  }
  return _logger;
}

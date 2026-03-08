import { appendFile, appendFileSync, mkdirSync, existsSync, writeFileSync, chmodSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10MB max before rotation

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
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // Create file with restricted permissions (owner-only read/write)
      if (!existsSync(this.logFilePath)) {
        writeFileSync(this.logFilePath, '', { mode: 0o600 });
      }
      try {
        chmodSync(this.logFilePath, 0o600);
      } catch {
        // Best-effort permission setting
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

  /** Scrub sensitive data from strings before writing to logs. */
  private scrub(text: string): string {
    return text
      .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***')
      .replace(/sk-ant-[^\s"]+/g, 'sk-ant-***')
      .replace(/gsk_[^\s"]+/g, 'gsk_***');
  }

  private logRotationChecked = 0;

  private writeToFile(entry: LogEntry): void {
    if (!this.logFilePath) return;
    const dataStr = entry.data ? ` ${this.scrub(JSON.stringify(entry.data))}` : '';
    const raw = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}] ${this.scrub(entry.message)}${dataStr}\n`;
    const line = raw;

    // Check log size periodically (every ~100 writes) and rotate if needed
    if (++this.logRotationChecked % 100 === 0) {
      try {
        const size = statSync(this.logFilePath).size;
        if (size > MAX_LOG_FILE_BYTES) {
          const rotated = this.logFilePath + '.old';
          try { renameSync(rotated, rotated + '.2'); } catch { /* ignore */ }
          renameSync(this.logFilePath, rotated);
          writeFileSync(this.logFilePath, '', { mode: 0o600 });
        }
      } catch { /* best-effort rotation */ }
    }

    appendFile(this.logFilePath, line, () => {
      // Fire-and-forget — silently ignore write errors to avoid crashing the CLI
    });
  }

  /**
   * Write a final log entry synchronously (for shutdown).
   * Ensures the entry is flushed to disk before process.exit().
   */
  flushSync(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.logFilePath) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel.Info,
      category,
      message,
      data,
    };
    const dataStr = entry.data ? ` ${this.scrub(JSON.stringify(entry.data))}` : '';
    const line = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}] ${this.scrub(entry.message)}${dataStr}\n`;
    try {
      appendFileSync(this.logFilePath, line);
    } catch {
      // Best-effort
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

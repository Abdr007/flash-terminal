import { appendFile, appendFileSync, mkdirSync, existsSync, writeFileSync, chmodSync, statSync, renameSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
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
      // Validate log file path — must be under home directory to prevent arbitrary writes
      const resolvedPath = resolve(this.logFilePath);
      const home = homedir();
      const homePrefix = home.endsWith('/') ? home : home + '/';
      if (resolvedPath !== home && !resolvedPath.startsWith(homePrefix)) {
        this.logFilePath = null; // Reject paths outside home directory
      }
    }

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

    // Show in CLI only if explicitly enabled (showInCli) or for errors
    if (this.showInCli || level >= LogLevel.Error) {
      this.writeToConsole(entry);
    }
  }

  /** Scrub sensitive data from strings before writing to logs. */
  private scrub(text: string): string {
    return text
      .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***')
      .replace(/sk-ant-[^\s"]+/g, 'sk-ant-***')
      .replace(/gsk_[^\s"]+/g, 'gsk_***')
      // [L-12] Mask base58 private keys (64-88 chars of base58 alphabet)
      .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/g, (m) => m.slice(0, 8) + '***REDACTED***');
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

/** Parse FLASH_LOG_LEVEL env var to LogLevel. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const map: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };
  return map[value.toLowerCase()];
}

// Singleton logger instance
let _logger: Logger | null = null;

export function initLogger(opts?: {
  level?: LogLevel;
  logFile?: string;
  showInCli?: boolean;
}): Logger {
  // FLASH_LOG_LEVEL env var — overrides default level unless explicitly provided
  const envLevel = parseLogLevel(process.env.FLASH_LOG_LEVEL);
  const level = opts?.level ?? envLevel ?? LogLevel.Info;
  _logger = new Logger({ ...opts, level });
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    const envLevel = parseLogLevel(process.env.FLASH_LOG_LEVEL);
    _logger = new Logger({ level: envLevel ?? LogLevel.Info });
  }
  return _logger;
}

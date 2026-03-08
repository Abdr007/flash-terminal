import chalk from 'chalk';

// ─── Flash Terminal Theme ───────────────────────────────────────────────────
//
// Centralized theme for consistent professional trading-terminal styling.
// Uses a Flash-inspired color palette: green accent (#00FF88), dark terminal.
//
// This module is display-only. It does not modify any trading logic.

// ─── Color Palette ──────────────────────────────────────────────────────────

const ACCENT = chalk.hex('#00FF88');
const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');
const TEXT = chalk.hex('#B8C1BB');
const BRIGHT = chalk.white;

// ─── Theme Helpers ──────────────────────────────────────────────────────────

export const theme = {
  // ── Structural ────────────────────────────────────────────────────

  /** Main section header — e.g. "POSITIONS", "PORTFOLIO SUMMARY" */
  header(text: string): string {
    return ACCENT_BOLD(text);
  },

  /** Sub-section label — e.g. "Directional Bias", "Quick Start" */
  section(text: string): string {
    return chalk.bold(text);
  },

  /** Horizontal divider line */
  separator(width = 40): string {
    return MUTED('─'.repeat(width));
  },

  /** Full-width separator matching terminal width */
  fullSeparator(): string {
    return MUTED('─'.repeat(Math.min(process.stdout.columns || 80, 80)));
  },

  // ── Text ──────────────────────────────────────────────────────────

  /** Primary label text — field names, row labels */
  label(text: string): string {
    return MUTED(text);
  },

  /** Primary value text */
  value(text: string): string {
    return BRIGHT(text);
  },

  /** Accent-colored value — important data points */
  accent(text: string): string {
    return ACCENT(text);
  },

  /** Accent bold — titles, key metrics */
  accentBold(text: string): string {
    return ACCENT_BOLD(text);
  },

  /** Dimmed / secondary text */
  dim(text: string): string {
    return MUTED(text);
  },

  /** Neutral body text */
  text(text: string): string {
    return TEXT(text);
  },

  // ── Semantic Colors ───────────────────────────────────────────────

  /** Positive values — profit, success, connected */
  positive(text: string): string {
    return chalk.hex('#00FF88')(text);
  },

  /** Negative values — loss, error, disconnected */
  negative(text: string): string {
    return chalk.red(text);
  },

  /** Warning — caution, approaching limits */
  warning(text: string): string {
    return chalk.yellow(text);
  },

  /** Command syntax highlight */
  command(text: string): string {
    return chalk.cyan(text);
  },

  /** LONG side */
  long(text: string): string {
    return chalk.hex('#00FF88')(text);
  },

  /** SHORT side */
  short(text: string): string {
    return chalk.red(text);
  },

  // ── Mode Badges ───────────────────────────────────────────────────

  /** Simulation mode badge */
  simBadge(text: string): string {
    return chalk.bgYellow.black(` ${text} `);
  },

  /** Live mode badge */
  liveBadge(text: string): string {
    return chalk.bgRed.white.bold(` ${text} `);
  },

  // ── Composite Helpers ─────────────────────────────────────────────

  /** Format a labeled value pair: "  Label:  value" */
  pair(label: string, value: string, labelWidth = 18): string {
    return `  ${MUTED(label.padEnd(labelWidth))}${value}`;
  },

  /** Section title block with separator */
  titleBlock(title: string, width = 40): string {
    return [
      '',
      `  ${ACCENT_BOLD(title)}`,
      `  ${MUTED('─'.repeat(width))}`,
    ].join('\n');
  },

  /** Table header styling */
  tableHeader(text: string): string {
    return MUTED(chalk.bold(text));
  },

  /** Table separator line */
  tableSeparator(width: number): string {
    return MUTED('─'.repeat(width));
  },
};

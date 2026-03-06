import chalk from 'chalk';
import { TradeSide, Position, MarketData, ToolResult } from '../types/index.js';

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value >= 1000) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function colorPnl(value: number): string {
  const formatted = formatUsd(value);
  if (value > 0) return chalk.green(formatted);
  if (value < 0) return chalk.red(formatted);
  return chalk.gray(formatted);
}

export function colorPercent(value: number): string {
  const formatted = formatPercent(value);
  if (value > 0) return chalk.green(formatted);
  if (value < 0) return chalk.red(formatted);
  return chalk.gray(formatted);
}

export function colorSide(side: TradeSide): string {
  return side === TradeSide.Long ? chalk.green('LONG') : chalk.red('SHORT');
}

export function formatPosition(pos: Position): string {
  const lines = [
    `  ${chalk.bold(pos.market)} ${colorSide(pos.side)} ${chalk.dim(`${pos.leverage.toFixed(1)}x`)}`,
    `    Entry: ${formatPrice(pos.entryPrice)}  Current: ${formatPrice(pos.currentPrice)}`,
    `    Size: ${formatUsd(pos.sizeUsd)}  Collateral: ${formatUsd(pos.collateralUsd)}`,
    `    PnL: ${colorPnl(pos.unrealizedPnl)} (${colorPercent(pos.unrealizedPnlPercent)})`,
    `    Liq: ${formatPrice(pos.liquidationPrice)}`,
  ];
  return lines.join('\n');
}

export function formatMarketRow(m: MarketData): string {
  return [
    chalk.bold(m.symbol.padEnd(10)),
    formatPrice(m.price).padEnd(14),
    colorPercent(m.priceChange24h).padEnd(12),
    `OI: ${formatUsd(m.openInterestLong + m.openInterestShort)}`.padEnd(18),
    `Max: ${m.maxLeverage}x`,
  ].join('  ');
}

export function formatToolResult(result: ToolResult): string {
  if (!result.success) {
    return chalk.red(`Error: ${result.message}`);
  }
  return result.message;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => stripAnsi(r[i] || '').length))
  );
  const headerLine = headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join('  ');
  const separator = colWidths.map(w => '─'.repeat(w)).join('──');
  const bodyLines = rows.map(row =>
    row.map((cell, i) => {
      const stripped = stripAnsi(cell);
      const padding = colWidths[i] - stripped.length;
      return cell + ' '.repeat(Math.max(0, padding));
    }).join('  ')
  );
  return [headerLine, separator, ...bodyLines].join('\n');
}

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

export function banner(): string {
  return chalk.yellow(`
  ⚡ FLASH AI TERMINAL ⚡
  ━━━━━━━━━━━━━━━━━━━━━
  AI-Powered Trading on Flash Trade
  `);
}

export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

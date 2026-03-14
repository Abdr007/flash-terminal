/**
 * Telegram message formatter — converts data to clean Telegram-friendly text.
 * Uses MarkdownV2 escaping for Telegram's parser.
 */

import { Position, Portfolio, MarketData } from '../types/index.js';
import { TokenPrice } from '../data/prices.js';

/** Escape special characters for Telegram MarkdownV2 */
export function esc(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Format a number as USD */
function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format price with appropriate decimals */
function price(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return '$' + n.toFixed(4);
  return '$' + n.toPrecision(4);
}

/** Format percent */
function pct(n: number): string {
  if (!Number.isFinite(n)) return '0.00%';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

/** PnL emoji */
function pnlIcon(n: number): string {
  if (n > 0) return '\u{1F7E2}'; // green circle
  if (n < 0) return '\u{1F534}'; // red circle
  return '\u{26AA}';              // white circle
}

/** Risk level emoji */
function riskIcon(distToLiq: number): string {
  if (distToLiq > 0.3) return '\u{2705}';  // green check
  if (distToLiq > 0.15) return '\u{26A0}\u{FE0F}'; // warning
  return '\u{1F6A8}';                        // red siren
}

export function formatPrice(tokenPrice: TokenPrice): string {
  const icon = tokenPrice.priceChange24h >= 0 ? '\u{1F7E2}' : '\u{1F534}';
  return [
    `${icon} *${esc(tokenPrice.symbol)}*`,
    `Price: \`${price(tokenPrice.price)}\``,
    `24h: \`${pct(tokenPrice.priceChange24h)}\``,
  ].join('\n');
}

export function formatPrices(prices: Map<string, TokenPrice>): string {
  if (prices.size === 0) return esc('No price data available.');

  const lines = ['\u{1F4CA} *Market Prices*', ''];
  for (const [, tp] of prices) {
    const icon = tp.priceChange24h >= 0 ? '\u{1F7E2}' : '\u{1F534}';
    lines.push(`${icon} \`${tp.symbol.padEnd(10)}\` \`${price(tp.price).padStart(12)}\`  \`${pct(tp.priceChange24h)}\``);
  }
  return lines.join('\n');
}

export function formatPosition(p: Position): string {
  const side = p.side === 'long' ? '\u{1F7E2} LONG' : '\u{1F534} SHORT';
  const pnlEmoji = pnlIcon(p.unrealizedPnl);
  const distToLiq = Math.abs(p.currentPrice - p.liquidationPrice) / p.entryPrice;
  const risk = riskIcon(distToLiq);

  return [
    `*${esc(p.market)}* ${esc(side)} ${esc(p.leverage.toFixed(1))}x`,
    `Size: \`${usd(p.sizeUsd)}\`  Collateral: \`${usd(p.collateralUsd)}\``,
    `Entry: \`${price(p.entryPrice)}\`  Mark: \`${price(p.currentPrice)}\``,
    `${pnlEmoji} PnL: \`${usd(p.unrealizedPnl)}\` \\(\`${pct(p.unrealizedPnlPercent)}\`\\)`,
    `${risk} Liq: \`${price(p.liquidationPrice)}\` \\(\`${pct(distToLiq * 100)} away\`\\)`,
  ].join('\n');
}

export function formatPositions(positions: Position[]): string {
  if (positions.length === 0) return esc('No open positions.');

  const lines = [`\u{1F4BC} *Open Positions* \\(${positions.length}\\)`, ''];
  for (const p of positions) {
    lines.push(formatPosition(p));
    lines.push('');
  }
  return lines.join('\n');
}

export function formatPortfolio(portfolio: Portfolio): string {
  const totalPnl = portfolio.totalUnrealizedPnl;
  const pnlEmoji = pnlIcon(totalPnl);

  const lines = [
    '\u{1F4B0} *Portfolio Summary*',
    '',
    `Balance: \`${usd(portfolio.balance)}\``,
    `Positions: \`${portfolio.positions.length}\``,
    `Collateral: \`${usd(portfolio.totalCollateralUsd)}\``,
    `Exposure: \`${usd(portfolio.totalPositionValue)}\``,
    `${pnlEmoji} Unrealized PnL: \`${usd(totalPnl)}\``,
    `Realized PnL: \`${usd(portfolio.totalRealizedPnl)}\``,
    `Total Fees: \`${usd(portfolio.totalFees)}\``,
  ];
  return lines.join('\n');
}

export function formatTradeConfirmation(
  action: 'LONG' | 'SHORT',
  market: string,
  collateral: number,
  leverage: number,
  size: number,
  entryPrice: number,
  liqPrice: number,
  fee: number,
): string {
  const icon = action === 'LONG' ? '\u{1F7E2}' : '\u{1F534}';
  return [
    `${icon} *Open ${esc(action)}?*`,
    '',
    `Market: \`${esc(market)}\``,
    `Leverage: \`${leverage}x\``,
    `Collateral: \`${usd(collateral)}\``,
    `Size: \`${usd(size)}\``,
    `Entry: \`${price(entryPrice)}\``,
    `Liq Price: \`${price(liqPrice)}\``,
    `Est\\. Fee: \`${usd(fee)}\``,
  ].join('\n');
}

export function formatTradeResult(
  action: string,
  market: string,
  txSignature: string,
  entryPrice?: number,
  liqPrice?: number,
  pnl?: number,
): string {
  const lines = [
    `\u{2705} *${esc(action)} Executed*`,
    '',
    `Market: \`${esc(market)}\``,
  ];
  if (entryPrice !== undefined) lines.push(`Entry: \`${price(entryPrice)}\``);
  if (liqPrice !== undefined) lines.push(`Liq: \`${price(liqPrice)}\``);
  if (pnl !== undefined) lines.push(`${pnlIcon(pnl)} PnL: \`${usd(pnl)}\``);
  lines.push('');
  lines.push(`[View on Solscan](https://solscan.io/tx/${txSignature})`);
  return lines.join('\n');
}

export function formatError(message: string): string {
  return `\u{274C} ${esc(message)}`;
}

export function formatHelp(): string {
  return [
    '\u{26A1} *Flash Trade Bot*',
    '',
    '*Trading*',
    '`/long SOL 5x $100` \\- Open long',
    '`/short BTC 3x $200` \\- Open short',
    '`/close SOL long` \\- Close position',
    '`/closeall` \\- Close all positions',
    '',
    '*Orders*',
    '`/tp SOL long 145` \\- Take profit',
    '`/sl SOL long 120` \\- Stop loss',
    '',
    '*Info*',
    '`/price SOL` \\- Current price',
    '`/prices` \\- All market prices',
    '`/positions` \\- Open positions',
    '`/portfolio` \\- Portfolio summary',
    '`/balance` \\- Wallet balance',
    '',
    '*System*',
    '`/status` \\- Connection status',
    '`/help` \\- This message',
  ].join('\n');
}

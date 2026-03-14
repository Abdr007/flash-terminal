/**
 * Flash Trade Telegram Bot — personal trading bot.
 *
 * Architecture: Telegram commands → FlashClient → Solana
 * Security: Only responds to OWNER_CHAT_ID. Self-hosted. Your keys, your machine.
 */

import { Bot, Context, InlineKeyboard, session } from 'grammy';
import { loadConfig } from '../config/index.js';
import { getAllMarkets, getPoolForMarket } from '../config/index.js';
import { createConnection } from '../wallet/connection.js';
import { WalletManager } from '../wallet/walletManager.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { PriceService } from '../data/prices.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { IFlashClient, TradeSide, FlashConfig } from '../types/index.js';
import { resolveMarket } from '../utils/market-resolver.js';
import { initLogger, getLogger } from '../utils/logger.js';
import {
  formatPrice as fmtPrice,
  formatPrices,
  formatPositions,
  formatPortfolio,
  formatTradeConfirmation,
  formatTradeResult,
  formatError,
  formatHelp,
  esc,
} from './formatter.js';

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID;
const MAX_TRADE_USD = parseFloat(process.env.TG_MAX_TRADE_USD || '100');

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}
if (!OWNER_CHAT_ID) {
  console.error('TELEGRAM_OWNER_ID not set in .env — required for security.');
  console.error('Send /start to your bot, then check the chat ID in logs.');
  // Don't exit — we'll log the chat ID when someone messages
}

// ── Session types ─────────────────────────────────────────────────────────────

interface PendingTrade {
  action: 'long' | 'short';
  market: string;
  leverage: number;
  collateral: number;
  size: number;
  entryPrice: number;
  liqPrice: number;
  fee: number;
}

interface SessionData {
  pendingTrade?: PendingTrade;
}

type BotContext = Context & { session: SessionData };

// ── Initialize infrastructure ─────────────────────────────────────────────────

const config = loadConfig();
initLogger({ logFile: config.logFile ?? undefined, showInCli: false });
const logger = getLogger();

const connection = createConnection(config.rpcUrl);
const walletManager = new WalletManager(connection);
const walletStore = new WalletStore();
const priceService = new PriceService();

let flashClient: IFlashClient;

// Initialize client based on mode
async function initClient(): Promise<void> {
  if (config.simulationMode) {
    flashClient = new SimulatedFlashClient(10_000);
    logger.info('BOT', 'Initialized in SIMULATION mode');
  } else {
    // Load wallet
    const defaultWallet = walletStore.getDefault();
    if (defaultWallet) {
      try {
        const walletPath = walletStore.getWalletPath(defaultWallet);
        walletManager.loadFromFile(walletPath);
        logger.info('BOT', `Loaded wallet: ${defaultWallet} (${walletManager.address})`);
      } catch (e) {
        logger.warn('BOT', `Failed to load default wallet "${defaultWallet}": ${e}`);
      }
    } else if (config.walletPath) {
      try {
        walletManager.loadFromFile(config.walletPath);
        logger.info('BOT', `Loaded wallet from config: ${walletManager.address}`);
      } catch (e) {
        logger.warn('BOT', `Failed to load wallet from config: ${e}`);
      }
    }

    if (!walletManager.isConnected) {
      logger.warn('BOT', 'No wallet connected — starting in simulation mode');
      flashClient = new SimulatedFlashClient(10_000);
      config.simulationMode = true;
      return;
    }

    try {
      const { FlashClient } = await import('../client/flash-client.js');
      flashClient = new FlashClient(connection, walletManager, config);
      logger.info('BOT', 'Initialized LIVE trading client');
    } catch (e) {
      logger.error('BOT', `Failed to init FlashClient: ${e}`);
      flashClient = new SimulatedFlashClient(10_000);
      config.simulationMode = true;
    }
  }
}

// ── Bot setup ─────────────────────────────────────────────────────────────────

const bot = new Bot<BotContext>(BOT_TOKEN);

// Session middleware
bot.use(session({ initial: (): SessionData => ({}) }));

// ── Security: Owner-only middleware ───────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id?.toString();

  // Always log chat ID for initial setup
  if (!OWNER_CHAT_ID) {
    logger.info('BOT', `Message from chat ID: ${chatId} — set TELEGRAM_OWNER_ID=${chatId} in .env`);
    if (ctx.message?.text === '/start') {
      await ctx.reply(`Your chat ID is: \`${chatId}\`\n\nSet this in your \\.env file:\n\`TELEGRAM\\_OWNER\\_ID=${chatId}\`\n\nThen restart the bot\\.`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  if (chatId !== OWNER_CHAT_ID) {
    logger.warn('BOT', `Unauthorized access attempt from chat ID: ${chatId}`);
    return; // Silent ignore — don't even respond
  }

  await next();
});

// ── Commands: Info (read-only, zero risk) ─────────────────────────────────────

bot.command('start', async (ctx) => {
  const mode = config.simulationMode ? '\u{1F4DD} SIMULATION' : '\u{26A1} LIVE';
  const addr = walletManager.address ? `\`${esc(walletManager.address)}\`` : 'Not connected';

  await ctx.reply(
    [
      '\u{26A1} *Flash Trade Bot*',
      '',
      `Mode: ${esc(mode)}`,
      `Wallet: ${addr}`,
      `Max Trade: \`${esc('$' + MAX_TRADE_USD.toString())}\``,
      '',
      'Type /help for commands\\.',
    ].join('\n'),
    { parse_mode: 'MarkdownV2' },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(formatHelp(), { parse_mode: 'MarkdownV2' });
});

bot.command('status', async (ctx) => {
  const mode = config.simulationMode ? 'SIMULATION' : 'LIVE';
  const addr = walletManager.address || 'Not connected';
  const rpc = config.rpcUrl.includes('helius') ? 'Helius' :
    config.rpcUrl.includes('quicknode') ? 'QuickNode' :
    config.rpcUrl.includes('triton') ? 'Triton' :
    config.rpcUrl.includes('mainnet-beta') ? 'Public RPC' : 'Custom';

  await ctx.reply(
    [
      '\u{1F4E1} *System Status*',
      '',
      `Mode: \`${esc(mode)}\``,
      `Wallet: \`${esc(addr.slice(0, 8))}\\.\\.\\.\``,
      `RPC: \`${esc(rpc)}\``,
      `Max Trade: \`$${esc(MAX_TRADE_USD.toString())}\``,
    ].join('\n'),
    { parse_mode: 'MarkdownV2' },
  );
});

bot.command('price', async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) {
    await ctx.reply(formatError('Usage: /price SOL'), { parse_mode: 'MarkdownV2' });
    return;
  }

  try {
    const resolved = resolveMarket(symbol);
    const prices = await priceService.getPrices([resolved]);
    const tp = prices.get(resolved);
    if (!tp) {
      await ctx.reply(formatError(`No price data for ${symbol}`), { parse_mode: 'MarkdownV2' });
      return;
    }
    await ctx.reply(fmtPrice(tp), { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Failed to get price: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('prices', async (ctx) => {
  try {
    const markets = getAllMarkets();
    const prices = await priceService.getPrices(markets);
    await ctx.reply(formatPrices(prices), { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Failed to get prices: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('positions', async (ctx) => {
  try {
    const positions = await flashClient.getPositions();
    await ctx.reply(formatPositions(positions), { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Failed to get positions: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('portfolio', async (ctx) => {
  try {
    const portfolio = await flashClient.getPortfolio();
    await ctx.reply(formatPortfolio(portfolio), { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Failed to get portfolio: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('balance', async (ctx) => {
  try {
    if (!walletManager.hasAddress) {
      await ctx.reply(formatError('No wallet connected'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const balances = await walletManager.getTokenBalances();
    const lines = [
      '\u{1F4B0} *Wallet Balance*',
      '',
      `SOL: \`${esc(balances.sol.toFixed(4))}\``,
    ];
    for (const t of balances.tokens) {
      lines.push(`${esc(t.symbol)}: \`${esc(t.amount.toFixed(t.amount >= 1 ? 2 : 6))}\``);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Failed to get balance: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

// ── Commands: Trading ─────────────────────────────────────────────────────────

/**
 * Parse trade command: /long SOL 5x $100 or /short BTC 3x $200
 * Returns null if invalid.
 */
function parseTrade(text: string): { side: 'long' | 'short'; market: string; leverage: number; collateral: number } | null {
  // /long SOL 5x $100
  // /long SOL 5x 100
  // /long SOL 5 100
  const match = text.match(/^\/(long|short)\s+(\w+)\s+(\d+(?:\.\d+)?)x?\s+\$?(\d+(?:\.\d+)?)$/i);
  if (!match) return null;

  const side = match[1].toLowerCase() as 'long' | 'short';
  const market = match[2].toUpperCase();
  const leverage = parseFloat(match[3]);
  const collateral = parseFloat(match[4]);

  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) return null;
  if (!Number.isFinite(collateral) || collateral <= 0) return null;

  return { side, market: resolveMarket(market), leverage, collateral };
}

async function handleTrade(ctx: BotContext, side: 'long' | 'short'): Promise<void> {
  const text = `/${side} ${ctx.match || ''}`;
  const parsed = parseTrade(text);

  if (!parsed) {
    await ctx.reply(formatError(`Usage: /${side} SOL 5x $100`), { parse_mode: 'MarkdownV2' });
    return;
  }

  // Safety check: max trade size
  if (parsed.collateral > MAX_TRADE_USD) {
    await ctx.reply(formatError(`Max trade size is $${MAX_TRADE_USD}. Adjust TG_MAX_TRADE_USD in .env.`), { parse_mode: 'MarkdownV2' });
    return;
  }

  // Check market exists
  const pool = getPoolForMarket(parsed.market);
  if (!pool) {
    await ctx.reply(formatError(`Unknown market: ${parsed.market}. Use /prices to see available markets.`), { parse_mode: 'MarkdownV2' });
    return;
  }

  try {
    // Get current price for preview
    const prices = await priceService.getPrices([parsed.market]);
    const tp = prices.get(parsed.market);
    if (!tp || tp.price <= 0) {
      await ctx.reply(formatError(`Cannot get price for ${parsed.market}`), { parse_mode: 'MarkdownV2' });
      return;
    }

    const entryPrice = tp.price;
    const size = parsed.collateral * parsed.leverage;
    const fee = size * 0.0008; // 0.08% protocol fee estimate

    // Simplified liquidation estimate
    const maintenanceMargin = 1 / Math.min(parsed.leverage * 2, 100);
    const liqPrice = side === 'long'
      ? entryPrice * (1 - (1 / parsed.leverage) + maintenanceMargin)
      : entryPrice * (1 + (1 / parsed.leverage) - maintenanceMargin);

    // Store pending trade in session
    ctx.session.pendingTrade = {
      action: side,
      market: parsed.market,
      leverage: parsed.leverage,
      collateral: parsed.collateral,
      size,
      entryPrice,
      liqPrice,
      fee,
    };

    // Show confirmation with inline buttons
    const keyboard = new InlineKeyboard()
      .text('\u{2705} Confirm', 'confirm_trade')
      .text('\u{274C} Cancel', 'cancel_trade');

    await ctx.reply(
      formatTradeConfirmation(
        side.toUpperCase() as 'LONG' | 'SHORT',
        parsed.market,
        parsed.collateral,
        parsed.leverage,
        size,
        entryPrice,
        liqPrice,
        fee,
      ),
      { parse_mode: 'MarkdownV2', reply_markup: keyboard },
    );
  } catch (e: unknown) {
    await ctx.reply(formatError(`Error: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
}

bot.command('long', (ctx) => handleTrade(ctx, 'long'));
bot.command('short', (ctx) => handleTrade(ctx, 'short'));

// ── Callback: Confirm/Cancel trade ────────────────────────────────────────────

bot.callbackQuery('confirm_trade', async (ctx) => {
  const trade = ctx.session.pendingTrade;
  if (!trade) {
    await ctx.answerCallbackQuery({ text: 'No pending trade.' });
    return;
  }

  // Clear pending trade immediately to prevent double execution
  ctx.session.pendingTrade = undefined;
  await ctx.answerCallbackQuery({ text: 'Executing...' });

  // Edit the confirmation message to show "Executing..."
  try {
    await ctx.editMessageText('\u{23F3} Executing trade\\.\\.\\.', { parse_mode: 'MarkdownV2' });
  } catch { /* message might be too old */ }

  try {
    const tradeSide: TradeSide = trade.action === 'long' ? TradeSide.Long : TradeSide.Short;

    const result = await flashClient.openPosition(
      trade.market,
      tradeSide,
      trade.collateral,
      trade.leverage,
    );

    logger.info('BOT', `Trade executed: ${trade.action} ${trade.market} ${trade.leverage}x $${trade.collateral} — tx: ${result.txSignature}`);

    await ctx.editMessageText(
      formatTradeResult(
        `${trade.market} ${trade.action.toUpperCase()} ${trade.leverage}x`,
        trade.market,
        result.txSignature,
        result.entryPrice,
        result.liquidationPrice,
      ),
      { parse_mode: 'MarkdownV2' },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('BOT', `Trade failed: ${msg}`);
    await ctx.editMessageText(formatError(`Trade failed: ${msg}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.callbackQuery('cancel_trade', async (ctx) => {
  ctx.session.pendingTrade = undefined;
  await ctx.answerCallbackQuery({ text: 'Cancelled.' });
  try {
    await ctx.editMessageText(esc('Trade cancelled.'), { parse_mode: 'MarkdownV2' });
  } catch { /* ok */ }
});

// ── Close position ────────────────────────────────────────────────────────────

bot.command('close', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/);
  if (args.length < 2) {
    await ctx.reply(formatError('Usage: /close SOL long'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const market = resolveMarket(args[0].toUpperCase());
  const sideStr = args[1].toLowerCase();
  if (sideStr !== 'long' && sideStr !== 'short') {
    await ctx.reply(formatError('Side must be "long" or "short"'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const pool = getPoolForMarket(market);
  if (!pool) {
    await ctx.reply(formatError(`Unknown market: ${market}`), { parse_mode: 'MarkdownV2' });
    return;
  }

  const side: TradeSide = sideStr === 'long' ? TradeSide.Long : TradeSide.Short;

  try {
    await ctx.reply('\u{23F3} Closing position\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    const result = await flashClient.closePosition(market, side);

    logger.info('BOT', `Position closed: ${market} ${sideStr} — tx: ${result.txSignature}`);

    await ctx.reply(
      formatTradeResult('Position Closed', market, result.txSignature, undefined, undefined, result.pnl),
      { parse_mode: 'MarkdownV2' },
    );
  } catch (e: unknown) {
    await ctx.reply(formatError(`Close failed: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('closeall', async (ctx) => {
  try {
    const positions = await flashClient.getPositions();
    if (positions.length === 0) {
      await ctx.reply(esc('No positions to close.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    await ctx.reply(`\u{23F3} Closing ${positions.length} position\\(s\\)\\.\\.\\.`, { parse_mode: 'MarkdownV2' });

    let closed = 0;
    let failed = 0;
    for (const p of positions) {
      try {
        await flashClient.closePosition(p.market, p.side as TradeSide);
        closed++;
      } catch (e) {
        logger.error('BOT', `Failed to close ${p.market} ${p.side}: ${e}`);
        failed++;
      }
    }

    const msg = failed === 0
      ? `\u{2705} Closed all ${closed} position\\(s\\)\\.`
      : `\u{26A0}\u{FE0F} Closed ${closed}, failed ${failed}\\.`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`Close all failed: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

// ── TP/SL ─────────────────────────────────────────────────────────────────────

bot.command('tp', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/);
  if (args.length < 3) {
    await ctx.reply(formatError('Usage: /tp SOL long 145'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const market = resolveMarket(args[0].toUpperCase());
  const sideStr = args[1].toLowerCase();
  const triggerPrice = parseFloat(args[2]);

  if (sideStr !== 'long' && sideStr !== 'short') {
    await ctx.reply(formatError('Side must be "long" or "short"'), { parse_mode: 'MarkdownV2' });
    return;
  }
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    await ctx.reply(formatError('Invalid price'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const side: TradeSide = sideStr === 'long' ? TradeSide.Long : TradeSide.Short;

  try {
    await ctx.reply('\u{23F3} Setting take profit\\.\\.\\.', { parse_mode: 'MarkdownV2' });
    if (!flashClient.placeTriggerOrder) {
      await ctx.reply(formatError('TP/SL not available in simulation mode'), { parse_mode: 'MarkdownV2' });
      return;
    }
    await flashClient.placeTriggerOrder(market, side, triggerPrice, false);
    await ctx.reply(`\u{2705} Take profit set at \`$${esc(triggerPrice.toString())}\``, { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`TP failed: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('sl', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/);
  if (args.length < 3) {
    await ctx.reply(formatError('Usage: /sl SOL long 120'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const market = resolveMarket(args[0].toUpperCase());
  const sideStr = args[1].toLowerCase();
  const triggerPrice = parseFloat(args[2]);

  if (sideStr !== 'long' && sideStr !== 'short') {
    await ctx.reply(formatError('Side must be "long" or "short"'), { parse_mode: 'MarkdownV2' });
    return;
  }
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    await ctx.reply(formatError('Invalid price'), { parse_mode: 'MarkdownV2' });
    return;
  }

  const side: TradeSide = sideStr === 'long' ? TradeSide.Long : TradeSide.Short;

  try {
    await ctx.reply('\u{23F3} Setting stop loss\\.\\.\\.', { parse_mode: 'MarkdownV2' });
    if (!flashClient.placeTriggerOrder) {
      await ctx.reply(formatError('TP/SL not available in simulation mode'), { parse_mode: 'MarkdownV2' });
      return;
    }
    await flashClient.placeTriggerOrder(market, side, triggerPrice, true);
    await ctx.reply(`\u{2705} Stop loss set at \`$${esc(triggerPrice.toString())}\``, { parse_mode: 'MarkdownV2' });
  } catch (e: unknown) {
    await ctx.reply(formatError(`SL failed: ${e instanceof Error ? e.message : String(e)}`), { parse_mode: 'MarkdownV2' });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

bot.catch((err) => {
  logger.error('BOT', `Unhandled error: ${err.message}`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await initClient();

  const mode = config.simulationMode ? 'SIMULATION' : 'LIVE';
  const addr = walletManager.address || 'none';
  console.log(`\n  Flash Trade Telegram Bot`);
  console.log(`  Mode:   ${mode}`);
  console.log(`  Wallet: ${addr}`);
  console.log(`  Max:    $${MAX_TRADE_USD}/trade`);
  console.log(`  Owner:  ${OWNER_CHAT_ID || 'NOT SET — send /start to get your chat ID'}`);
  console.log(`\n  Bot is running... Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n  Shutting down...');
    bot.stop();
    walletManager.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bot.start();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

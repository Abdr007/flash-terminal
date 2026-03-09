import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ParsedIntent, ParsedIntentSchema, ActionType, TradeSide } from '../types/index.js';
import { getAllMarkets } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const SYSTEM_PROMPT = `You are the Flash AI Terminal intent parser. You convert natural language trading commands into structured JSON actions.

You MUST respond with ONLY a valid JSON object. No explanations, no markdown, no extra text.

Available actions:
- open_position: Open a leveraged position
- close_position: Close an existing position
- add_collateral: Add collateral to a position
- remove_collateral: Remove collateral from a position
- get_positions: View open positions
- get_market_data: Get market prices and data
- get_portfolio: View portfolio summary
- get_volume: Get trading volume data
- get_open_interest: Get open interest data
- get_leaderboard: Get trader leaderboard
- get_trader_profile: Get a trader's profile
- get_fees: Get fee data
- wallet_connect: Connect a wallet from file path
- wallet_import: Import and store a wallet (needs name and path)
- wallet_list: List stored wallets
- wallet_use: Switch to a stored wallet (needs name)
- wallet_remove: Remove a stored wallet (needs name)
- wallet_disconnect: Disconnect the currently active wallet
- wallet_status: Show wallet connection status
- wallet_address: Show connected wallet address
- wallet_balance: Show wallet SOL balance
- wallet_tokens: Show all token balances in the wallet
- flash_markets: List all available trading markets
- help: Show help
- analyze: Analyze a market with strategy signals
- risk_report: Show position risk assessment
- dashboard: Combined portfolio/market/stats view
- whale_activity: Show recent large positions
- scan_markets: Scan all markets for trade opportunities
- portfolio_state: Show portfolio capital allocation state
- portfolio_exposure: Show portfolio exposure breakdown
- portfolio_rebalance: Analyze and suggest portfolio rebalancing

Available markets: ${getAllMarkets().join(', ')}

Side must be "long" or "short".

Examples:
- "open a 5x long on SOL with $500" -> {"action":"open_position","market":"SOL","side":"long","collateral":500,"leverage":5}
- "close my SOL long" -> {"action":"close_position","market":"SOL","side":"long"}
- "add $200 collateral to my BTC short" -> {"action":"add_collateral","market":"BTC","side":"short","amount":200}
- "remove $100 from my ETH long" -> {"action":"remove_collateral","market":"ETH","side":"long","amount":100}
- "show positions" -> {"action":"get_positions"}
- "SOL price" -> {"action":"get_market_data","market":"SOL"}
- "portfolio" -> {"action":"get_portfolio"}
- "volume" -> {"action":"get_volume"}
- "leaderboard" -> {"action":"get_leaderboard"}
- "wallet connect /path/to/key.json" -> {"action":"wallet_connect","path":"/path/to/key.json"}
- "wallet import main /path/to/key.json" -> {"action":"wallet_import","name":"main","path":"/path/to/key.json"}
- "wallet list" -> {"action":"wallet_list"}
- "wallet use main" -> {"action":"wallet_use","name":"main"}
- "wallet remove old" -> {"action":"wallet_remove","name":"old"}
- "wallet disconnect" -> {"action":"wallet_disconnect"}
- "wallet" -> {"action":"wallet_status"}
- "wallet address" -> {"action":"wallet_address"}
- "wallet balance" -> {"action":"wallet_balance"}
- "help" -> {"action":"help"}
- "analyze SOL" -> {"action":"analyze","market":"SOL"}
- "risk report" -> {"action":"risk_report"}
- "dashboard" -> {"action":"dashboard"}
- "whale activity" -> {"action":"whale_activity"}
- "whale activity SOL" -> {"action":"whale_activity","market":"SOL"}
- "scan" -> {"action":"scan_markets"}
- "scan markets" -> {"action":"scan_markets"}
- "portfolio state" -> {"action":"portfolio_state"}
- "portfolio exposure" -> {"action":"portfolio_exposure"}
- "exposure" -> {"action":"portfolio_exposure"}
- "rebalance" -> {"action":"portfolio_rebalance"}
- "portfolio rebalance" -> {"action":"portfolio_rebalance"}

Rules:
- Market symbols are UPPERCASE
- Default leverage is 1.1 if not specified
- Default side is "long" if not specified
- Collateral amounts are in USD
- Parse "$500", "500 dollars", "500 USDC" -> 500
- Parse "5x", "5 times", "leverage 5" -> 5`;

function parseSide(raw: string): TradeSide | null {
  if (raw === 'long') return TradeSide.Long;
  if (raw === 'short') return TradeSide.Short;
  return null;
}

// ─── Number Word Normalization ────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/** Convert number words to digits: "ten" → "10", "twenty five" → "25" */
function normalizeNumberWords(text: string): string {
  let result = text;
  // Handle compound forms: "twenty five" → "25"
  result = result.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_match, tens: string, ones: string) => {
      const t = NUMBER_WORDS[tens.toLowerCase()] ?? 0;
      const o = NUMBER_WORDS[ones.toLowerCase()] ?? 0;
      return String(t + o);
    },
  );
  // Handle "X hundred" multiplier
  result = result.replace(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+hundred\b/gi,
    (_match, n: string) => {
      const val = NUMBER_WORDS[n.toLowerCase()] ?? parseInt(n, 10);
      return Number.isFinite(val) ? String(val * 100) : n;
    },
  );
  // Handle "X thousand" multiplier
  result = result.replace(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+thousand\b/gi,
    (_match, n: string) => {
      const val = NUMBER_WORDS[n.toLowerCase()] ?? parseInt(n, 10);
      return Number.isFinite(val) ? String(val * 1000) : n;
    },
  );
  // Handle standalone number words
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    if (num >= 100) continue; // multipliers handled above
    result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), String(num));
  }
  return result;
}

// ─── Asset Alias Dictionary ───────────────────────────────────────────────

const ASSET_ALIASES: Record<string, string> = {
  solana: 'SOL', bitcoin: 'BTC', ethereum: 'ETH', ether: 'ETH',
  binance: 'BNB', jupiter: 'JUP', raydium: 'RAY',
  dogwifhat: 'WIF', bonk: 'BONK', pyth: 'PYTH',
  gold: 'XAU', silver: 'XAG', crude: 'CRUDEOIL', oil: 'CRUDEOIL',
  jito: 'JTO', kamino: 'KMNO', metaplex: 'MET',
  pengu: 'PENGU', penguin: 'PENGU', fartcoin: 'FARTCOIN',
  hype: 'HYPE', hyperliquid: 'HYPE', ore: 'ORE',
  zcash: 'ZEC', euro: 'EUR', pound: 'GBP', sterling: 'GBP',
  yen: 'USDJPY', yuan: 'USDCNH',
  pump: 'PUMP', pumpfun: 'PUMP',
};

/** Normalize asset aliases: "solana" → "SOL" */
function normalizeAssetAliases(text: string): string {
  let result = text;
  for (const [alias, symbol] of Object.entries(ASSET_ALIASES)) {
    result = result.replace(new RegExp(`\\b${alias}\\b`, 'gi'), symbol.toLowerCase());
  }
  return result;
}

/**
 * Fast local regex-based parser for common commands.
 * Exported so it can be used by both AIInterpreter and OfflineInterpreter.
 */
export function localParse(input: string): ParsedIntent | null {
  // Sanitize: collapse whitespace (tabs, newlines, etc.) to single spaces, strip control chars
  const sanitized = input.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Pre-process: normalize number words and asset aliases
  const normalized = normalizeAssetAliases(normalizeNumberWords(sanitized));
  const lower = normalized.toLowerCase();

  // Help
  if (/^(help|commands|\?)$/.test(lower)) {
    return { action: ActionType.Help };
  }

  // Wallet commands
  const walletImportMatch = lower.match(/^wallet\s+import\s+(\S+)\s+(.+)$/);
  if (walletImportMatch) {
    return { action: ActionType.WalletImport, name: walletImportMatch[1], path: walletImportMatch[2].trim() };
  }
  // Bare "wallet import" without args — route to import tool with empty params so it shows usage
  if (/^wallet\s+import$/.test(lower)) {
    return { action: ActionType.WalletImport, name: '', path: '' };
  }
  if (/^wallet\s+list$/.test(lower)) {
    return { action: ActionType.WalletList };
  }
  const walletUseMatch = lower.match(/^wallet\s+use\s+(\S+)$/);
  if (walletUseMatch) {
    return { action: ActionType.WalletUse, name: walletUseMatch[1] };
  }
  const walletRemoveMatch = lower.match(/^wallet\s+remove\s+(\S+)$/);
  if (walletRemoveMatch) {
    return { action: ActionType.WalletRemove, name: walletRemoveMatch[1] };
  }
  if (/^wallet\s+disconnect$/.test(lower)) {
    return { action: ActionType.WalletDisconnect };
  }
  const walletConnectMatch = lower.match(/^wallet\s+connect\s+(.+)$/);
  if (walletConnectMatch) {
    return { action: ActionType.WalletConnect, path: walletConnectMatch[1].trim() };
  }
  // Bare "wallet connect" without path — still route to connect tool with empty path so it shows usage
  if (/^wallet\s+connect$/.test(lower)) {
    return { action: ActionType.WalletConnect, path: '' };
  }
  if (/^wallet\s+(address|addr)$/.test(lower)) {
    return { action: ActionType.WalletAddress };
  }
  if (/^wallet\s+(balance|bal)$/.test(lower)) {
    return { action: ActionType.WalletBalance };
  }
  if (/^wallet\s+tokens?$/.test(lower)) {
    return { action: ActionType.WalletTokens };
  }
  // Bare "wallet" → wallet status
  if (/^wallet$/.test(lower)) {
    return { action: ActionType.WalletStatus };
  }

  // Portfolio / balance
  if (/^(portfolio|balance|account)$/.test(lower)) {
    return { action: ActionType.GetPortfolio };
  }

  // Positions
  if (/^(positions?|my positions?|show positions?|open positions?)$/.test(lower)) {
    return { action: ActionType.GetPositions };
  }

  // Volume
  if (/^(volume|trading volume|show volume)$/.test(lower)) {
    return { action: ActionType.GetVolume };
  }

  // Open interest
  if (/^(open interest|oi|show oi)$/.test(lower)) {
    return { action: ActionType.GetOpenInterest };
  }

  // Leaderboard
  if (/^(leaderboard|top traders?|rankings?)$/.test(lower)) {
    return { action: ActionType.GetLeaderboard };
  }

  // Fees
  if (/^(fees?|trading fees?|show fees?)$/.test(lower)) {
    return { action: ActionType.GetFees };
  }

  // Flash markets list
  if (/^(?:flash\s+)?markets$/.test(lower)) {
    return { action: ActionType.FlashMarkets };
  }

  // Market data: "SOL price", "price of BTC", "all markets"
  if (/^(all markets)$/.test(lower)) {
    return { action: ActionType.GetMarketData };
  }
  const priceMatch = lower.match(/^(?:price of\s+)?([a-z]+)\s*(?:price)?$/);
  if (priceMatch) {
    const sym = priceMatch[1].toUpperCase();
    if (getAllMarkets().includes(sym)) {
      return { action: ActionType.GetMarketData, market: sym };
    }
  }

  // Open position: "open 5x long SOL $500"
  const openMatch = lower.match(
    /^(?:open|buy|enter)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*x?\s*(long|short)\s+(?:position\s+)?(?:on\s+)?([a-z]+)\s+(?:with\s+)?\$?(\d+(?:\.\d+)?)$/
  );
  if (openMatch) {
    const side = parseSide(openMatch[2]);
    if (side) {
      return {
        action: ActionType.OpenPosition,
        market: openMatch[3].toUpperCase(),
        side,
        collateral: parseFloat(openMatch[4]),
        leverage: parseFloat(openMatch[1]),
      };
    }
  }

  // Alternate: "long SOL $500 5x"
  const openMatch2 = lower.match(
    /^(long|short)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*x$/
  );
  if (openMatch2) {
    const side = parseSide(openMatch2[1]);
    if (side) {
      return {
        action: ActionType.OpenPosition,
        market: openMatch2[2].toUpperCase(),
        side,
        collateral: parseFloat(openMatch2[3]),
        leverage: parseFloat(openMatch2[4]),
      };
    }
  }

  // Close position: "close SOL long", "close my SOL position", "close SOL"
  const closeMatch = lower.match(
    /^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)\s+(long|short)(?:\s+position)?$/
  );
  if (closeMatch) {
    const side = parseSide(closeMatch[2]);
    if (side) {
      return {
        action: ActionType.ClosePosition,
        market: closeMatch[1].toUpperCase(),
        side,
      };
    }
  }

  // Close position without side: "close SOL" — side will be auto-detected at execution
  const closeNoSideMatch = lower.match(
    /^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)(?:\s+position)?$/
  );
  if (closeNoSideMatch) {
    const sym = closeNoSideMatch[1].toUpperCase();
    if (getAllMarkets().includes(sym)) {
      return {
        action: ActionType.ClosePosition,
        market: sym,
        // side omitted — terminal will auto-detect from open positions
      } as ParsedIntent;
    }
  }

  // Add collateral: "add $200 to SOL long", "add collateral of $50 to SOL long", "add $200 to SOL"
  const addCollMatch = lower.match(
    /^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:to\s+)?(?:my\s+)?([a-z]+)\s+(long|short)$/
  );
  if (addCollMatch) {
    const side = parseSide(addCollMatch[3]);
    if (side) {
      return {
        action: ActionType.AddCollateral,
        market: addCollMatch[2].toUpperCase(),
        side,
        amount: parseFloat(addCollMatch[1]),
      };
    }
  }

  // Add collateral without side: "add $200 to SOL" — side will be auto-detected
  const addCollNoSideMatch = lower.match(
    /^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:to\s+)?(?:my\s+)?([a-z]+)$/
  );
  if (addCollNoSideMatch) {
    const sym = addCollNoSideMatch[2].toUpperCase();
    if (getAllMarkets().includes(sym)) {
      return {
        action: ActionType.AddCollateral,
        market: sym,
        amount: parseFloat(addCollNoSideMatch[1]),
      } as ParsedIntent;
    }
  }

  // Remove collateral: "remove $100 from ETH long", "remove $100 from ETH"
  const rmCollMatch = lower.match(
    /^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:from\s+)?(?:my\s+)?([a-z]+)\s+(long|short)$/
  );
  if (rmCollMatch) {
    const side = parseSide(rmCollMatch[3]);
    if (side) {
      return {
        action: ActionType.RemoveCollateral,
        market: rmCollMatch[2].toUpperCase(),
        side,
        amount: parseFloat(rmCollMatch[1]),
      };
    }
  }

  // Remove collateral without side: "remove $100 from SOL" — side will be auto-detected
  const rmCollNoSideMatch = lower.match(
    /^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:from\s+)?(?:my\s+)?([a-z]+)$/
  );
  if (rmCollNoSideMatch) {
    const sym = rmCollNoSideMatch[2].toUpperCase();
    if (getAllMarkets().includes(sym)) {
      return {
        action: ActionType.RemoveCollateral,
        market: sym,
        amount: parseFloat(rmCollNoSideMatch[1]),
      } as ParsedIntent;
    }
  }

  // ─── AI Agent Commands ──────────────────────────────────────────────────

  // Analyze: "analyze SOL", "analyze BTC"
  const analyzeMatch = lower.match(/^analyze\s+([a-z]+)$/);
  if (analyzeMatch) {
    return { action: ActionType.Analyze, market: analyzeMatch[1].toUpperCase() };
  }

  // Risk report: "risk report", "risk"
  if (/^(risk report|risk)$/.test(lower)) {
    return { action: ActionType.RiskReport };
  }

  // Dashboard: "dashboard", "dash"
  if (/^(dashboard|dash)$/.test(lower)) {
    return { action: ActionType.Dashboard };
  }

  // Whale activity: "whale activity", "whales", "whale activity SOL"
  const whaleMatch = lower.match(/^(?:whale\s+activity|whales?)(?:\s+([a-z]+))?$/);
  if (whaleMatch) {
    return {
      action: ActionType.WhaleActivity,
      ...(whaleMatch[1] ? { market: whaleMatch[1].toUpperCase() } : {}),
    };
  }

  // Market Scanner
  if (/^(?:scan|scan\s+markets?|scan\s+opportunities?)$/.test(lower)) {
    return { action: ActionType.ScanMarkets };
  }

  // Trade History / Journal
  if (/^(?:trade\s+history|trades|journal|trade\s+journal|history)$/.test(lower)) {
    return { action: ActionType.TradeHistory };
  }

  // Market Monitor
  if (/^(?:market\s+monitor|monitor|watch|watch\s+markets?)$/.test(lower)) {
    return { action: ActionType.MarketMonitor };
  }

  // ─── Dry Run Command ────────────────────────────────────────────────────

  const dryrunMatch = lower.match(/^(?:dryrun|dry-run|dry\s+run)\s+(.+)$/);
  if (dryrunMatch) {
    return { action: ActionType.DryRun, innerCommand: dryrunMatch[1] };
  }

  // ─── Portfolio Intelligence Commands ──────────────────────────────────────

  if (/^(?:portfolio\s+state|portfolio\s+status|capital)$/.test(lower)) {
    return { action: ActionType.PortfolioState };
  }

  if (/^(?:portfolio\s+exposure|exposure)$/.test(lower)) {
    return { action: ActionType.PortfolioExposure };
  }

  if (/^(?:portfolio\s+rebalance|rebalance)$/.test(lower)) {
    return { action: ActionType.PortfolioRebalance };
  }

  return null;
}

// ─── Conversation Context for Follow-Up Commands ──────────────────────────

interface CommandContext {
  lastMarket?: string;
  lastSide?: TradeSide;
  lastLeverage?: number;
  lastCollateral?: number;
  lastAction?: ActionType;
  updatedAt: number;
}

const CONTEXT_TTL_MS = 120_000; // 2 minutes

export class AIInterpreter {
  private anthropic: Anthropic | null;
  private groq: OpenAI | null;
  private context: CommandContext = { updatedAt: 0 };

  constructor(apiKey: string, groqApiKey?: string) {
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    this.groq = groqApiKey
      ? new OpenAI({ apiKey: groqApiKey, baseURL: 'https://api.groq.com/openai/v1' })
      : null;
  }

  private static readonly MAX_INPUT_LENGTH = 500;
  private static readonly API_TIMEOUT_MS = 15_000;

  /** Update conversation context after a successful parse. */
  private updateContext(intent: ParsedIntent): void {
    const now = Date.now();
    if ('market' in intent && intent.market) this.context.lastMarket = intent.market as string;
    if ('side' in intent) this.context.lastSide = intent.side as TradeSide;
    if ('leverage' in intent) this.context.lastLeverage = intent.leverage as number;
    if ('collateral' in intent) this.context.lastCollateral = intent.collateral as number;
    this.context.lastAction = intent.action;
    this.context.updatedAt = now;
  }

  /** Get fresh context (returns undefined if expired). */
  private getContext(): CommandContext | undefined {
    if (Date.now() - this.context.updatedAt > CONTEXT_TTL_MS) return undefined;
    return this.context;
  }

  /**
   * Try to resolve follow-up commands using conversation context.
   * e.g., after "analyze SOL", "close it" → close SOL long
   */
  private tryContextualParse(userInput: string): ParsedIntent | null {
    const ctx = this.getContext();
    if (!ctx) return null;

    const lower = normalizeAssetAliases(normalizeNumberWords(userInput))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // "close it" / "close that" / "close the position"
    if (/^close\s+(it|that|the\s+position)$/.test(lower) && ctx.lastMarket && ctx.lastSide) {
      return { action: ActionType.ClosePosition, market: ctx.lastMarket, side: ctx.lastSide };
    }

    // "increase to $X" / "change collateral to $X"
    const increaseMatch = lower.match(/^(?:increase|change|set)\s+(?:it\s+)?(?:collateral\s+)?to\s+\$?(\d+(?:\.\d+)?)$/);
    if (increaseMatch && ctx.lastMarket && ctx.lastSide && ctx.lastCollateral) {
      const newAmount = parseFloat(increaseMatch[1]);
      const diff = newAmount - ctx.lastCollateral;
      if (diff > 0) {
        return { action: ActionType.AddCollateral, market: ctx.lastMarket, side: ctx.lastSide, amount: diff };
      }
    }

    // "add $X to it" / "add $X more"
    const addMatch = lower.match(/^add\s+\$?(\d+(?:\.\d+)?)\s+(?:to\s+it|more|to\s+that)$/);
    if (addMatch && ctx.lastMarket && ctx.lastSide) {
      return { action: ActionType.AddCollateral, market: ctx.lastMarket, side: ctx.lastSide, amount: parseFloat(addMatch[1]) };
    }

    // "analyze it" / "what about it"
    if (/^(?:analyze\s+it|what\s+about\s+it)$/.test(lower) && ctx.lastMarket) {
      return { action: ActionType.Analyze, market: ctx.lastMarket };
    }

    return null;
  }

  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const logger = getLogger();

    // Try local pattern matching first for speed
    const localResult = localParse(userInput);
    if (localResult) {
      logger.debug('AI', 'Parsed locally', { input: userInput, action: localResult.action });
      this.updateContext(localResult);
      return localResult;
    }

    // Try contextual follow-up resolution
    const contextResult = this.tryContextualParse(userInput);
    if (contextResult) {
      logger.debug('AI', 'Parsed with context', { input: userInput, action: contextResult.action });
      this.updateContext(contextResult);
      return contextResult;
    }

    // Input length limit before sending to AI
    if (userInput.length > AIInterpreter.MAX_INPUT_LENGTH) {
      logger.info('AI', `Input too long (${userInput.length} chars, max ${AIInterpreter.MAX_INPUT_LENGTH})`);
      return { action: ActionType.Help };
    }

    // Try primary AI provider first, then Groq as fallback
    if (this.anthropic) {
      const result = await this.tryAnthropic(userInput);
      if (result) { this.updateContext(result); return result; }
    }

    if (this.groq) {
      const result = await this.tryGroq(userInput);
      if (result) { this.updateContext(result); return result; }
    }

    logger.info('AI', 'No AI provider available. Using local parsing only.');
    return { action: ActionType.Help };
  }

  private async tryAnthropic(userInput: string): Promise<ParsedIntent | null> {
    const logger = getLogger();
    logger.debug('AI', 'Calling primary AI API', { input: userInput });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AIInterpreter.API_TIMEOUT_MS);

      let response;
      try {
        response = await this.anthropic!.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userInput }],
        }, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (response.content.length === 0 || response.content[0].type !== 'text') {
        logger.info('AI', 'Empty response from primary AI');
        return null;
      }

      return this.parseJsonResponse(response.content[0].text, 'primary');
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      if (msg.includes('credit balance') || msg.includes('401') || msg.includes('403') || msg.includes('429') || msg.includes('abort') || msg.includes('timeout')) {
        logger.info('AI', `Primary AI unavailable (${msg}). Trying fallback...`);
      } else {
        logger.error('AI', `Primary AI parse failed: ${msg}`);
      }
      return null;
    }
  }

  private async tryGroq(userInput: string): Promise<ParsedIntent | null> {
    const logger = getLogger();
    logger.debug('AI', 'Calling Groq API', { input: userInput });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AIInterpreter.API_TIMEOUT_MS);

      let response;
      try {
        response = await this.groq!.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 256,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userInput },
          ],
          temperature: 0,
        }, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      const text = response.choices[0]?.message?.content;
      if (!text) {
        logger.info('AI', 'Empty response from Groq');
        return null;
      }

      return this.parseJsonResponse(text, 'Groq');
    } catch (error: unknown) {
      logger.info('AI', `Groq parse failed: ${getErrorMessage(error)}`);
      return null;
    }
  }

  private parseJsonResponse(text: string, source: string): ParsedIntent | null {
    const logger = getLogger();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.info('AI', `No JSON in ${source} response`, { text });
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (typeof parsed === 'object' && parsed !== null && 'market' in parsed) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.market === 'string') {
          obj.market = obj.market.toUpperCase();
        }
      }

      const validated = ParsedIntentSchema.parse(parsed);

      // Reject negative amounts that AI may have silently converted to positive
      const intentAny = validated as Record<string, unknown>;
      if (typeof intentAny.collateral === 'number' && intentAny.collateral <= 0) {
        logger.info('AI', `${source} returned non-positive collateral: ${intentAny.collateral}`);
        return null;
      }
      if (typeof intentAny.amount === 'number' && intentAny.amount <= 0) {
        logger.info('AI', `${source} returned non-positive amount: ${intentAny.amount}`);
        return null;
      }

      logger.debug('AI', `${source} parsed intent`, { action: validated.action });
      return validated;
    } catch (error: unknown) {
      logger.info('AI', `${source} JSON parse failed: ${getErrorMessage(error)}`);
      return null;
    }
  }
}

/**
 * Offline interpreter that only uses local regex parsing.
 * Used when no API key is configured.
 */
export class OfflineInterpreter {
  private context: CommandContext = { updatedAt: 0 };

  /** Update conversation context after a successful parse. */
  private updateContext(intent: ParsedIntent): void {
    const now = Date.now();
    if ('market' in intent && intent.market) this.context.lastMarket = intent.market as string;
    if ('side' in intent) this.context.lastSide = intent.side as TradeSide;
    if ('leverage' in intent) this.context.lastLeverage = intent.leverage as number;
    if ('collateral' in intent) this.context.lastCollateral = intent.collateral as number;
    this.context.lastAction = intent.action;
    this.context.updatedAt = now;
  }

  /** Get fresh context (returns undefined if expired). */
  private getContext(): CommandContext | undefined {
    if (Date.now() - this.context.updatedAt > CONTEXT_TTL_MS) return undefined;
    return this.context;
  }

  /** Try to resolve follow-up commands using conversation context. */
  private tryContextualParse(userInput: string): ParsedIntent | null {
    const ctx = this.getContext();
    if (!ctx) return null;

    const lower = normalizeAssetAliases(normalizeNumberWords(userInput))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (/^close\s+(it|that|the\s+position)$/.test(lower) && ctx.lastMarket && ctx.lastSide) {
      return { action: ActionType.ClosePosition, market: ctx.lastMarket, side: ctx.lastSide };
    }

    const increaseMatch = lower.match(/^(?:increase|change|set)\s+(?:it\s+)?(?:collateral\s+)?to\s+\$?(\d+(?:\.\d+)?)$/);
    if (increaseMatch && ctx.lastMarket && ctx.lastSide && ctx.lastCollateral) {
      const newAmount = parseFloat(increaseMatch[1]);
      const diff = newAmount - ctx.lastCollateral;
      if (diff > 0) {
        return { action: ActionType.AddCollateral, market: ctx.lastMarket, side: ctx.lastSide, amount: diff };
      }
    }

    const addMatch = lower.match(/^add\s+\$?(\d+(?:\.\d+)?)\s+(?:to\s+it|more|to\s+that)$/);
    if (addMatch && ctx.lastMarket && ctx.lastSide) {
      return { action: ActionType.AddCollateral, market: ctx.lastMarket, side: ctx.lastSide, amount: parseFloat(addMatch[1]) };
    }

    if (/^(?:analyze\s+it|what\s+about\s+it)$/.test(lower) && ctx.lastMarket) {
      return { action: ActionType.Analyze, market: ctx.lastMarket };
    }

    return null;
  }

  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const result = localParse(userInput);
    if (result) {
      this.updateContext(result);
      return result;
    }

    const contextResult = this.tryContextualParse(userInput);
    if (contextResult) {
      this.updateContext(contextResult);
      return contextResult;
    }

    getLogger().warn('AI', 'Could not parse locally. Set an AI API key for AI-powered parsing.');
    return { action: ActionType.Help };
  }
}

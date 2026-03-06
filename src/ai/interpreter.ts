import Anthropic from '@anthropic-ai/sdk';
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
- wallet_status: Show wallet connection status
- wallet_address: Show connected wallet address
- wallet_balance: Show wallet SOL balance
- help: Show help
- analyze: Analyze a market with strategy signals
- suggest_trade: Get AI trade suggestion
- risk_report: Show position risk assessment
- dashboard: Combined portfolio/market/stats view
- whale_activity: Show recent large positions
- autopilot_start: Start autopilot trading mode
- autopilot_stop: Stop autopilot trading mode
- autopilot_status: Show autopilot status
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
- "wallet" -> {"action":"wallet_status"}
- "wallet address" -> {"action":"wallet_address"}
- "wallet balance" -> {"action":"wallet_balance"}
- "help" -> {"action":"help"}
- "analyze SOL" -> {"action":"analyze","market":"SOL"}
- "suggest trade" -> {"action":"suggest_trade"}
- "suggest trade BTC" -> {"action":"suggest_trade","market":"BTC"}
- "risk report" -> {"action":"risk_report"}
- "dashboard" -> {"action":"dashboard"}
- "whale activity" -> {"action":"whale_activity"}
- "whale activity SOL" -> {"action":"whale_activity","market":"SOL"}
- "autopilot start" -> {"action":"autopilot_start"}
- "autopilot stop" -> {"action":"autopilot_stop"}
- "autopilot status" -> {"action":"autopilot_status"}
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

/**
 * Fast local regex-based parser for common commands.
 * Exported so it can be used by both AIInterpreter and OfflineInterpreter.
 */
export function localParse(input: string): ParsedIntent | null {
  const lower = input.toLowerCase().trim();

  // Help
  if (/^(help|commands|\?)$/.test(lower)) {
    return { action: ActionType.Help };
  }

  // Wallet commands
  const walletImportMatch = lower.match(/^wallet\s+import\s+(\S+)\s+(.+)$/);
  if (walletImportMatch) {
    return { action: ActionType.WalletImport, name: walletImportMatch[1], path: walletImportMatch[2].trim() };
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
  const walletConnectMatch = lower.match(/^wallet\s+connect\s+(.+)$/);
  if (walletConnectMatch) {
    return { action: ActionType.WalletConnect, path: walletConnectMatch[1].trim() };
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
    /(?:open|buy|enter)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*x?\s*(long|short)\s+(?:position\s+)?(?:on\s+)?([a-z]+)\s+(?:with\s+)?\$?(\d+(?:\.\d+)?)/
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
    /(long|short)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*x/
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

  // Close position: "close SOL long"
  const closeMatch = lower.match(
    /(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)\s+(long|short)/
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

  // Add collateral: "add $200 to SOL long"
  const addCollMatch = lower.match(
    /add\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:to\s+)?(?:my\s+)?([a-z]+)\s+(long|short)/
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

  // Remove collateral: "remove $100 from ETH long"
  const rmCollMatch = lower.match(
    /remove\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:from\s+)?(?:my\s+)?([a-z]+)\s+(long|short)/
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

  // ─── Clawd AI Agent Commands ─────────────────────────────────────────────

  // Analyze: "analyze SOL", "analyze BTC"
  const analyzeMatch = lower.match(/^analyze\s+([a-z]+)$/);
  if (analyzeMatch) {
    return { action: ActionType.Analyze, market: analyzeMatch[1].toUpperCase() };
  }

  // Suggest trade: "suggest trade", "suggest trade SOL"
  const suggestMatch = lower.match(/^suggest\s+trade(?:\s+([a-z]+))?$/);
  if (suggestMatch) {
    return {
      action: ActionType.SuggestTrade,
      ...(suggestMatch[1] ? { market: suggestMatch[1].toUpperCase() } : {}),
    };
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

  // ─── Autopilot Commands ─────────────────────────────────────────────────

  if (/^(?:autopilot\s+start|start\s+autopilot)$/.test(lower)) {
    return { action: ActionType.AutopilotStart };
  }

  if (/^(?:autopilot\s+stop|stop\s+autopilot)$/.test(lower)) {
    return { action: ActionType.AutopilotStop };
  }

  if (/^(?:autopilot\s+(?:status|info)|autopilot)$/.test(lower)) {
    return { action: ActionType.AutopilotStatus };
  }

  // Market Scanner
  if (/^(?:scan|scan\s+markets?|scan\s+opportunities?)$/.test(lower)) {
    return { action: ActionType.ScanMarkets };
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

export class AIInterpreter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private static readonly MAX_INPUT_LENGTH = 500;
  private static readonly API_TIMEOUT_MS = 15_000;

  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const logger = getLogger();

    // Try local pattern matching first for speed
    const localResult = localParse(userInput);
    if (localResult) {
      logger.debug('AI', 'Parsed locally', { input: userInput, action: localResult.action });
      return localResult;
    }

    // Input length limit before sending to Claude
    if (userInput.length > AIInterpreter.MAX_INPUT_LENGTH) {
      logger.warn('AI', `Input too long (${userInput.length} chars, max ${AIInterpreter.MAX_INPUT_LENGTH})`);
      return { action: ActionType.Help };
    }

    // Fall back to Claude for complex inputs
    logger.debug('AI', 'Calling Claude API', { input: userInput });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AIInterpreter.API_TIMEOUT_MS);

      let response;
      try {
        response = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userInput }],
        }, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (response.content.length === 0 || response.content[0].type !== 'text') {
        logger.warn('AI', 'Empty response from Claude');
        return { action: ActionType.Help };
      }

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('AI', 'No JSON in Claude response', { text });
        return { action: ActionType.Help };
      }

      const parsed: unknown = JSON.parse(jsonMatch[0]);
      // Normalize market to uppercase
      if (typeof parsed === 'object' && parsed !== null && 'market' in parsed) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.market === 'string') {
          obj.market = obj.market.toUpperCase();
        }
      }

      const validated = ParsedIntentSchema.parse(parsed);
      logger.debug('AI', 'Claude parsed intent', { action: validated.action });
      return validated;
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      // Graceful fallback on API errors (billing, network, auth)
      if (msg.includes('credit balance') || msg.includes('401') || msg.includes('403') || msg.includes('429') || msg.includes('abort') || msg.includes('timeout')) {
        logger.warn('AI', `Claude API unavailable (${msg}). Using local parsing only.`);
      } else {
        logger.error('AI', `Parse failed: ${msg}`);
      }
      return { action: ActionType.Help };
    }
  }
}

/**
 * Offline interpreter that only uses local regex parsing.
 * Used when no API key is configured.
 */
export class OfflineInterpreter {
  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const result = localParse(userInput);
    if (result) return result;

    getLogger().warn('AI', 'Could not parse locally. Set ANTHROPIC_API_KEY for AI parsing.');
    return { action: ActionType.Help };
  }
}

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
- help: Show help

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
- "help" -> {"action":"help"}

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

  // Portfolio / balance
  if (/^(portfolio|balance|wallet|account)$/.test(lower)) {
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

  // Market data: "SOL price", "price of BTC", "markets"
  if (/^(markets?|all markets)$/.test(lower)) {
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

  return null;
}

export class AIInterpreter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const logger = getLogger();

    // Try local pattern matching first for speed
    const localResult = localParse(userInput);
    if (localResult) {
      logger.debug('AI', 'Parsed locally', { input: userInput, action: localResult.action });
      return localResult;
    }

    // Fall back to Claude for complex inputs
    logger.debug('AI', 'Calling Claude API', { input: userInput });

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userInput }],
      });

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
      logger.error('AI', `Parse failed: ${getErrorMessage(error)}`);
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

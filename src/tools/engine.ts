import {
  ActionType,
  ParsedIntent,
  ToolContext,
  ToolResult,
} from '../types/index.js';
import { ToolRegistry } from './registry.js';
import { allFlashTools } from './flash-tools.js';
import chalk from 'chalk';

/**
 * ToolEngine maps parsed intents to tool invocations.
 * This follows the Clawd agent pattern: intent → tool name → execute.
 */
export class ToolEngine {
  private registry: ToolRegistry;
  private context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
    this.registry = new ToolRegistry();

    for (const tool of allFlashTools) {
      this.registry.register(tool);
    }
  }

  /**
   * Route a parsed intent to the appropriate tool and execute it.
   */
  async dispatch(intent: ParsedIntent): Promise<ToolResult> {
    const mapping = this.getToolMapping(intent);
    if (!mapping) {
      return this.handleHelp();
    }

    const { toolName, params } = mapping;
    return this.registry.execute(toolName, params, this.context);
  }

  private getToolMapping(
    intent: ParsedIntent
  ): { toolName: string; params: Record<string, unknown> } | null {
    switch (intent.action) {
      case ActionType.OpenPosition:
        return {
          toolName: 'flash_open_position',
          params: {
            market: intent.market,
            side: intent.side,
            collateral: intent.collateral,
            leverage: intent.leverage,
            collateral_token: intent.collateral_token,
          },
        };

      case ActionType.ClosePosition:
        return {
          toolName: 'flash_close_position',
          params: { market: intent.market, side: intent.side },
        };

      case ActionType.AddCollateral:
        return {
          toolName: 'flash_add_collateral',
          params: {
            market: intent.market,
            side: intent.side,
            amount: intent.amount,
          },
        };

      case ActionType.RemoveCollateral:
        return {
          toolName: 'flash_remove_collateral',
          params: {
            market: intent.market,
            side: intent.side,
            amount: intent.amount,
          },
        };

      case ActionType.GetPositions:
        return { toolName: 'flash_get_positions', params: {} };

      case ActionType.GetMarketData:
        return {
          toolName: 'flash_get_market_data',
          params: { market: intent.market },
        };

      case ActionType.GetPortfolio:
        return { toolName: 'flash_get_portfolio', params: {} };

      case ActionType.GetVolume:
        return {
          toolName: 'flash_get_volume',
          params: { period: intent.period },
        };

      case ActionType.GetOpenInterest:
        return { toolName: 'flash_get_open_interest', params: {} };

      case ActionType.GetLeaderboard:
        return {
          toolName: 'flash_get_leaderboard',
          params: {
            metric: intent.metric,
            period: intent.period,
            limit: intent.limit,
          },
        };

      case ActionType.GetTraderProfile:
        return {
          toolName: 'flash_get_trader_profile',
          params: { address: intent.address },
        };

      case ActionType.GetFees:
        return {
          toolName: 'flash_get_fees',
          params: { period: intent.period },
        };

      case ActionType.Help:
        return null;

      default:
        return null;
    }
  }

  private handleHelp(): ToolResult {
    const helpText = [
      '',
      chalk.bold.yellow('  Flash AI Terminal — Commands'),
      chalk.dim('  ═══════════════════════════════════════'),
      '',
      chalk.bold('  Trading:'),
      `    ${chalk.cyan('open 5x long SOL $500')}   Open a leveraged position`,
      `    ${chalk.cyan('close SOL long')}          Close a position`,
      `    ${chalk.cyan('add $200 to SOL long')}    Add collateral`,
      `    ${chalk.cyan('remove $100 from ETH long')} Remove collateral`,
      '',
      chalk.bold('  Queries:'),
      `    ${chalk.cyan('positions')}     View open positions`,
      `    ${chalk.cyan('portfolio')}     Portfolio summary`,
      `    ${chalk.cyan('SOL price')}     Get market price`,
      `    ${chalk.cyan('markets')}       All market data`,
      '',
      chalk.bold('  Analytics:'),
      `    ${chalk.cyan('volume')}        Trading volume`,
      `    ${chalk.cyan('open interest')} Open interest data`,
      `    ${chalk.cyan('leaderboard')}   Top traders`,
      `    ${chalk.cyan('fees')}          Fee data`,
      '',
      chalk.bold('  System:'),
      `    ${chalk.cyan('help')}          Show this help`,
      `    ${chalk.cyan('exit')}          Quit terminal`,
      '',
    ].join('\n');

    return { success: true, message: helpText };
  }
}

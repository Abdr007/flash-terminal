import {
  ActionType,
  ParsedIntent,
  ToolContext,
  ToolResult,
} from '../types/index.js';
import { ToolRegistry } from './registry.js';
import { allFlashTools } from './flash-tools.js';
import { allClawdTools } from '../clawd/clawd-tools.js';
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
    for (const tool of allClawdTools) {
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

      case ActionType.WalletConnect:
        return {
          toolName: 'wallet_connect',
          params: { path: intent.path },
        };

      case ActionType.WalletAddress:
        return { toolName: 'wallet_address', params: {} };

      case ActionType.WalletBalance:
        return { toolName: 'wallet_balance', params: {} };

      case ActionType.Help:
        return null;

      // Clawd AI Agent
      case ActionType.Analyze:
        return {
          toolName: 'clawd_analyze',
          params: { market: intent.market },
        };

      case ActionType.SuggestTrade:
        return {
          toolName: 'clawd_suggest_trade',
          params: { market: intent.market },
        };

      case ActionType.RiskReport:
        return { toolName: 'clawd_risk_report', params: {} };

      case ActionType.Dashboard:
        return { toolName: 'clawd_dashboard', params: {} };

      case ActionType.WhaleActivity:
        return {
          toolName: 'clawd_whale_activity',
          params: { market: intent.market },
        };

      // Autopilot
      case ActionType.AutopilotStart:
        return { toolName: 'autopilot_start', params: {} };

      case ActionType.AutopilotStop:
        return { toolName: 'autopilot_stop', params: {} };

      case ActionType.AutopilotStatus:
        return { toolName: 'autopilot_status', params: {} };

      // Market Scanner
      case ActionType.ScanMarkets:
        return { toolName: 'clawd_scan_markets', params: {} };

      // Portfolio Intelligence
      case ActionType.PortfolioState:
        return { toolName: 'portfolio_state', params: {} };

      case ActionType.PortfolioExposure:
        return { toolName: 'portfolio_exposure', params: {} };

      case ActionType.PortfolioRebalance:
        return { toolName: 'portfolio_rebalance', params: {} };

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
      chalk.bold('  AI Agent:'),
      `    ${chalk.cyan('analyze SOL')}         Market analysis with strategy signals`,
      `    ${chalk.cyan('suggest trade')}       AI-powered trade suggestion`,
      `    ${chalk.cyan('scan')}                Scan all markets for opportunities`,
      `    ${chalk.cyan('risk report')}         Position risk & exposure summary`,
      `    ${chalk.cyan('dashboard')}           Combined portfolio/market/stats`,
      `    ${chalk.cyan('whale activity')}      Recent large positions`,
      '',
      chalk.bold('  Portfolio Intelligence:'),
      `    ${chalk.cyan('portfolio state')}     Capital allocation & positions`,
      `    ${chalk.cyan('portfolio exposure')}  Exposure breakdown by market`,
      `    ${chalk.cyan('rebalance')}           Analyze portfolio balance`,
      '',
      chalk.bold('  Autopilot:'),
      `    ${chalk.cyan('autopilot start')}     Start automated trading mode`,
      `    ${chalk.cyan('autopilot stop')}      Stop autopilot`,
      `    ${chalk.cyan('autopilot status')}    Show autopilot status & signals`,
      '',
      chalk.bold('  Wallet:'),
      `    ${chalk.cyan('wallet address')}            Show wallet address`,
      `    ${chalk.cyan('wallet balance')}            Show SOL balance`,
      `    ${chalk.cyan('wallet connect <path>')}     Connect wallet from file`,
      '',
      chalk.bold('  System:'),
      `    ${chalk.cyan('help')}          Show this help`,
      `    ${chalk.cyan('exit')}          Quit terminal`,
      '',
    ].join('\n');

    return { success: true, message: helpText };
  }
}

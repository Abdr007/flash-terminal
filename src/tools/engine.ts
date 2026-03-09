import {
  ActionType,
  ParsedIntent,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types/index.js';
import { ToolRegistry } from './registry.js';
import { allFlashTools } from './flash-tools.js';
import { allAgentTools } from '../agent/agent-tools.js';
import { runMiddleware } from '../core/execution-middleware.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

/**
 * ToolEngine maps parsed intents to tool invocations.
 * Maps parsed intents to tool invocations: intent → tool name → execute.
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
    for (const tool of allAgentTools) {
      this.registry.register(tool);
    }
    // Lock core tools — plugins cannot override them
    this.registry.lockCore();
  }

  /**
   * Register an additional tool at runtime (e.g. from plugins).
   */
  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  /**
   * Route a parsed intent to the appropriate tool and execute it.
   */
  async dispatch(intent: ParsedIntent): Promise<ToolResult> {
    // Run execution middleware pipeline
    const middlewareBlock = runMiddleware(intent, this.context);
    if (middlewareBlock) return middlewareBlock;

    // Autopilot commands blocked in live mode
    if (this.isAutopilotAction(intent.action) && !this.context.simulationMode) {
      return {
        success: false,
        message: [
          '',
          theme.negative('  Autopilot disabled in LIVE mode.'),
          theme.dim('  Restart terminal and select Simulation to use autopilot.'),
          '',
        ].join('\n'),
      };
    }

    const mapping = this.getToolMapping(intent);
    if (!mapping) {
      return this.handleHelp();
    }

    const { toolName, params } = mapping;
    return this.registry.execute(toolName, params, this.context);
  }

  private isAutopilotAction(action: ActionType): boolean {
    return action === ActionType.AutopilotStart
      || action === ActionType.AutopilotStop
      || action === ActionType.AutopilotStatus;
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

      case ActionType.WalletImport:
        return {
          toolName: 'wallet_import',
          params: { name: intent.name, path: intent.path },
        };

      case ActionType.WalletList:
        return { toolName: 'wallet_list', params: {} };

      case ActionType.WalletUse:
        return {
          toolName: 'wallet_use',
          params: { name: intent.name },
        };

      case ActionType.WalletRemove:
        return {
          toolName: 'wallet_remove',
          params: { name: intent.name },
        };

      case ActionType.WalletDisconnect:
        return { toolName: 'wallet_disconnect', params: {} };

      case ActionType.WalletStatus:
        return { toolName: 'wallet_status', params: {} };

      case ActionType.WalletAddress:
        return { toolName: 'wallet_address', params: {} };

      case ActionType.WalletBalance:
        return { toolName: 'wallet_balance', params: {} };

      case ActionType.WalletTokens:
        return { toolName: 'wallet_tokens', params: {} };

      case ActionType.FlashMarkets:
        return { toolName: 'flash_markets_list', params: {} };

      case ActionType.Help:
        return null;

      // AI Agent
      case ActionType.Analyze:
        return {
          toolName: 'ai_analyze',
          params: { market: intent.market },
        };

      case ActionType.SuggestTrade:
        return {
          toolName: 'ai_suggest_trade',
          params: { market: intent.market },
        };

      case ActionType.RiskReport:
        return { toolName: 'ai_risk_report', params: {} };

      case ActionType.Dashboard:
        return { toolName: 'ai_dashboard', params: {} };

      case ActionType.WhaleActivity:
        return {
          toolName: 'ai_whale_activity',
          params: { market: intent.market },
        };

      // Autopilot — blocked in live mode
      case ActionType.AutopilotStart:
      case ActionType.AutopilotStop:
      case ActionType.AutopilotStatus:
        if (!this.context.simulationMode) {
          return null; // Will be handled as blocked command
        }
        if (intent.action === ActionType.AutopilotStart)
          return { toolName: 'autopilot_start', params: {} };
        if (intent.action === ActionType.AutopilotStop)
          return { toolName: 'autopilot_stop', params: {} };
        return { toolName: 'autopilot_status', params: {} };

      // Market Scanner
      case ActionType.ScanMarkets:
        return { toolName: 'ai_scan_markets', params: {} };

      // Portfolio Intelligence
      case ActionType.PortfolioState:
        return { toolName: 'portfolio_state', params: {} };

      case ActionType.PortfolioExposure:
        return { toolName: 'portfolio_exposure', params: {} };

      case ActionType.PortfolioRebalance:
        return { toolName: 'portfolio_rebalance', params: {} };

      // Risk Monitor
      case ActionType.RiskMonitorOn:
        return { toolName: 'risk_monitor_on', params: {} };

      case ActionType.RiskMonitorOff:
        return { toolName: 'risk_monitor_off', params: {} };

      // Protocol Inspector
      case ActionType.InspectProtocol:
        return { toolName: 'inspect_protocol', params: {} };

      case ActionType.InspectPool:
        return { toolName: 'inspect_pool', params: { pool: intent.pool } };

      case ActionType.InspectMarket:
        return { toolName: 'inspect_market', params: { market: intent.market } };

      // System Diagnostics
      case ActionType.SystemStatus:
        return { toolName: 'system_status', params: {} };

      case ActionType.RpcStatus:
        return { toolName: 'rpc_status', params: {} };

      case ActionType.RpcTest:
        return { toolName: 'rpc_test', params: {} };

      case ActionType.TxInspect:
        return { toolName: 'tx_inspect', params: { signature: intent.signature } };

      case ActionType.TradeHistory:
        return { toolName: 'trade_history', params: {} };

      default:
        return null;
    }
  }

  private handleHelp(): ToolResult {
    const cmd = theme.command;
    const dim = theme.dim;
    const sec = theme.section;

    const lines = [
      '',
      `  ${theme.accentBold('FLASH AI TERMINAL')}  ${dim('— Commands')}`,
      `  ${theme.separator(48)}`,
      '',
      `  ${sec('Trading')}`,
      `    ${cmd('open 5x long SOL $500')}     Open a leveraged position`,
      `    ${cmd('close SOL long')}            Close a position`,
      `    ${cmd('add $200 to SOL long')}      Add collateral to position`,
      `    ${cmd('remove $100 from ETH long')} Remove collateral`,
      `    ${cmd('positions')}                 View open positions`,
      `    ${cmd('trade history')}              View recent trades`,
      '',
      `  ${sec('Market Intelligence')}`,
      `    ${cmd('scan')}                      Find trading opportunities`,
      `    ${cmd('monitor')}                   Live market monitor`,
      `    ${cmd('analyze <asset>')}            Deep analysis of a market`,
      `    ${cmd('markets')}                   List available markets`,
      `    ${cmd('suggest trade')}              AI trade suggestion`,
      `    ${cmd('whale activity')}             Recent large positions`,
      '',
      `  ${sec('Portfolio & Risk')}`,
      `    ${cmd('portfolio')}                 Portfolio overview`,
      `    ${cmd('dashboard')}                 Full system dashboard`,
      `    ${cmd('risk report')}                Position risk assessment`,
      `    ${cmd('risk monitor on')}            Start real-time risk alerts`,
      `    ${cmd('risk monitor off')}           Stop risk monitoring`,
      '',
      `  ${sec('Market Data')}`,
      `    ${cmd('volume')}                    Trading volume data`,
      `    ${cmd('open interest')}              OI breakdown by market`,
      `    ${cmd('leaderboard')}               Top traders by PnL or volume`,
      '',
    ];

    if (this.context.simulationMode) {
      lines.push(
        `  ${sec('Autopilot')} ${dim('(simulation only)')}`,
        `    ${cmd('autopilot start')}          Start automated trading`,
        `    ${cmd('autopilot stop')}           Stop autopilot`,
        `    ${cmd('autopilot status')}         Autopilot status & signals`,
        '',
      );
    }

    lines.push(
      `  ${sec('Wallet')}`,
      `    ${cmd('wallet')}                    Wallet status`,
      `    ${cmd('wallet tokens')}             View all token balances`,
      `    ${cmd('wallet balance')}            Show SOL balance`,
      `    ${cmd('wallet list')}               List saved wallets`,
      `    ${cmd('wallet import')}             Import & store a wallet`,
      `    ${cmd('wallet use <name>')}         Switch to a saved wallet`,
      `    ${cmd('wallet connect <path>')}     Connect wallet file`,
      `    ${cmd('wallet disconnect')}         Disconnect active wallet`,
      '',
      `  ${sec('Protocol Inspector')}`,
      `    ${cmd('inspect protocol')}          Flash Trade protocol overview`,
      `    ${cmd('inspect pool <name>')}       Inspect a specific pool`,
      `    ${cmd('inspect market <asset>')}    Deep market inspection`,
      '',
      `  ${sec('System')}`,
      `    ${cmd('system status')}             System health overview`,
      `    ${cmd('rpc status')}                Active RPC info`,
      `    ${cmd('rpc test')}                  Test all RPC endpoints`,
      `    ${cmd('tx inspect <sig>')}          Inspect a transaction`,
      `    ${cmd('dryrun <command>')}          Preview without executing`,
      `    ${cmd('doctor')}                  Run terminal diagnostic`,
      `    ${cmd('watch <command>')}          Auto-refresh a command`,
      `    ${cmd('degen')}                   Toggle degen mode (500x on SOL/BTC/ETH)`,
      '',
      `  ${theme.separator(48)}`,
      `  ${cmd('exit')}                        Close the terminal`,
      '',
      `  ${dim('You can also type natural language commands.')}`,
      `  ${dim('Example: "what\'s the price of SOL?" or "show me BTC analysis"')}`,
      '',
    );

    return { success: true, message: lines.join('\n') };
  }
}

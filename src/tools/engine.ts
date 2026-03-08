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
          chalk.red('  Autopilot disabled in LIVE mode.'),
          chalk.dim('  Restart terminal and select Simulation to use autopilot.'),
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
    const lines = [
      '',
      chalk.bold('  FLASH AI TERMINAL — Commands'),
      chalk.dim('  ─────────────────────────────────────────────'),
      '',
      // ── Trading ──
      chalk.bold('  Trading'),
      `    ${chalk.cyan('open 5x long SOL $500')}     Open a leveraged position`,
      `    ${chalk.cyan('close SOL long')}            Close a position`,
      `    ${chalk.cyan('add $200 to SOL long')}      Add collateral to position`,
      `    ${chalk.cyan('remove $100 from ETH long')} Remove collateral`,
      `    ${chalk.cyan('positions')}                 View open positions`,
      `    ${chalk.cyan('trade history')}              View recent trades`,
      '',
      // ── Market Intelligence ──
      chalk.bold('  Market Intelligence'),
      `    ${chalk.cyan('scan')}                      Find trading opportunities`,
      `    ${chalk.cyan('monitor')}                   Live market monitor (prices, OI)`,
      `    ${chalk.cyan('analyze <asset>')}            Deep analysis of a market`,
      `    ${chalk.cyan('markets')}                   List available markets`,
      `    ${chalk.cyan('suggest trade')}              AI trade suggestion`,
      `    ${chalk.cyan('whale activity')}             Recent large positions`,
      '',
      // ── Portfolio & Risk ──
      chalk.bold('  Portfolio & Risk'),
      `    ${chalk.cyan('portfolio')}                 Portfolio overview`,
      `    ${chalk.cyan('dashboard')}                 Full system dashboard`,
      `    ${chalk.cyan('risk report')}                Position risk assessment`,
      `    ${chalk.cyan('risk monitor on')}            Start real-time risk alerts`,
      `    ${chalk.cyan('risk monitor off')}           Stop risk monitoring`,
      '',
      // ── Market Data ──
      chalk.bold('  Market Data'),
      `    ${chalk.cyan('volume')}                    Trading volume data`,
      `    ${chalk.cyan('open interest')}              OI breakdown by market`,
      `    ${chalk.cyan('leaderboard')}               Top traders by PnL or volume`,
      '',
    ];

    if (this.context.simulationMode) {
      lines.push(
        chalk.bold('  Autopilot') + chalk.dim(' (simulation only)'),
        `    ${chalk.cyan('autopilot start')}          Start automated trading`,
        `    ${chalk.cyan('autopilot stop')}           Stop autopilot`,
        `    ${chalk.cyan('autopilot status')}         Autopilot status & signals`,
        '',
      );
    }

    lines.push(
      // ── Wallet ──
      chalk.bold('  Wallet'),
      `    ${chalk.cyan('wallet')}                    Wallet status`,
      `    ${chalk.cyan('wallet tokens')}             View all token balances`,
      `    ${chalk.cyan('wallet balance')}            Show SOL balance`,
      `    ${chalk.cyan('wallet list')}               List saved wallets`,
      `    ${chalk.cyan('wallet import')}             Import & store a wallet`,
      `    ${chalk.cyan('wallet use <name>')}         Switch to a saved wallet`,
      `    ${chalk.cyan('wallet connect <path>')}     Connect wallet file`,
      `    ${chalk.cyan('wallet disconnect')}         Disconnect active wallet`,
      '',
      // ── Protocol Inspector ──
      chalk.bold('  Protocol Inspector'),
      `    ${chalk.cyan('inspect protocol')}          Flash Trade protocol overview`,
      `    ${chalk.cyan('inspect pool <name>')}       Inspect a specific pool`,
      `    ${chalk.cyan('inspect market <asset>')}    Deep market inspection`,
      '',
      // ── System ──
      chalk.bold('  System'),
      `    ${chalk.cyan('system status')}             System health overview`,
      `    ${chalk.cyan('rpc status')}                Active RPC info`,
      `    ${chalk.cyan('rpc test')}                  Test all RPC endpoints`,
      `    ${chalk.cyan('tx inspect <sig>')}          Inspect a transaction`,
      `    ${chalk.cyan('dryrun <command>')}          Preview without executing`,
      `    ${chalk.cyan('doctor')}                  Run terminal diagnostic`,
      `    ${chalk.cyan('watch <command>')}          Auto-refresh a command (e.g. watch positions)`,
      '',
      chalk.dim('  ─────────────────────────────────────────────'),
      `  ${chalk.cyan('exit')}                        Close the terminal`,
      '',
      chalk.dim('  You can also type natural language commands.'),
      chalk.dim('  Example: "what\'s the price of SOL?" or "show me BTC analysis"'),
      '',
    );

    return { success: true, message: lines.join('\n') };
  }
}

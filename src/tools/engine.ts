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

      default:
        return null;
    }
  }

  private handleHelp(): ToolResult {
    const lines = [
      '',
      chalk.bold('  Available Commands'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      `  ${chalk.cyan('markets')}`,
      chalk.dim('    View available trading markets.'),
      '',
      `  ${chalk.cyan('scan')}`,
      chalk.dim('    Scan all markets and identify potential opportunities.'),
      '',
      `  ${chalk.cyan('analyze <asset>')}`,
      chalk.dim('    Perform deep analysis of a specific market.'),
      '',
      `  ${chalk.cyan('portfolio')}`,
      chalk.dim('    View portfolio exposure and risk distribution.'),
      '',
      `  ${chalk.cyan('positions')}`,
      chalk.dim('    View open positions.'),
      '',
      `  ${chalk.cyan('wallet')}`,
      chalk.dim('    Show wallet information and token balances.'),
      '',
      `  ${chalk.cyan('dashboard')}`,
      chalk.dim('    Display the overall system overview.'),
      '',
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      `  ${chalk.cyan('suggest trade')}`,
      chalk.dim('    AI-powered trade suggestion based on current signals.'),
      '',
      `  ${chalk.cyan('risk report')}`,
      chalk.dim('    Position risk assessment and exposure summary.'),
      '',
      `  ${chalk.cyan('whale activity')}`,
      chalk.dim('    Recent large positions from on-chain data.'),
      '',
      `  ${chalk.cyan('volume')}`,
      chalk.dim('    Trading volume data.'),
      '',
      `  ${chalk.cyan('open interest')}`,
      chalk.dim('    Open interest breakdown by market.'),
      '',
      `  ${chalk.cyan('leaderboard')}`,
      chalk.dim('    Top traders by PnL or volume.'),
      '',
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      chalk.bold('  Trading'),
      `    ${chalk.cyan('open 5x long SOL $500')}    Open a leveraged position`,
      `    ${chalk.cyan('close SOL long')}           Close a position`,
      `    ${chalk.cyan('add $200 to SOL long')}     Add collateral`,
      `    ${chalk.cyan('remove $100 from ETH long')} Remove collateral`,
      '',
    ];

    if (this.context.simulationMode) {
      lines.push(
        chalk.bold('  Autopilot'),
        `    ${chalk.cyan('autopilot start')}        Start automated trading`,
        `    ${chalk.cyan('autopilot stop')}         Stop autopilot`,
        `    ${chalk.cyan('autopilot status')}       Autopilot status & signals`,
        '',
      );
    }

    lines.push(
      chalk.bold('  Wallet'),
      `    ${chalk.cyan('wallet import')}          Import & store a wallet`,
      `    ${chalk.cyan('wallet list')}            List saved wallets`,
      `    ${chalk.cyan('wallet use <name>')}      Switch to a saved wallet`,
      `    ${chalk.cyan('wallet connect <path>')}  Connect wallet file`,
      `    ${chalk.cyan('wallet disconnect')}      Disconnect active wallet`,
      `    ${chalk.cyan('wallet balance')}         Show SOL balance`,
      `    ${chalk.cyan('wallet tokens')}          Detect all tokens`,
      '',
      `  ${chalk.cyan('risk monitor on')}     Start real-time risk monitoring`,
      `  ${chalk.cyan('risk monitor off')}    Stop risk monitoring`,
      '',
      chalk.bold('  Protocol Inspector'),
      `    ${chalk.cyan('inspect protocol')}    Flash Trade protocol overview`,
      `    ${chalk.cyan('inspect pool <name>')} Inspect a specific pool`,
      `    ${chalk.cyan('inspect market <asset>')} Deep market inspection`,
      '',
      chalk.bold('  System Diagnostics'),
      `    ${chalk.cyan('system status')}      System health overview`,
      `    ${chalk.cyan('rpc status')}         Active RPC info`,
      `    ${chalk.cyan('rpc test')}           Test all RPC endpoints`,
      `    ${chalk.cyan('tx inspect <sig>')}   Inspect a transaction`,
      '',
      `  ${chalk.cyan('exit')}`,
      chalk.dim('    Close the terminal.'),
      '',
    );

    return { success: true, message: lines.join('\n') };
  }
}

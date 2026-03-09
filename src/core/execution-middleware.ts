import chalk from 'chalk';
import { ActionType, ToolContext, ToolResult, ParsedIntent } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Trading Actions ─────────────────────────────────────────────────────────

const TRADING_ACTIONS = new Set<ActionType>([
  ActionType.OpenPosition,
  ActionType.ClosePosition,
  ActionType.AddCollateral,
  ActionType.RemoveCollateral,
]);

const READ_ONLY_ALLOWED = new Set<ActionType>([
  ActionType.GetPositions,
  ActionType.GetMarketData,
  ActionType.GetPortfolio,
  ActionType.GetVolume,
  ActionType.GetOpenInterest,
  ActionType.GetLeaderboard,
  ActionType.GetTraderProfile,
  ActionType.GetFees,
  ActionType.FlashMarkets,
  ActionType.Help,
  ActionType.Analyze,
  ActionType.RiskReport,
  ActionType.Dashboard,
  ActionType.WhaleActivity,
  ActionType.ScanMarkets,
  ActionType.PortfolioState,
  ActionType.PortfolioExposure,
  ActionType.PortfolioRebalance,
  ActionType.WalletStatus,
  ActionType.WalletAddress,
  ActionType.WalletBalance,
  ActionType.WalletTokens,
  ActionType.WalletList,
  ActionType.WalletConnect,
  ActionType.WalletImport,
  ActionType.WalletUse,
  ActionType.WalletRemove,
  ActionType.WalletDisconnect,
  ActionType.LiquidationMap,
  ActionType.FundingDashboard,
  ActionType.LiquidityDepth,
  ActionType.ProtocolHealth,
  ActionType.InspectProtocol,
  ActionType.InspectPool,
  ActionType.InspectMarket,
  // Diagnostics
  ActionType.SystemStatus,
  ActionType.RpcStatus,
  ActionType.RpcTest,
  ActionType.TxInspect,
  // Trade journal
  ActionType.TradeHistory,
  ActionType.MarketMonitor,
  // Dry run (preview only, no signing)
  ActionType.DryRun,
]);

/**
 * Middleware result — either pass (continue pipeline) or block (return error).
 */
interface MiddlewareResult {
  pass: boolean;
  blocked?: ToolResult;
}

type Middleware = (intent: ParsedIntent, context: ToolContext) => MiddlewareResult;

// ─── Middleware Definitions ──────────────────────────────────────────────────

/**
 * Wallet middleware: block trading commands when no wallet is connected (live mode).
 */
function walletMiddleware(intent: ParsedIntent, context: ToolContext): MiddlewareResult {
  if (context.simulationMode) return { pass: true };
  if (!TRADING_ACTIONS.has(intent.action)) return { pass: true };

  const wm = context.walletManager;
  if (!wm || !wm.isConnected) {
    return {
      pass: false,
      blocked: {
        success: false,
        message: [
          '',
          chalk.red('  Trade blocked: no wallet connected.'),
          chalk.dim('  Use "wallet import", "wallet use", or "wallet connect" first.'),
          '',
        ].join('\n'),
      },
    };
  }

  return { pass: true };
}

/**
 * Read-only middleware: block non-read commands when in read-only mode.
 */
function readOnlyMiddleware(intent: ParsedIntent, context: ToolContext): MiddlewareResult {
  if (context.simulationMode) return { pass: true };

  const wm = context.walletManager;
  if (!wm || wm.isConnected) return { pass: true }; // either no wallet concern or fully connected

  // Read-only mode: only has address but no keypair
  if (wm.isReadOnly && TRADING_ACTIONS.has(intent.action)) {
    return {
      pass: false,
      blocked: {
        success: false,
        message: [
          '',
          chalk.yellow('  READ-ONLY MODE'),
          chalk.dim('  Viewing is allowed but trading requires a full wallet connection.'),
          chalk.dim('  Use "wallet import" or "wallet connect" to enable trading.'),
          '',
        ].join('\n'),
      },
    };
  }

  return { pass: true };
}

/**
 * Logging middleware: log every command execution.
 */
function loggingMiddleware(intent: ParsedIntent, context: ToolContext): MiddlewareResult {
  const logger = getLogger();
  logger.debug('MIDDLEWARE', `Command: ${intent.action}`, {
    wallet: context.walletAddress,
    mode: context.simulationMode ? 'simulation' : 'live',
  });
  return { pass: true };
}

// ─── Middleware Pipeline ─────────────────────────────────────────────────────

const MIDDLEWARE_CHAIN: Middleware[] = [
  loggingMiddleware,
  walletMiddleware,
  readOnlyMiddleware,
];

/**
 * Run all middleware checks before executing a command.
 * Returns null if all middleware pass, or a ToolResult if blocked.
 */
export function runMiddleware(intent: ParsedIntent, context: ToolContext): ToolResult | null {
  for (const mw of MIDDLEWARE_CHAIN) {
    const result = mw(intent, context);
    if (!result.pass && result.blocked) {
      return result.blocked;
    }
  }
  return null;
}

/**
 * Check if an action is allowed in read-only mode.
 */
export function isReadOnlyAllowed(action: ActionType): boolean {
  return READ_ONLY_ALLOWED.has(action);
}

/**
 * Check if an action is a trading action.
 */
export function isTradingAction(action: ActionType): boolean {
  return TRADING_ACTIONS.has(action);
}

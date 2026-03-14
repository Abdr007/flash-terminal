/**
 * Unified Command Registry
 *
 * Single source of truth for all CLI commands.
 * Consumed by: dispatch (terminal.ts), help (engine.ts), autocomplete (completer.ts).
 *
 * Design constraints:
 *   - No runtime dependencies — pure data + simple derivation functions
 *   - No RPC calls — static definitions only
 *   - Every command appears exactly once in this registry
 */

import { ActionType } from '../types/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CommandCategory =
  | 'Trading'
  | 'Market Data & Analytics'
  | 'Portfolio & Risk'
  | 'Protocol Inspection'
  | 'Wallet'
  | 'Utilities';

export interface CommandEntry {
  /** Primary command text (e.g. 'positions', 'open interest') */
  name: string;
  /** ActionType for dispatch — null means handled by special routing */
  action: ActionType | null;
  /** Help category */
  category: CommandCategory;
  /** Short description for help output */
  description: string;
  /** Help display format (e.g. 'open 5x long SOL $500') — if different from name */
  helpFormat?: string;
  /** Alternative triggers that also dispatch to the same action */
  aliases?: string[];
  /** Dispatch-only aliases — work for execution but excluded from autocomplete to avoid TAB clutter */
  dispatchAliases?: string[];
  /** If true, command is hidden from help but available for dispatch/autocomplete */
  hidden?: boolean;
  /** If true, command takes arguments (shown in autocomplete but not prefix-matched for dispatch) */
  parameterized?: boolean;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const COMMAND_REGISTRY: CommandEntry[] = [
  // ── Trading ─────────────────────────────────────────────────────────────
  {
    name: 'open',
    action: null, // parameterized — parsed by interpreter
    category: 'Trading',
    description: 'Open a leveraged position',
    helpFormat: 'open 5x long SOL $500',
    parameterized: true,
  },
  {
    name: 'close',
    action: null,
    category: 'Trading',
    description: 'Close a position',
    helpFormat: 'close SOL long',
    parameterized: true,
  },
  {
    name: 'add',
    action: null,
    category: 'Trading',
    description: 'Add collateral to position',
    helpFormat: 'add $200 to SOL long',
    parameterized: true,
  },
  {
    name: 'remove',
    action: null,
    category: 'Trading',
    description: 'Remove collateral',
    helpFormat: 'remove $100 from ETH long',
    parameterized: true,
  },
  {
    name: 'positions',
    action: ActionType.GetPositions,
    category: 'Trading',
    description: 'View open positions',
    aliases: ['position'],
  },
  {
    name: 'position debug',
    action: null,
    category: 'Trading',
    description: 'Protocol-level position debug',
    helpFormat: 'position debug <asset>',
    parameterized: true,
  },
  {
    name: 'markets',
    action: ActionType.FlashMarkets,
    category: 'Trading',
    description: 'List available markets',
    aliases: ['market'],
  },
  {
    name: 'trade history',
    action: ActionType.TradeHistory,
    category: 'Trading',
    description: 'View recent trades',
    aliases: ['trades', 'journal', 'history'],
  },

  // ── Market Data & Analytics ─────────────────────────────────────────────
  {
    name: 'analyze',
    action: null,
    category: 'Market Data & Analytics',
    description: 'Deep market analysis',
    helpFormat: 'analyze <asset>',
    parameterized: true,
  },
  {
    name: 'volume',
    action: ActionType.GetVolume,
    category: 'Market Data & Analytics',
    description: 'Protocol trading volume',
  },
  {
    name: 'open interest',
    action: ActionType.GetOpenInterest,
    category: 'Market Data & Analytics',
    description: 'OI breakdown by market',
    aliases: ['oi'],
  },
  {
    name: 'leaderboard',
    action: ActionType.GetLeaderboard,
    category: 'Market Data & Analytics',
    description: 'Top traders by PnL or volume',
    aliases: ['rankings'],
  },
  {
    name: 'whale activity',
    action: ActionType.WhaleActivity,
    category: 'Market Data & Analytics',
    description: 'Recent large positions',
    aliases: ['whales'],
  },
  {
    name: 'fees',
    action: ActionType.GetFees,
    category: 'Market Data & Analytics',
    description: 'Protocol fee data',
    aliases: ['fee'],
  },
  {
    name: 'liquidations',
    action: ActionType.LiquidationMap,
    category: 'Market Data & Analytics',
    description: 'Liquidation risk data',
    helpFormat: 'liquidations <asset>',
    parameterized: true,
  },
  {
    name: 'funding',
    action: ActionType.FundingDashboard,
    category: 'Market Data & Analytics',
    description: 'OI imbalance & fee dashboard',
    helpFormat: 'funding <asset>',
    parameterized: true,
  },
  {
    name: 'depth',
    action: ActionType.LiquidityDepth,
    category: 'Market Data & Analytics',
    description: 'Liquidity depth around price',
    helpFormat: 'depth <asset>',
    parameterized: true,
  },
  {
    name: 'protocol health',
    action: ActionType.ProtocolHealth,
    category: 'Market Data & Analytics',
    description: 'Protocol health overview',
  },
  {
    name: 'scan',
    action: null,
    category: 'Market Data & Analytics',
    description: 'Scan market conditions',
    hidden: true, // CLI must not suggest trades
  },

  // ── Portfolio & Risk ────────────────────────────────────────────────────
  {
    name: 'portfolio',
    action: ActionType.GetPortfolio,
    category: 'Portfolio & Risk',
    description: 'Portfolio overview',
    aliases: ['balance', 'account'],
  },
  {
    name: 'dashboard',
    action: ActionType.Dashboard,
    category: 'Portfolio & Risk',
    description: 'Full system dashboard',
    aliases: ['dash'],
  },
  {
    name: 'risk report',
    action: ActionType.RiskReport,
    category: 'Portfolio & Risk',
    description: 'Position risk assessment',
    aliases: ['risk'],
  },
  {
    name: 'exposure',
    action: ActionType.PortfolioExposure,
    category: 'Portfolio & Risk',
    description: 'Portfolio exposure breakdown',
    aliases: ['portfolio exposure'],
  },
  {
    name: 'rebalance',
    action: ActionType.PortfolioRebalance,
    category: 'Portfolio & Risk',
    description: 'Portfolio rebalance analysis',
    aliases: ['portfolio rebalance'],
  },
  {
    name: 'capital',
    action: ActionType.PortfolioState,
    category: 'Portfolio & Risk',
    description: 'Portfolio capital state',
    aliases: ['portfolio state'],
    hidden: true,
  },

  // ── Protocol Inspection ─────────────────────────────────────────────────
  {
    name: 'inspect protocol',
    action: ActionType.InspectProtocol,
    category: 'Protocol Inspection',
    description: 'Flash Trade protocol overview',
    dispatchAliases: ['inspect'],
  },
  {
    name: 'inspect pool',
    action: null,
    category: 'Protocol Inspection',
    description: 'Inspect a specific pool',
    helpFormat: 'inspect pool <name>',
    parameterized: true,
  },
  {
    name: 'inspect market',
    action: null,
    category: 'Protocol Inspection',
    description: 'Deep market inspection',
    helpFormat: 'inspect market <asset>',
    parameterized: true,
  },
  {
    name: 'protocol fees',
    action: null,
    category: 'Protocol Inspection',
    description: 'On-chain fee rate verification',
    helpFormat: 'protocol fees <market>',
    parameterized: true,
  },
  {
    name: 'protocol verify',
    action: null,
    category: 'Protocol Inspection',
    description: 'Full protocol alignment audit',
  },

  // ── Wallet ──────────────────────────────────────────────────────────────
  {
    name: 'wallet',
    action: ActionType.WalletStatus,
    category: 'Wallet',
    description: 'Wallet status',
    aliases: ['wallet status'],
  },
  {
    name: 'wallet tokens',
    action: ActionType.WalletTokens,
    category: 'Wallet',
    description: 'View all token balances',
  },
  {
    name: 'wallet balance',
    action: ActionType.WalletBalance,
    category: 'Wallet',
    description: 'Show SOL balance',
  },
  {
    name: 'wallet list',
    action: ActionType.WalletList,
    category: 'Wallet',
    description: 'List saved wallets',
  },
  {
    name: 'wallet import',
    action: null,
    category: 'Wallet',
    description: 'Import & store a wallet',
  },
  {
    name: 'wallet use',
    action: null,
    category: 'Wallet',
    description: 'Switch to a saved wallet',
    helpFormat: 'wallet use <name>',
    parameterized: true,
  },
  {
    name: 'wallet connect',
    action: null,
    category: 'Wallet',
    description: 'Connect wallet file',
    helpFormat: 'wallet connect <path>',
    parameterized: true,
  },
  {
    name: 'wallet disconnect',
    action: ActionType.WalletDisconnect,
    category: 'Wallet',
    description: 'Disconnect active wallet',
  },
  {
    name: 'wallet address',
    action: ActionType.WalletAddress,
    category: 'Wallet',
    description: 'Show wallet address',
    hidden: true,
  },

  // ── Utilities ───────────────────────────────────────────────────────────
  {
    name: 'tp status',
    action: ActionType.TpSlStatus,
    category: 'Trading',
    description: 'View active TP/SL targets',
    aliases: ['tpsl status', 'tpsl'],
  },
  {
    name: 'limit',
    action: null,
    category: 'Trading',
    description: 'Place a limit order',
    helpFormat: 'limit long SOL 2x $100 @ $82',
    parameterized: true,
  },
  {
    name: 'cancel order',
    action: null,
    category: 'Trading',
    description: 'Cancel a limit order',
    helpFormat: 'cancel order <id>',
    parameterized: true,
  },
  {
    name: 'edit limit',
    action: null,
    category: 'Trading',
    description: 'Edit a limit order price',
    helpFormat: 'edit limit <id> $<price>',
    parameterized: true,
  },
  {
    name: 'orders',
    action: ActionType.ListOrders,
    category: 'Trading',
    description: 'View active orders (on-chain)',
    aliases: ['order list', 'limit orders'],
  },
  {
    name: 'dryrun',
    action: null,
    category: 'Utilities',
    description: 'Preview trade without executing',
    helpFormat: 'dryrun <command>',
    parameterized: true,
  },
  {
    name: 'monitor',
    action: ActionType.MarketMonitor,
    category: 'Utilities',
    description: 'Live market monitor',
    aliases: ['market monitor'],
  },
  {
    name: 'protocol status',
    action: ActionType.ProtocolStatus,
    category: 'Utilities',
    description: 'Protocol connection overview',
    dispatchAliases: ['protocol'],
  },
  {
    name: 'system status',
    action: ActionType.SystemStatus,
    category: 'Utilities',
    description: 'System health overview',
    dispatchAliases: ['system'],
  },
  {
    name: 'system audit',
    action: ActionType.SystemAudit,
    category: 'Utilities',
    description: 'Verify protocol data integrity',
  },
  {
    name: 'tx metrics',
    action: ActionType.TxMetrics,
    category: 'Utilities',
    description: 'TX engine performance stats',
    aliases: ['tx stats', 'tx perf', 'tx engine'],
  },
  {
    name: 'rpc status',
    action: ActionType.RpcStatus,
    category: 'Utilities',
    description: 'Active RPC endpoint info',
  },
  {
    name: 'rpc test',
    action: ActionType.RpcTest,
    category: 'Utilities',
    description: 'Test all RPC endpoints',
  },
  {
    name: 'tx inspect',
    action: null,
    category: 'Utilities',
    description: 'Inspect a transaction',
    helpFormat: 'tx inspect <sig>',
    parameterized: true,
  },
  {
    name: 'tx debug',
    action: null,
    category: 'Utilities',
    description: 'Debug transaction with protocol context',
    helpFormat: 'tx debug <sig>',
    parameterized: true,
  },
  {
    name: 'source verify',
    action: null,
    category: 'Protocol Inspection',
    description: 'Verify data provenance for a market',
    helpFormat: 'source verify <asset>',
    aliases: ['verify source'],
    parameterized: true,
  },
  {
    name: 'doctor',
    action: null,
    category: 'Utilities',
    description: 'Run terminal diagnostic',
    aliases: ['flash doctor'],
  },
  {
    name: 'engine status',
    action: ActionType.EngineStatus,
    category: 'Utilities',
    description: 'Show execution engine info',
    aliases: ['engine'],
  },
  {
    name: 'benchmark engine',
    action: ActionType.EngineBenchmark,
    category: 'Utilities',
    description: 'Benchmark execution engines',
    aliases: ['engine benchmark'],
  },
  {
    name: 'degen',
    action: null,
    category: 'Utilities',
    description: 'Toggle degen mode',
    aliases: ['degen on', 'degen off'],
  },
  {
    name: 'close all',
    action: ActionType.CloseAll,
    category: 'Trading',
    description: 'Close all open positions',
    aliases: ['close-all', 'closeall', 'exit all'],
  },
  {
    name: 'swap',
    action: null,
    category: 'Trading',
    description: 'Swap tokens via Flash Trade',
    helpFormat: 'swap SOL USDC $10',
    parameterized: true,
  },
  {
    name: 'earn add',
    action: null,
    category: 'Trading',
    description: 'Add liquidity to pool',
    helpFormat: 'earn add $100 crypto',
    aliases: ['earn add-liquidity'],
    parameterized: true,
  },
  {
    name: 'earn remove',
    action: null,
    category: 'Trading',
    description: 'Remove liquidity from pool',
    helpFormat: 'earn remove 50% crypto',
    aliases: ['earn remove-liquidity'],
    parameterized: true,
  },
  {
    name: 'earn stake',
    action: null,
    category: 'Trading',
    description: 'Stake FLP tokens',
    helpFormat: 'earn stake $200 governance',
    aliases: ['earn stake-flp'],
    parameterized: true,
  },
  {
    name: 'earn unstake',
    action: null,
    category: 'Trading',
    description: 'Unstake FLP tokens',
    helpFormat: 'earn unstake 25% governance',
    aliases: ['earn unstake-flp'],
    parameterized: true,
  },
  {
    name: 'earn claim',
    action: ActionType.EarnClaimRewards,
    category: 'Trading',
    description: 'Claim LP/staking rewards',
    aliases: ['earn claim-rewards', 'earn claim rewards'],
  },
  {
    name: 'earn',
    action: ActionType.EarnStatus,
    category: 'Trading',
    description: 'View earn pools with live yield',
    aliases: ['earn status', 'earn pools'],
  },
  {
    name: 'earn info',
    action: null,
    category: 'Trading',
    description: 'Pool details & yield data',
    helpFormat: 'earn info <pool>',
    parameterized: true,
  },
  {
    name: 'earn deposit',
    action: null,
    category: 'Trading',
    description: 'Deposit USDC → FLP (auto-compound)',
    helpFormat: 'earn deposit $100 crypto',
    parameterized: true,
  },
  {
    name: 'earn withdraw',
    action: null,
    category: 'Trading',
    description: 'Withdraw FLP → USDC',
    helpFormat: 'earn withdraw 100% crypto',
    parameterized: true,
  },
  {
    name: 'earn positions',
    action: ActionType.EarnPositions,
    category: 'Trading',
    description: 'View your LP positions',
    aliases: ['earn pos'],
  },
  {
    name: 'earn best',
    action: ActionType.EarnBest,
    category: 'Trading',
    description: 'Rank pools by yield + risk',
  },
  {
    name: 'earn simulate',
    action: null,
    category: 'Trading',
    description: 'Project yield returns',
    helpFormat: 'earn simulate $1000 crypto',
    parameterized: true,
  },
  {
    name: 'earn dashboard',
    action: ActionType.EarnDashboard,
    category: 'Trading',
    description: 'Liquidity portfolio overview',
    aliases: ['earn dash'],
  },
  {
    name: 'earn pnl',
    action: ActionType.EarnPnl,
    category: 'Trading',
    description: 'Earn profit & loss tracking',
    aliases: ['earn profit', 'earn performance'],
  },
  {
    name: 'earn demand',
    action: ActionType.EarnDemand,
    category: 'Trading',
    description: 'Liquidity demand analysis',
    aliases: ['earn utilization'],
  },
  {
    name: 'earn rotate',
    action: ActionType.EarnRotate,
    category: 'Trading',
    description: 'Suggest liquidity rotation',
    aliases: ['earn optimize', 'earn rebalance'],
  },
  // ── FAF Token ────────────────────────────────────────────────────────────
  {
    name: 'faf',
    action: ActionType.FafStatus,
    category: 'Trading',
    description: 'FAF staking dashboard',
    aliases: ['faf status'],
  },
  {
    name: 'faf stake',
    action: null,
    category: 'Trading',
    description: 'Stake FAF for revenue + VIP',
    helpFormat: 'faf stake <amount>',
    parameterized: true,
  },
  {
    name: 'faf unstake',
    action: null,
    category: 'Trading',
    description: 'Request FAF unstake (90-day unlock)',
    helpFormat: 'faf unstake <amount>',
    parameterized: true,
  },
  {
    name: 'faf claim',
    action: ActionType.FafClaim,
    category: 'Trading',
    description: 'Claim FAF rewards + USDC revenue',
    aliases: ['faf claim rewards', 'faf claim revenue', 'faf claim rebate'],
  },
  {
    name: 'faf tier',
    action: ActionType.FafTier,
    category: 'Trading',
    description: 'VIP tier levels + benefits',
    aliases: ['faf tiers', 'faf vip', 'faf levels'],
  },
  {
    name: 'faf rewards',
    action: ActionType.FafRewards,
    category: 'Trading',
    description: 'Pending FAF rewards + USDC',
    aliases: ['faf pending'],
  },

  {
    name: 'help',
    action: ActionType.Help,
    category: 'Utilities',
    description: 'Show this reference',
    aliases: ['commands', '?'],
    hidden: true, // shown separately at bottom of help
  },
  {
    name: 'exit',
    action: null,
    category: 'Utilities',
    description: 'Close the terminal',
    hidden: true, // shown separately at bottom of help
  },
];

// ─── Derived Data ───────────────────────────────────────────────────────────

/** Build FAST_DISPATCH map: command text → { action } for fast routing */
export function buildFastDispatch(): Record<string, { action: ActionType }> {
  const dispatch: Record<string, { action: ActionType }> = {};
  for (const entry of COMMAND_REGISTRY) {
    if (!entry.action) continue;
    dispatch[entry.name] = { action: entry.action };
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        dispatch[alias] = { action: entry.action };
      }
    }
    if (entry.dispatchAliases) {
      for (const alias of entry.dispatchAliases) {
        dispatch[alias] = { action: entry.action };
      }
    }
  }
  return dispatch;
}

/** Typed version for use as ParsedIntent lookup */
export type FastDispatchMap = Record<string, { action: ActionType }>;

/** All command names for autocomplete (primary names + aliases, deduplicated) */
export function getAutocompleteCommands(): string[] {
  const seen = new Set<string>();
  for (const entry of COMMAND_REGISTRY) {
    seen.add(entry.name);
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        seen.add(alias);
      }
    }
  }
  return [...seen];
}

/** Category order for help output */
const CATEGORY_ORDER: CommandCategory[] = [
  'Trading',
  'Market Data & Analytics',
  'Portfolio & Risk',
  'Protocol Inspection',
  'Wallet',
  'Utilities',
];

/** Get commands grouped by category for help generation */
export function getCommandsByCategory(): Map<CommandCategory, CommandEntry[]> {
  const map = new Map<CommandCategory, CommandEntry[]>();
  for (const cat of CATEGORY_ORDER) {
    map.set(cat, []);
  }
  for (const entry of COMMAND_REGISTRY) {
    if (entry.hidden) continue;
    const list = map.get(entry.category);
    if (list) list.push(entry);
  }
  return map;
}

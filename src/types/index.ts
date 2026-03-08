import { z } from 'zod';
import type { WalletManager } from '../wallet/walletManager.js';

// ─── Trading Enums ───────────────────────────────────────────────────────────

export enum TradeSide {
  Long = 'long',
  Short = 'short',
}

export enum ActionType {
  OpenPosition = 'open_position',
  ClosePosition = 'close_position',
  AddCollateral = 'add_collateral',
  RemoveCollateral = 'remove_collateral',
  GetPositions = 'get_positions',
  GetMarketData = 'get_market_data',
  GetPortfolio = 'get_portfolio',
  GetVolume = 'get_volume',
  GetOpenInterest = 'get_open_interest',
  GetLeaderboard = 'get_leaderboard',
  GetTraderProfile = 'get_trader_profile',
  GetFees = 'get_fees',
  WalletConnect = 'wallet_connect',
  WalletImport = 'wallet_import',
  WalletList = 'wallet_list',
  WalletUse = 'wallet_use',
  WalletRemove = 'wallet_remove',
  WalletDisconnect = 'wallet_disconnect',
  WalletStatus = 'wallet_status',
  WalletAddress = 'wallet_address',
  WalletBalance = 'wallet_balance',
  WalletTokens = 'wallet_tokens',
  Help = 'help',
  FlashMarkets = 'flash_markets',

  // AI Agent
  Analyze = 'analyze',
  SuggestTrade = 'suggest_trade',
  RiskReport = 'risk_report',
  Dashboard = 'dashboard',
  WhaleActivity = 'whale_activity',

  // Autopilot
  AutopilotStart = 'autopilot_start',
  AutopilotStop = 'autopilot_stop',
  AutopilotStatus = 'autopilot_status',

  // Market Scanner
  ScanMarkets = 'scan_markets',

  // Portfolio Intelligence
  PortfolioState = 'portfolio_state',
  PortfolioExposure = 'portfolio_exposure',
  PortfolioRebalance = 'portfolio_rebalance',

  // Risk Monitor
  RiskMonitorOn = 'risk_monitor_on',
  RiskMonitorOff = 'risk_monitor_off',

  // Protocol Inspector
  InspectProtocol = 'inspect_protocol',
  InspectPool = 'inspect_pool',
  InspectMarket = 'inspect_market',

  // System Diagnostics
  SystemStatus = 'system_status',
  RpcStatus = 'rpc_status',
  RpcTest = 'rpc_test',
  TxInspect = 'tx_inspect',

  // Trade Journal
  TradeHistory = 'trade_history',

  // Market Monitor
  MarketMonitor = 'market_monitor',

  // Dry Run
  DryRun = 'dry_run',
}

// ─── Zod Schemas for Intent Parsing ──────────────────────────────────────────

export const OpenPositionSchema = z.object({
  action: z.literal(ActionType.OpenPosition),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
  collateral: z.number().positive().max(10_000_000),
  leverage: z.number().min(1).max(100),
  collateral_token: z.string().optional(),
});

export const ClosePositionSchema = z.object({
  action: z.literal(ActionType.ClosePosition),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
});

export const AddCollateralSchema = z.object({
  action: z.literal(ActionType.AddCollateral),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
  amount: z.number().positive().max(10_000_000),
});

export const RemoveCollateralSchema = z.object({
  action: z.literal(ActionType.RemoveCollateral),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
  amount: z.number().positive().max(10_000_000),
});

export const GetPositionsSchema = z.object({
  action: z.literal(ActionType.GetPositions),
});

export const GetMarketDataSchema = z.object({
  action: z.literal(ActionType.GetMarketData),
  market: z.string().optional(),
});

export const GetPortfolioSchema = z.object({
  action: z.literal(ActionType.GetPortfolio),
});

export const GetVolumeSchema = z.object({
  action: z.literal(ActionType.GetVolume),
  period: z.enum(['7d', '30d', 'all']).optional(),
});

export const GetOpenInterestSchema = z.object({
  action: z.literal(ActionType.GetOpenInterest),
});

export const GetLeaderboardSchema = z.object({
  action: z.literal(ActionType.GetLeaderboard),
  metric: z.enum(['pnl', 'volume']).optional(),
  period: z.number().optional(),
  limit: z.number().optional(),
});

export const GetTraderProfileSchema = z.object({
  action: z.literal(ActionType.GetTraderProfile),
  address: z.string(),
});

export const GetFeesSchema = z.object({
  action: z.literal(ActionType.GetFees),
  period: z.number().optional(),
});

export const HelpSchema = z.object({
  action: z.literal(ActionType.Help),
});

export const WalletConnectSchema = z.object({
  action: z.literal(ActionType.WalletConnect),
  path: z.string(),
});

export const WalletImportSchema = z.object({
  action: z.literal(ActionType.WalletImport),
  name: z.string(),
  path: z.string(),
});

export const WalletListSchema = z.object({
  action: z.literal(ActionType.WalletList),
});

export const WalletUseSchema = z.object({
  action: z.literal(ActionType.WalletUse),
  name: z.string(),
});

export const WalletRemoveSchema = z.object({
  action: z.literal(ActionType.WalletRemove),
  name: z.string(),
});

export const WalletDisconnectSchema = z.object({
  action: z.literal(ActionType.WalletDisconnect),
});

export const WalletStatusSchema = z.object({
  action: z.literal(ActionType.WalletStatus),
});

export const WalletAddressSchema = z.object({
  action: z.literal(ActionType.WalletAddress),
});

export const WalletBalanceSchema = z.object({
  action: z.literal(ActionType.WalletBalance),
});

export const WalletTokensSchema = z.object({
  action: z.literal(ActionType.WalletTokens),
});

export const FlashMarketsSchema = z.object({
  action: z.literal(ActionType.FlashMarkets),
});

// AI Agent Schemas
export const AnalyzeSchema = z.object({
  action: z.literal(ActionType.Analyze),
  market: z.string(),
});

export const SuggestTradeSchema = z.object({
  action: z.literal(ActionType.SuggestTrade),
  market: z.string().optional(),
});

export const RiskReportSchema = z.object({
  action: z.literal(ActionType.RiskReport),
});

export const DashboardSchema = z.object({
  action: z.literal(ActionType.Dashboard),
});

export const WhaleActivitySchema = z.object({
  action: z.literal(ActionType.WhaleActivity),
  market: z.string().optional(),
});

// Autopilot Schemas
export const AutopilotStartSchema = z.object({
  action: z.literal(ActionType.AutopilotStart),
});

export const AutopilotStopSchema = z.object({
  action: z.literal(ActionType.AutopilotStop),
});

export const AutopilotStatusSchema = z.object({
  action: z.literal(ActionType.AutopilotStatus),
});

// Market Scanner Schema
export const ScanMarketsSchema = z.object({
  action: z.literal(ActionType.ScanMarkets),
});

// Portfolio Intelligence Schemas
export const PortfolioStateSchema = z.object({
  action: z.literal(ActionType.PortfolioState),
});

export const PortfolioExposureSchema = z.object({
  action: z.literal(ActionType.PortfolioExposure),
});

export const PortfolioRebalanceSchema = z.object({
  action: z.literal(ActionType.PortfolioRebalance),
});

export const RiskMonitorOnSchema = z.object({
  action: z.literal(ActionType.RiskMonitorOn),
});

export const RiskMonitorOffSchema = z.object({
  action: z.literal(ActionType.RiskMonitorOff),
});

export const InspectProtocolSchema = z.object({
  action: z.literal(ActionType.InspectProtocol),
});

export const InspectPoolSchema = z.object({
  action: z.literal(ActionType.InspectPool),
  pool: z.string().optional(),
});

export const InspectMarketSchema = z.object({
  action: z.literal(ActionType.InspectMarket),
  market: z.string().optional(),
});

export const SystemStatusSchema = z.object({
  action: z.literal(ActionType.SystemStatus),
});

export const RpcStatusSchema = z.object({
  action: z.literal(ActionType.RpcStatus),
});

export const RpcTestSchema = z.object({
  action: z.literal(ActionType.RpcTest),
});

export const TxInspectSchema = z.object({
  action: z.literal(ActionType.TxInspect),
  signature: z.string().optional(),
});

export const TradeHistorySchema = z.object({
  action: z.literal(ActionType.TradeHistory),
});

export const MarketMonitorSchema = z.object({
  action: z.literal(ActionType.MarketMonitor),
});

export const DryRunSchema = z.object({
  action: z.literal(ActionType.DryRun),
  innerCommand: z.string(),
});

export const ParsedIntentSchema = z.discriminatedUnion('action', [
  OpenPositionSchema,
  ClosePositionSchema,
  AddCollateralSchema,
  RemoveCollateralSchema,
  GetPositionsSchema,
  GetMarketDataSchema,
  GetPortfolioSchema,
  GetVolumeSchema,
  GetOpenInterestSchema,
  GetLeaderboardSchema,
  GetTraderProfileSchema,
  GetFeesSchema,
  WalletConnectSchema,
  WalletImportSchema,
  WalletListSchema,
  WalletUseSchema,
  WalletRemoveSchema,
  WalletDisconnectSchema,
  WalletStatusSchema,
  WalletAddressSchema,
  WalletBalanceSchema,
  WalletTokensSchema,
  HelpSchema,
  FlashMarketsSchema,
  AnalyzeSchema,
  SuggestTradeSchema,
  RiskReportSchema,
  DashboardSchema,
  WhaleActivitySchema,
  AutopilotStartSchema,
  AutopilotStopSchema,
  AutopilotStatusSchema,
  ScanMarketsSchema,
  PortfolioStateSchema,
  PortfolioExposureSchema,
  PortfolioRebalanceSchema,
  RiskMonitorOnSchema,
  RiskMonitorOffSchema,
  InspectProtocolSchema,
  InspectPoolSchema,
  InspectMarketSchema,
  SystemStatusSchema,
  RpcStatusSchema,
  RpcTestSchema,
  TxInspectSchema,
  TradeHistorySchema,
  MarketMonitorSchema,
  DryRunSchema,
]);

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;
export type OpenPositionIntent = z.infer<typeof OpenPositionSchema>;
export type ClosePositionIntent = z.infer<typeof ClosePositionSchema>;
export type AddCollateralIntent = z.infer<typeof AddCollateralSchema>;
export type RemoveCollateralIntent = z.infer<typeof RemoveCollateralSchema>;

// ─── Trade Results ───────────────────────────────────────────────────────────

export interface OpenPositionResult {
  txSignature: string;
  entryPrice: number;
  liquidationPrice: number;
  sizeUsd: number;
}

export interface ClosePositionResult {
  txSignature: string;
  exitPrice: number;
  pnl: number;
}

export interface CollateralResult {
  txSignature: string;
  newLeverage?: number;
}

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface Position {
  pubkey: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  markPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  openFee: number;
  totalFees: number;
  fundingRate: number;
  timestamp: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  priceChange24h: number;
  openInterestLong: number;
  openInterestShort: number;
  maxLeverage: number;
  fundingRate: number;
}

export interface Portfolio {
  walletAddress: string;
  balance: number;
  balanceLabel: string;
  totalCollateralUsd: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalFees: number;
  positions: Position[];
  totalPositionValue: number;
  usdcBalance?: number;
}

export interface VolumeData {
  period: string;
  totalVolumeUsd: number;
  trades: number;
  uniqueTraders: number;
  dailyVolumes: DailyVolume[];
}

export interface DailyVolume {
  date: string;
  volumeUsd: number;
  trades: number;
  longVolume: number;
  shortVolume: number;
  liquidationVolume: number;
}

export interface OpenInterestData {
  markets: MarketOI[];
}

export interface MarketOI {
  market: string;
  longOi: number;
  shortOi: number;
  longPositions: number;
  shortPositions: number;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  pnl: number;
  volume: number;
  trades: number;
  winRate: number;
}

export interface TraderProfile {
  address: string;
  totalTrades: number;
  totalVolume: number;
  totalPnl: number;
  winRate: number;
  markets: Record<string, { trades: number; volume: number; pnl: number }>;
}

export interface FeeData {
  period: string;
  totalFees: number;
  lpShare: number;
  tokenShare: number;
  teamShare: number;
  dailyFees: { date: string; totalFees: number }[];
}

export interface OverviewStats {
  volumeUsd: number;
  volumeChangePct: number;
  trades: number;
  tradesChangePct: number;
  feesUsd: number;
  poolPnlUsd: number;
  poolRevenueUsd: number;
  uniqueTraders: number;
}

// ─── AI Agent Domain Types ───────────────────────────────────────────────────

export interface StrategySignal {
  name: string;
  signal: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0-1
  reasoning: string;
}

export interface RiskAssessment {
  market: string;
  side: TradeSide;
  leverage: number;
  distanceToLiquidation: number; // percentage
  riskLevel: 'healthy' | 'warning' | 'critical';
  message: string;
}

export interface MarketAnalysis {
  market: string;
  price: number;
  priceChange24h: number;
  openInterestLong: number;
  openInterestShort: number;
  volume24h: number;
  signals: StrategySignal[];
  summary: string;
}

export interface TradeSuggestion {
  market: string;
  side: TradeSide;
  leverage: number;
  collateral: number;
  reasoning: string;
  confidence: number; // 0-1
  risks: string[];
}

export interface ExposureSummary {
  totalLongExposure: number;
  totalShortExposure: number;
  netExposure: number;
  totalCollateral: number;
  collateralUtilization: number; // percentage
  concentrationRisk: { market: string; percentage: number }[];
}

// ─── Autopilot Types ─────────────────────────────────────────────────────────

export interface AutopilotConfig {
  maxPositionSize: number;
  maxExposure: number;
  maxLeverage: number;
  intervalMs: number;
  markets: string[];
}

export interface AutopilotState {
  active: boolean;
  startedAt: number | null;
  cycleCount: number;
  lastCycleAt: number | null;
  lastSuggestion: TradeSuggestion | null;
  lastSignals: StrategySignal[];
}

export interface AggregatedSignal {
  market: string;
  direction: TradeSide;
  recommendedLeverage: number;
  confidenceScore: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  signalBreakdown: StrategySignal[];
  source: 'ai' | 'strategy_engine';
}

// ─── Market Scanner Types ───────────────────────────────────────────────────

export interface Opportunity {
  market: string;
  direction: TradeSide;
  confidence: number;
  volumeScore: number;
  oiScore: number;
  whaleScore: number;
  totalScore: number;
  recommendedLeverage: number;
  recommendedCollateral: number;
  signals: StrategySignal[];
  reasoning: string;
  regime?: string;
}

// ─── Raw Data Types (from fstats API) ────────────────────────────────────────

export interface RawActivityRecord {
  market_symbol?: string;
  market?: string;
  side?: string;
  size_usd?: number;
  mark_price?: number;
  entry_price?: number;
  timestamp?: number;
  [key: string]: unknown;
}

// ─── Dry Run Preview ──────────────────────────────────────────────────────

export interface DryRunPreview {
  market: string;
  side: TradeSide;
  collateral: number;
  leverage: number;
  positionSize: number;
  entryPrice: number;
  liquidationPrice: number;
  estimatedFee: number;
  programId?: string;
  accountCount?: number;
  instructionCount?: number;
  estimatedComputeUnits?: number;
  transactionSize?: number;
  simulationSuccess?: boolean;
  simulationLogs?: string[];
  simulationError?: string;
  simulationUnitsConsumed?: number;
}

// ─── Client Interfaces ───────────────────────────────────────────────────────

export interface IFlashClient {
  readonly walletAddress: string;

  openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string
  ): Promise<OpenPositionResult>;

  closePosition(
    market: string,
    side: TradeSide,
    receiveToken?: string
  ): Promise<ClosePositionResult>;

  addCollateral(
    market: string,
    side: TradeSide,
    amount: number
  ): Promise<CollateralResult>;

  removeCollateral(
    market: string,
    side: TradeSide,
    amount: number
  ): Promise<CollateralResult>;

  getPositions(): Promise<Position[]>;
  getMarketData(market?: string): Promise<MarketData[]>;
  getPortfolio(): Promise<Portfolio>;
  getBalance(): number;

  /** Get recent trade history (simulation mode). */
  getTradeHistory?(): SimulatedTrade[];

  /** Build a transaction preview without signing or sending. */
  previewOpenPosition?(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<DryRunPreview>;
}

export interface IDataClient {
  getOverviewStats(period?: '7d' | '30d' | 'all'): Promise<OverviewStats>;
  getVolume(days?: number, pool?: string): Promise<VolumeData>;
  getOpenInterest(): Promise<OpenInterestData>;
  getLeaderboard(metric?: 'pnl' | 'volume', days?: number, limit?: number): Promise<LeaderboardEntry[]>;
  getTraderProfile(address: string): Promise<TraderProfile>;
  getFees(days?: number): Promise<FeeData>;
  getRecentActivity?(limit?: number): Promise<RawActivityRecord[]>;
  getOpenPositions?(): Promise<RawActivityRecord[]>;
}

// ─── Tool System Types ───────────────────────────────────────────────────────

export interface ToolExecutionData {
  executeAction?: () => Promise<ToolResult>;
  positions?: Position[];
  markets?: MarketData[];
  portfolio?: Portfolio;
  volume?: VolumeData;
  openInterest?: OpenInterestData;
  leaderboard?: LeaderboardEntry[];
  traderProfile?: TraderProfile;
  fees?: FeeData;
  analysis?: MarketAnalysis;
  suggestion?: TradeSuggestion;
  riskAssessments?: RiskAssessment[];
  exposure?: ExposureSummary;
  opportunities?: Opportunity[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ToolResult {
  success: boolean;
  data?: ToolExecutionData;
  message: string;
  txSignature?: string;
  requiresConfirmation?: boolean;
  confirmationPrompt?: string;
}

export interface ToolContext {
  flashClient: IFlashClient;
  dataClient: IDataClient;
  simulationMode: boolean;
  walletAddress: string;
  walletName: string;
  walletManager?: WalletManager;
}

export interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  description: string;
  parameters?: import('zod').ZodType<TParams>;
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult>;
}

// ─── Config Types ────────────────────────────────────────────────────────────

export const VALID_NETWORKS = ['mainnet-beta', 'devnet'] as const;
export type Network = (typeof VALID_NETWORKS)[number];

export interface FlashConfig {
  rpcUrl: string;
  backupRpcUrls: string[];
  pythnetUrl: string;
  walletPath: string;
  anthropicApiKey: string;
  groqApiKey: string;
  defaultPool: string;
  network: Network;
  simulationMode: boolean;
  defaultSlippageBps: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  logFile: string | null;
  // Signing guard limits (0 = unlimited / use market defaults)
  maxCollateralPerTrade: number;
  maxPositionSize: number;
  maxLeverage: number;
  maxTradesPerMinute: number;
  minDelayBetweenTradesMs: number;
  /** Disable plugin loading (--no-plugins flag) */
  noPlugins?: boolean;
}

// ─── Simulation Types ────────────────────────────────────────────────────────

export interface SimulatedPosition {
  id: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  openFee: number;
  openedAt: number;
}

export interface SimulationState {
  balance: number;
  positions: SimulatedPosition[];
  tradeHistory: SimulatedTrade[];
  totalRealizedPnl: number;
  totalFeesPaid: number;
}

export interface SimulatedTrade {
  id: string;
  action: string;
  market: string;
  side: TradeSide;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  price: number;
  pnl?: number;
  timestamp: number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export const LEVERAGE_LIMITS: Record<string, { min: number; max: number }> = {
  SOL: { min: 1.1, max: 100 },
  BTC: { min: 1.1, max: 100 },
  ETH: { min: 1.1, max: 100 },
  DEFAULT: { min: 1.1, max: 50 },
};

export function getLeverageLimits(market: string): { min: number; max: number } {
  return LEVERAGE_LIMITS[market] ?? LEVERAGE_LIMITS['DEFAULT'];
}

export interface TradeValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateTrade(
  market: string,
  side: TradeSide,
  collateral: number,
  leverage: number,
  balance: number
): TradeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const limits = getLeverageLimits(market);

  if (collateral <= 0) errors.push('Collateral must be positive');
  if (collateral > balance) errors.push(`Insufficient balance: $${balance.toFixed(2)} available`);
  if (leverage < limits.min) errors.push(`Minimum leverage for ${market}: ${limits.min}x`);
  if (leverage > limits.max) errors.push(`Maximum leverage for ${market}: ${limits.max}x`);

  // Warnings
  if (leverage >= 20) warnings.push(`High leverage (${leverage}x) — liquidation risk is significant`);
  if (leverage >= 50) warnings.push('Extreme leverage — small price moves can liquidate');

  const liqDistance = (1 / leverage) * 100;
  if (liqDistance < 5) {
    warnings.push(`Liquidation within ${liqDistance.toFixed(1)}% price move`);
  }

  if (collateral > balance * 0.5) {
    warnings.push(`Using ${((collateral / balance) * 100).toFixed(0)}% of available balance`);
  }

  return { valid: errors.length === 0, warnings, errors };
}

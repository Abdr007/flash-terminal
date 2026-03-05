import { z } from 'zod';

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
  Help = 'help',
}

// ─── Zod Schemas for Intent Parsing ──────────────────────────────────────────

export const OpenPositionSchema = z.object({
  action: z.literal(ActionType.OpenPosition),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
  collateral: z.number().positive(),
  leverage: z.number().min(1).max(500),
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
  amount: z.number().positive(),
});

export const RemoveCollateralSchema = z.object({
  action: z.literal(ActionType.RemoveCollateral),
  market: z.string(),
  side: z.nativeEnum(TradeSide),
  amount: z.number().positive(),
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
  HelpSchema,
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
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
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
  positions: Position[];
  totalPositionValue: number;
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
}

export interface IDataClient {
  getOverviewStats(period?: '7d' | '30d' | 'all'): Promise<OverviewStats>;
  getVolume(days?: number, pool?: string): Promise<VolumeData>;
  getOpenInterest(): Promise<OpenInterestData>;
  getLeaderboard(metric?: 'pnl' | 'volume', days?: number, limit?: number): Promise<LeaderboardEntry[]>;
  getTraderProfile(address: string): Promise<TraderProfile>;
  getFees(days?: number): Promise<FeeData>;
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
  pythnetUrl: string;
  walletPath: string;
  anthropicApiKey: string;
  defaultPool: string;
  network: Network;
  simulationMode: boolean;
  defaultSlippageBps: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  logFile: string | null;
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
  openedAt: number;
}

export interface SimulationState {
  balance: number;
  positions: SimulatedPosition[];
  tradeHistory: SimulatedTrade[];
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

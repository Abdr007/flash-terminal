import {
  OverviewStats,
  VolumeData,
  DailyVolume,
  OpenInterestData,
  MarketOI,
  LeaderboardEntry,
  TraderProfile,
  FeeData,
  IDataClient,
} from '../types/index.js';
import { FSTATS_BASE_URL } from '../config/index.js';
import { withRetry } from '../utils/retry.js';
import { getLogger } from '../utils/logger.js';

const FETCH_TIMEOUT_MS = 10_000;

interface RawOverviewStats {
  volume_usd?: number;
  volume_change_pct?: number;
  trades?: number;
  trades_change_pct?: number;
  fees_usd?: number;
  pool_pnl_usd?: number;
  pool_revenue_usd?: number;
  unique_traders?: number;
}

interface RawDailyVolume {
  date: string;
  volume_usd?: number;
  trades?: number;
  long_volume?: number;
  short_volume?: number;
  liquidation_volume?: number;
}

interface RawMarketOI {
  market_symbol?: string;
  market?: string;
  long_oi?: number;
  long_open_interest?: number;
  short_oi?: number;
  short_open_interest?: number;
  long_positions?: number;
  short_positions?: number;
}

interface RawLeaderboardEntry {
  address?: string;
  owner?: string;
  pnl?: number;
  net_pnl?: number;
  volume?: number;
  total_volume?: number;
  trades?: number;
  total_trades?: number;
  win_rate?: number;
}

interface RawTraderProfile {
  address?: string;
  total_trades?: number;
  total_volume?: number;
  total_pnl?: number;
  net_pnl?: number;
  win_rate?: number;
  markets?: Record<string, { trades: number; volume: number; pnl: number }>;
}

interface RawDailyFee {
  date: string;
  total_fees?: number;
  lp_share?: number;
  token_share?: number;
  team_share?: number;
}

interface RawOpenPosition {
  market_symbol?: string;
  market?: string;
  mark_price?: number;
  entry_price?: number;
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${FSTATS_BASE_URL}${path}`;
  const logger = getLogger();
  logger.api(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`fstats ${res.status}: ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new Error(`fstats returned non-JSON response: ${contentType}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry<T>(path: string): Promise<T> {
  return withRetry(() => fetchJson<T>(path), `fstats:${path}`);
}

export class FStatsClient implements IDataClient {
  async getOverviewStats(period: '7d' | '30d' | 'all' = '30d'): Promise<OverviewStats> {
    const raw = await fetchWithRetry<RawOverviewStats>(`/overview/stats?period=${period}`);
    return {
      volumeUsd: raw.volume_usd ?? 0,
      volumeChangePct: raw.volume_change_pct ?? 0,
      trades: raw.trades ?? 0,
      tradesChangePct: raw.trades_change_pct ?? 0,
      feesUsd: raw.fees_usd ?? 0,
      poolPnlUsd: raw.pool_pnl_usd ?? 0,
      poolRevenueUsd: raw.pool_revenue_usd ?? 0,
      uniqueTraders: raw.unique_traders ?? 0,
    };
  }

  async getRecentActivity(limit = 20): Promise<RawOpenPosition[]> {
    return fetchWithRetry<RawOpenPosition[]>(`/overview/activity?limit=${limit}`);
  }

  async getVolume(days = 30, pool?: string): Promise<VolumeData> {
    const poolParam = pool ? `&pool=${pool}` : '';
    const daily = await fetchWithRetry<RawDailyVolume[]>(`/volume/daily?days=${days}${poolParam}`);
    const dailyVolumes: DailyVolume[] = (daily ?? []).map((d) => ({
      date: d.date,
      volumeUsd: d.volume_usd ?? 0,
      trades: d.trades ?? 0,
      longVolume: d.long_volume ?? 0,
      shortVolume: d.short_volume ?? 0,
      liquidationVolume: d.liquidation_volume ?? 0,
    }));
    const totalVolumeUsd = dailyVolumes.reduce((sum, d) => sum + d.volumeUsd, 0);
    const totalTrades = dailyVolumes.reduce((sum, d) => sum + d.trades, 0);
    return {
      period: `${days}d`,
      totalVolumeUsd,
      trades: totalTrades,
      uniqueTraders: 0,
      dailyVolumes,
    };
  }

  async getOpenInterest(): Promise<OpenInterestData> {
    const raw = await fetchWithRetry<RawMarketOI[]>('/positions/open-interest');
    const markets: MarketOI[] = (raw ?? []).map((m) => ({
      market: m.market_symbol ?? m.market ?? '',
      longOi: m.long_oi ?? m.long_open_interest ?? 0,
      shortOi: m.short_oi ?? m.short_open_interest ?? 0,
      longPositions: m.long_positions ?? 0,
      shortPositions: m.short_positions ?? 0,
    }));
    return { markets };
  }

  async getOpenPositions(): Promise<RawOpenPosition[]> {
    return fetchWithRetry<RawOpenPosition[]>('/positions/open');
  }

  async getFees(days = 30): Promise<FeeData> {
    const daily = await fetchWithRetry<RawDailyFee[]>(`/fees/daily?days=${days}`);
    const dailyFees = (daily ?? []).map((d) => ({
      date: d.date,
      totalFees: d.total_fees ?? 0,
    }));
    const totalFees = dailyFees.reduce((sum, d) => sum + d.totalFees, 0);
    const lastEntry = daily?.[daily.length - 1];
    return {
      period: `${days}d`,
      totalFees,
      lpShare: lastEntry?.lp_share ?? 0,
      tokenShare: lastEntry?.token_share ?? 0,
      teamShare: lastEntry?.team_share ?? 0,
      dailyFees,
    };
  }

  async getLeaderboard(
    metric: 'pnl' | 'volume' = 'pnl',
    days = 30,
    limit = 10
  ): Promise<LeaderboardEntry[]> {
    const raw = await fetchWithRetry<RawLeaderboardEntry[]>(
      `/leaderboards/${metric}?days=${days}&limit=${limit}`
    );
    return (raw ?? []).map((entry, i) => ({
      rank: i + 1,
      address: entry.address ?? entry.owner ?? '',
      pnl: entry.pnl ?? entry.net_pnl ?? 0,
      volume: entry.volume ?? entry.total_volume ?? 0,
      trades: entry.trades ?? entry.total_trades ?? 0,
      winRate: entry.win_rate ?? 0,
    }));
  }

  async getTraderProfile(address: string): Promise<TraderProfile> {
    const raw = await fetchWithRetry<RawTraderProfile>(`/traders/${address}`);
    return {
      address: raw.address ?? address,
      totalTrades: raw.total_trades ?? 0,
      totalVolume: raw.total_volume ?? 0,
      totalPnl: raw.total_pnl ?? raw.net_pnl ?? 0,
      winRate: raw.win_rate ?? 0,
      markets: raw.markets ?? {},
    };
  }
}

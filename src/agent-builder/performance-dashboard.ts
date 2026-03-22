/**
 * Performance Dashboard — Professional evaluation layer.
 *
 * Tracks, analyzes, and alerts on all agent performance metrics.
 * Full audit trail of every decision for provable profitability.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerformanceSnapshot {
  timestamp: number;
  equity: number;
  pnl: number;
  drawdownPct: number;
  sharpe7d: number;
  sharpe30d: number;
  winRate: number;
  ev: number;
  tradeCount: number;
  explorationRate: number;
  mode: string;
}

export interface AuditEntry {
  tick: number;
  timestamp: string;
  market: string;
  /** state → action → outcome chain */
  state: string;
  action: string;
  score: number;
  outcome: 'executed' | 'skipped' | 'blocked' | 'pending';
  reward?: number;
  pnl?: number;
  reasoning: string;
}

export interface DegradationAlert {
  type: 'sharpe_drop' | 'drawdown_breach' | 'win_rate_collapse' | 'ev_negative';
  severity: 'warning' | 'critical';
  message: string;
  timestamp: string;
  value: number;
  threshold: number;
}

export interface DashboardReport {
  /** Rolling performance */
  performance: {
    sharpe7d: number;
    sharpe30d: number;
    maxDrawdownPct: number;
    currentDrawdownPct: number;
    winRate: number;
    winRateStability: number;
    ev: number;
    profitFactor: number;
    totalPnl: number;
    totalTrades: number;
  };
  /** Behavior metrics */
  behavior: {
    avgTradesPerHour: number;
    explorationRate: number;
    strategyDistribution: Record<string, number>;
    modeDistribution: Record<string, number>;
  };
  /** Active alerts */
  alerts: DegradationAlert[];
  /** Equity curve (last 100 points) */
  equityCurve: Array<{ tick: number; equity: number }>;
  /** Drawdown curve */
  drawdownCurve: Array<{ tick: number; drawdownPct: number }>;
  /** Rolling Sharpe */
  sharpeCurve: Array<{ tick: number; sharpe: number }>;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

const SHARPE_WARNING = 0.3;
const SHARPE_CRITICAL = -0.5;
const DRAWDOWN_WARNING = 0.08;
const DRAWDOWN_CRITICAL = 0.15;
const WIN_RATE_WARNING = 0.35;
const _EV_WARNING = -1;

// ─── Performance Dashboard ───────────────────────────────────────────────────

export class PerformanceDashboard {
  private equityHistory: Array<{ tick: number; equity: number }> = [];
  private drawdownHistory: Array<{ tick: number; drawdownPct: number }> = [];
  private sharpeHistory: Array<{ tick: number; sharpe: number }> = [];
  private recentPnls: number[] = [];
  private winRateHistory: number[] = [];
  private auditLog: AuditEntry[] = [];
  private alerts: DegradationAlert[] = [];
  private strategyCount: Record<string, number> = {};
  private modeCount: Record<string, number> = {};
  private tradeTimestamps: number[] = [];
  private peakEquity = 0;
  private readonly maxHistory = 500;
  private readonly maxAudit = 1000;

  // ─── Recording ─────────────────────────────────────────────────────

  /**
   * Record an equity snapshot. Call every tick.
   */
  recordTick(tick: number, equity: number, mode: string, _explorationRate: number): void {
    // Equity curve
    this.equityHistory.push({ tick, equity });
    if (this.equityHistory.length > this.maxHistory) this.equityHistory.shift();

    // Peak + drawdown
    if (equity > this.peakEquity) this.peakEquity = equity;
    const ddPct = this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0;
    this.drawdownHistory.push({ tick, drawdownPct: ddPct });
    if (this.drawdownHistory.length > this.maxHistory) this.drawdownHistory.shift();

    // Rolling Sharpe
    if (this.recentPnls.length >= 5) {
      const sharpe = this.computeRollingSharpe(this.recentPnls.slice(-20));
      this.sharpeHistory.push({ tick, sharpe });
      if (this.sharpeHistory.length > this.maxHistory) this.sharpeHistory.shift();
    }

    // Mode distribution
    this.modeCount[mode] = (this.modeCount[mode] ?? 0) + 1;

    // Check alerts
    this.checkAlerts(ddPct);
  }

  /**
   * Record a trade outcome.
   */
  recordTrade(pnl: number, strategy: string): void {
    this.recentPnls.push(pnl);
    if (this.recentPnls.length > 200) this.recentPnls.shift();

    this.tradeTimestamps.push(Date.now());
    this.tradeTimestamps = this.tradeTimestamps.filter((t) => Date.now() - t < 86_400_000);

    this.strategyCount[strategy] = (this.strategyCount[strategy] ?? 0) + 1;

    // Track win rate stability (rolling window of win rates)
    const last20 = this.recentPnls.slice(-20);
    const wr = last20.filter((p) => p > 0).length / last20.length;
    this.winRateHistory.push(wr);
    if (this.winRateHistory.length > 50) this.winRateHistory.shift();
  }

  /**
   * Record an audit entry (every decision, executed or not).
   */
  audit(entry: AuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > this.maxAudit) this.auditLog.shift();
  }

  // ─── Reporting ─────────────────────────────────────────────────────

  /**
   * Generate full dashboard report.
   */
  getReport(): DashboardReport {
    const pnls = this.recentPnls;
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const grossProfit = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

    const sharpe7d = this.computeRollingSharpe(pnls.slice(-50));  // ~7d at 10 trades/day
    const sharpe30d = this.computeRollingSharpe(pnls);

    const lastDD = this.drawdownHistory.length > 0 ? this.drawdownHistory[this.drawdownHistory.length - 1].drawdownPct : 0;
    const maxDD = this.drawdownHistory.length > 0 ? Math.max(...this.drawdownHistory.map((d) => d.drawdownPct)) : 0;

    const winRate = pnls.length > 0 ? wins.length / pnls.length : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const ev = pnls.length > 0 ? (winRate * avgWin) - ((1 - winRate) * avgLoss) : 0;

    // Win rate stability: standard deviation of rolling win rates
    const wrStability = this.winRateHistory.length >= 5 ? 1 - this.computeStdDev(this.winRateHistory) : 0;

    // Strategy distribution (normalized)
    const totalStrats = Object.values(this.strategyCount).reduce((a, b) => a + b, 0);
    const stratDist: Record<string, number> = {};
    for (const [s, c] of Object.entries(this.strategyCount)) {
      stratDist[s] = totalStrats > 0 ? c / totalStrats : 0;
    }

    // Mode distribution (normalized)
    const totalModes = Object.values(this.modeCount).reduce((a, b) => a + b, 0);
    const modeDist: Record<string, number> = {};
    for (const [m, c] of Object.entries(this.modeCount)) {
      modeDist[m] = totalModes > 0 ? c / totalModes : 0;
    }

    // Trades per hour
    const hourMs = 3_600_000;
    const _recentTrades = this.tradeTimestamps.filter((t) => Date.now() - t < hourMs);
    const hoursTracked = Math.max(1, this.tradeTimestamps.length > 0 ? (Date.now() - this.tradeTimestamps[0]) / hourMs : 1);
    const avgTradesPerHour = this.tradeTimestamps.length / hoursTracked;

    return {
      performance: {
        sharpe7d, sharpe30d,
        maxDrawdownPct: maxDD,
        currentDrawdownPct: lastDD,
        winRate,
        winRateStability: Math.max(0, wrStability),
        ev,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0,
        totalPnl,
        totalTrades: pnls.length,
      },
      behavior: {
        avgTradesPerHour,
        explorationRate: 0, // Filled by caller
        strategyDistribution: stratDist,
        modeDistribution: modeDist,
      },
      alerts: this.alerts.slice(-10),
      equityCurve: this.equityHistory.slice(-100),
      drawdownCurve: this.drawdownHistory.slice(-100),
      sharpeCurve: this.sharpeHistory.slice(-100),
    };
  }

  /**
   * Format report as readable text.
   */
  formatReport(report: DashboardReport): string {
    const p = report.performance;
    const b = report.behavior;
    const lines = [
      '═══ PERFORMANCE DASHBOARD ═══',
      '',
      `Sharpe (7d): ${p.sharpe7d.toFixed(2)} | (30d): ${p.sharpe30d.toFixed(2)}`,
      `Win Rate: ${(p.winRate * 100).toFixed(1)}% | Stability: ${(p.winRateStability * 100).toFixed(0)}%`,
      `EV: ${p.ev.toFixed(2)} | PF: ${p.profitFactor.toFixed(2)}`,
      `PnL: $${p.totalPnl.toFixed(2)} over ${p.totalTrades} trades`,
      `Drawdown: ${(p.currentDrawdownPct * 100).toFixed(1)}% (max ${(p.maxDrawdownPct * 100).toFixed(1)}%)`,
      '',
      `Trades/hr: ${b.avgTradesPerHour.toFixed(1)}`,
      `Strategies: ${Object.entries(b.strategyDistribution).map(([s, v]) => `${s}=${(v * 100).toFixed(0)}%`).join(' ')}`,
      `Modes: ${Object.entries(b.modeDistribution).map(([m, v]) => `${m}=${(v * 100).toFixed(0)}%`).join(' ')}`,
    ];

    if (report.alerts.length > 0) {
      lines.push('', '⚠ ALERTS:');
      for (const a of report.alerts.slice(-5)) {
        lines.push(`  [${a.severity.toUpperCase()}] ${a.message}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get recent audit log.
   */
  getAuditLog(last = 20): AuditEntry[] {
    return this.auditLog.slice(-last);
  }

  // ─── Alerts ────────────────────────────────────────────────────────

  private checkAlerts(currentDD: number): void {
    const now = new Date().toISOString();

    // Drawdown alerts
    if (currentDD >= DRAWDOWN_CRITICAL) {
      this.addAlert({ type: 'drawdown_breach', severity: 'critical', message: `Drawdown ${(currentDD * 100).toFixed(1)}% exceeds critical ${(DRAWDOWN_CRITICAL * 100).toFixed(0)}%`, timestamp: now, value: currentDD, threshold: DRAWDOWN_CRITICAL });
    } else if (currentDD >= DRAWDOWN_WARNING) {
      this.addAlert({ type: 'drawdown_breach', severity: 'warning', message: `Drawdown ${(currentDD * 100).toFixed(1)}% above warning ${(DRAWDOWN_WARNING * 100).toFixed(0)}%`, timestamp: now, value: currentDD, threshold: DRAWDOWN_WARNING });
    }

    // Sharpe alerts
    if (this.recentPnls.length >= 10) {
      const sharpe = this.computeRollingSharpe(this.recentPnls.slice(-20));
      if (sharpe < SHARPE_CRITICAL) {
        this.addAlert({ type: 'sharpe_drop', severity: 'critical', message: `Sharpe ${sharpe.toFixed(2)} below critical ${SHARPE_CRITICAL}`, timestamp: now, value: sharpe, threshold: SHARPE_CRITICAL });
      } else if (sharpe < SHARPE_WARNING) {
        this.addAlert({ type: 'sharpe_drop', severity: 'warning', message: `Sharpe ${sharpe.toFixed(2)} below warning ${SHARPE_WARNING}`, timestamp: now, value: sharpe, threshold: SHARPE_WARNING });
      }
    }

    // Win rate collapse
    if (this.winRateHistory.length >= 5) {
      const recentWR = this.winRateHistory[this.winRateHistory.length - 1];
      if (recentWR < WIN_RATE_WARNING) {
        this.addAlert({ type: 'win_rate_collapse', severity: 'warning', message: `Win rate ${(recentWR * 100).toFixed(0)}% below ${(WIN_RATE_WARNING * 100).toFixed(0)}%`, timestamp: now, value: recentWR, threshold: WIN_RATE_WARNING });
      }
    }
  }

  private addAlert(alert: DegradationAlert): void {
    // Deduplicate: don't spam same alert type within 5 minutes
    const recent = this.alerts.filter((a) => a.type === alert.type && Date.now() - new Date(a.timestamp).getTime() < 300_000);
    if (recent.length === 0) {
      this.alerts.push(alert);
      if (this.alerts.length > 100) this.alerts.shift();
    }
  }

  /**
   * Check if system should auto-halt based on alerts.
   */
  shouldHalt(): { halt: boolean; reason: string } {
    const criticals = this.alerts.filter((a) => a.severity === 'critical' && Date.now() - new Date(a.timestamp).getTime() < 300_000);
    if (criticals.length >= 2) {
      return { halt: true, reason: `${criticals.length} critical alerts in 5 min: ${criticals.map((a) => a.type).join(', ')}` };
    }
    return { halt: false, reason: '' };
  }

  // ─── Math ──────────────────────────────────────────────────────────

  private computeRollingSharpe(pnls: number[]): number {
    if (pnls.length < 3) return 0;
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const std = this.computeStdDev(pnls);
    return std > 0 ? mean / std : 0;
  }

  private computeStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  reset(): void {
    this.equityHistory = [];
    this.drawdownHistory = [];
    this.sharpeHistory = [];
    this.recentPnls = [];
    this.winRateHistory = [];
    this.auditLog = [];
    this.alerts = [];
    this.strategyCount = {};
    this.modeCount = {};
    this.tradeTimestamps = [];
    this.peakEquity = 0;
  }
}

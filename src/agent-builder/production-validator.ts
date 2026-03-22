// Production Validation Harness — JUDGE, not participant.
// Observes, records, renders verdict. NEVER modifies trading behavior.

export interface TradeLog {
  id: number; timestamp: number; market: string; side: string; strategy: string;
  score: number; confidence: number; ev: number; regime: string;
  expectedPrice: number; actualPrice: number; collateral: number;
  leverage: number; slippageBps: number; feeCostUsd: number; executionMs: number;
  pnl: number; pnlPct: number; netPnl: number; holdingMs: number; exitReason: string;
  won: boolean; rMultiple: number;
}

export interface CoreMetrics {
  realEV: number; sharpe: number; maxDrawdownPct: number; winRate: number;
  profitFactor: number; utilizationPct: number; clampFrequencyPct: number;
  shadowLiveDelta: number;
}

export interface ValidationCheck {
  name: string; value: number; threshold: number;
  operator: '>' | '<' | '>=' | '<=' | 'between'; upperBound?: number;
  pass: boolean; status: 'PASS' | 'FAIL' | 'PENDING';
}

export interface EdgeDiagnosis {
  rootCause: string;
  category: 'signal' | 'execution' | 'sizing' | 'filtering' | 'refinement' | 'none';
  severity: 'critical' | 'major' | 'minor' | 'none';
  evidence: string; recommendation: string;
}

export interface ScalingDecision {
  action: 'scale_up' | 'hold' | 'fix_then_retry' | 'not_ready';
  capitalMultiplier: number; reason: string; confidence: number; blockers: string[];
}

export interface ValidationReport {
  mode: 'active' | 'complete' | 'inactive';
  tradesCompleted: number; tradesRequired: number; progress: number;
  metrics: CoreMetrics; checks: ValidationCheck[];
  allPassing: boolean; failCount: number;
  diagnosis: EdgeDiagnosis; scaling: ScalingDecision;
  verdict: 'EDGE_CONFIRMED' | 'NO_EDGE' | 'INCONCLUSIVE' | 'IN_PROGRESS';
  verdictReason: string;
}

export interface ValidationConfig {
  requiredTrades: number; minimumTrades: number;
  minRealEV: number; minSharpe: number; maxDrawdownPct: number;
  minProfitFactor: number; minUtilizationPct: number; maxUtilizationPct: number;
  maxClampFrequencyPct: number; maxShadowDivergence: number;
}

const MAX_TRADE_LOGS = 500;
const MAX_EQUITY_POINTS = 1000;
const SHARPE_WINDOW = 50;
const DEFAULT_CONFIG: ValidationConfig = {
  requiredTrades: 200, minimumTrades: 100, minRealEV: 0, minSharpe: 0.5,
  maxDrawdownPct: 0.10, minProfitFactor: 1.3, minUtilizationPct: 0.40,
  maxUtilizationPct: 0.70, maxClampFrequencyPct: 0.30, maxShadowDivergence: 0.3,
};

function safe(v: number, fb = 0): number { return Number.isFinite(v) ? v : fb; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, safe(v))); }
function fPct(v: number, d = 1): string { return (safe(v) * 100).toFixed(d) + '%'; }
function fUsd(v: number): string { const n = safe(v); return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function padR(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; }

export class ProductionValidator {
  private config: ValidationConfig;
  private active = false;
  private frozen = false;
  private startedAt = 0;
  private tradeLogs: TradeLog[] = [];
  private equityCurve: number[] = [];
  private nextId = 1;
  private _utilizationPct = 0;
  private _clampFrequencyPct = 0;
  private _shadowLiveDelta = 0;
  private peakEquity = 0;
  private maxDrawdown = 0;

  constructor(config?: Partial<ValidationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Lifecycle ---

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.frozen = true;
    this.startedAt = Date.now();
    this.tradeLogs = []; this.equityCurve = []; this.nextId = 1;
    this._utilizationPct = 0; this._clampFrequencyPct = 0; this._shadowLiveDelta = 0;
    this.peakEquity = 0; this.maxDrawdown = 0;
  }

  deactivate(): void { this.active = false; this.frozen = false; }
  isActive(): boolean { return this.active; }
  isFrozen(): boolean { return this.frozen; }

  // --- Per-Trade Recording ---

  logTradeOpen(p: {
    market: string; side: string; strategy: string; score: number; confidence: number;
    ev: number; regime: string; expectedPrice: number; actualPrice: number;
    collateral: number; leverage: number; slippageBps: number; feeCostUsd: number;
    executionMs: number;
  }): number {
    const id = this.nextId++;
    this.tradeLogs.push({
      id, timestamp: Date.now(), market: p.market, side: p.side, strategy: p.strategy,
      score: safe(p.score), confidence: safe(p.confidence), ev: safe(p.ev), regime: p.regime,
      expectedPrice: safe(p.expectedPrice), actualPrice: safe(p.actualPrice),
      collateral: safe(p.collateral), leverage: safe(p.leverage),
      slippageBps: safe(p.slippageBps), feeCostUsd: safe(p.feeCostUsd),
      executionMs: safe(p.executionMs),
      pnl: 0, pnlPct: 0, netPnl: 0, holdingMs: 0, exitReason: '',
      won: false, rMultiple: 0,
    });
    if (this.tradeLogs.length > MAX_TRADE_LOGS) this.tradeLogs = this.tradeLogs.slice(-MAX_TRADE_LOGS);
    return id;
  }

  logTradeClose(id: number, p: {
    pnl: number; pnlPct: number; netPnl: number; holdingMs: number; exitReason: string;
  }): void {
    const log = this.tradeLogs.find(t => t.id === id);
    if (!log) return;
    log.pnl = safe(p.pnl); log.pnlPct = safe(p.pnlPct); log.netPnl = safe(p.netPnl);
    log.holdingMs = safe(p.holdingMs); log.exitReason = p.exitReason;
    log.won = log.netPnl > 0;
    log.rMultiple = log.collateral > 0 ? safe(log.netPnl / log.collateral) : 0;
    const last = this.equityCurve.length > 0 ? this.equityCurve[this.equityCurve.length - 1] : 0;
    this.pushEquity(last + log.netPnl);
  }

  // --- External Input ---

  recordUtilization(pct: number): void { this._utilizationPct = clamp(pct, 0, 1); }
  recordClampFrequency(pct: number): void { this._clampFrequencyPct = clamp(pct, 0, 1); }
  recordShadowDelta(delta: number): void { this._shadowLiveDelta = safe(delta); }
  recordEquity(equity: number): void { this.pushEquity(safe(equity)); }

  // --- Core Metrics ---

  private closedTrades(): TradeLog[] { return this.tradeLogs.filter(t => t.exitReason !== ''); }

  getMetrics(): CoreMetrics {
    const closed = this.closedTrades();
    const n = closed.length;
    const totalNet = closed.reduce((s, t) => s + t.netPnl, 0);
    const realEV = n > 0 ? safe(totalNet / n) : 0;

    // Sharpe over last SHARPE_WINDOW trades
    const win = closed.slice(-SHARPE_WINDOW);
    let sharpe = 0;
    if (win.length >= 2) {
      const rets = win.map(t => t.netPnl);
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
      sharpe = std > 0 ? safe(mean / std) : 0;
    }

    const wins = closed.filter(t => t.won).length;
    const grossP = closed.filter(t => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0);
    const grossL = Math.abs(closed.filter(t => t.netPnl < 0).reduce((s, t) => s + t.netPnl, 0));

    return {
      realEV, sharpe, maxDrawdownPct: safe(this.maxDrawdown),
      winRate: n > 0 ? safe(wins / n) : 0,
      profitFactor: grossL > 0 ? safe(grossP / grossL) : (grossP > 0 ? 999 : 0),
      utilizationPct: this._utilizationPct,
      clampFrequencyPct: this._clampFrequencyPct,
      shadowLiveDelta: this._shadowLiveDelta,
    };
  }

  // --- Validation Checks ---

  getChecks(): ValidationCheck[] {
    const m = this.getMetrics(), c = this.config;
    const enough = this.closedTrades().length >= c.minimumTrades;
    const mk = (name: string, value: number, threshold: number,
                op: ValidationCheck['operator'], upper?: number): ValidationCheck => {
      let pass = false;
      if (op === '>') pass = value > threshold;
      else if (op === '<') pass = value < threshold;
      else if (op === '>=') pass = value >= threshold;
      else if (op === '<=') pass = value <= threshold;
      else if (op === 'between') pass = value >= threshold && value <= (upper ?? Infinity);
      return { name, value: safe(value), threshold, operator: op, upperBound: upper,
               pass: enough ? pass : false, status: enough ? (pass ? 'PASS' : 'FAIL') : 'PENDING' };
    };
    return [
      mk('Real EV',           m.realEV,                     c.minRealEV,             '>'),
      mk('Sharpe Ratio',      m.sharpe,                     c.minSharpe,             '>='),
      mk('Max Drawdown',      m.maxDrawdownPct,             c.maxDrawdownPct,        '<='),
      mk('Profit Factor',     m.profitFactor,               c.minProfitFactor,       '>='),
      mk('Utilization',       m.utilizationPct,             c.minUtilizationPct,     'between', c.maxUtilizationPct),
      mk('Clamp Frequency',   m.clampFrequencyPct,          c.maxClampFrequencyPct,  '<='),
      mk('Shadow Divergence', Math.abs(m.shadowLiveDelta),  c.maxShadowDivergence,   '<='),
    ];
  }

  isValid(): boolean { return this.getChecks().every(ch => ch.pass); }
  getFailedChecks(): ValidationCheck[] { return this.getChecks().filter(ch => ch.status === 'FAIL'); }

  // --- Diagnosis ---

  diagnose(): EdgeDiagnosis {
    const m = this.getMetrics(), c = this.config, closed = this.closedTrades(), n = closed.length;
    if (n < c.minimumTrades)
      return { rootCause: 'Insufficient data for diagnosis', category: 'none', severity: 'none',
               evidence: `${n}/${c.minimumTrades} trades completed`,
               recommendation: 'Continue running until minimum trade count is reached' };

    if (m.realEV <= 0) {
      const aw = safe(closed.filter(t => t.won).reduce((s, t) => s + t.netPnl, 0) / Math.max(closed.filter(t => t.won).length, 1));
      const al = safe(Math.abs(closed.filter(t => !t.won).reduce((s, t) => s + t.netPnl, 0) / Math.max(closed.filter(t => !t.won).length, 1)));
      return { rootCause: 'Strategy producing negative expectancy', category: 'signal', severity: 'critical',
               evidence: `EV=${fUsd(m.realEV)}, WR=${fPct(m.winRate)}, avgWin=${fUsd(aw)}, avgLoss=${fUsd(al)}`,
               recommendation: 'Re-evaluate signal quality. The strategy does not have positive edge after costs.' };
    }
    if (m.maxDrawdownPct > c.maxDrawdownPct)
      return { rootCause: 'Sizing too aggressive for the edge quality', category: 'sizing', severity: 'major',
               evidence: `Max DD=${fPct(m.maxDrawdownPct)} exceeds ${fPct(c.maxDrawdownPct)} limit`,
               recommendation: 'Reduce position sizes proportionally until drawdown is within tolerance.' };
    if (m.utilizationPct < c.minUtilizationPct)
      return { rootCause: 'Over-filtering prevents capital deployment', category: 'filtering', severity: 'major',
               evidence: `Utilization=${fPct(m.utilizationPct)} below ${fPct(c.minUtilizationPct)} minimum`,
               recommendation: 'Relax entry filters to allow more trades through while maintaining signal quality.' };
    if (m.clampFrequencyPct > c.maxClampFrequencyPct)
      return { rootCause: 'Adaptive systems over-restricting position sizes', category: 'sizing', severity: 'major',
               evidence: `Clamp frequency=${fPct(m.clampFrequencyPct)} exceeds ${fPct(c.maxClampFrequencyPct)} limit`,
               recommendation: 'Widen dynamic sizing bounds or reduce base position size so clamping is less frequent.' };
    if (Math.abs(m.shadowLiveDelta) > c.maxShadowDivergence)
      return { rootCause: 'Recent refinements degraded performance', category: 'refinement', severity: 'major',
               evidence: `Shadow-live Sharpe delta=${m.shadowLiveDelta.toFixed(2)} exceeds +/-${c.maxShadowDivergence}`,
               recommendation: 'Revert recent parameter changes and re-validate from the last known-good configuration.' };

    const grossPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const netPnl = closed.reduce((s, t) => s + t.netPnl, 0);
    const drag = grossPnl > 0 ? safe((grossPnl - netPnl) / grossPnl) : 0;
    if (m.realEV > 0 && drag > 0.3) {
      const fees = closed.reduce((s, t) => s + t.feeCostUsd, 0);
      const slip = closed.reduce((s, t) => s + (t.slippageBps * t.collateral * t.leverage / 10000), 0);
      return { rootCause: 'Execution costs consuming the edge', category: 'execution', severity: 'minor',
               evidence: `Gross EV=${fUsd(grossPnl / n)}, Net EV=${fUsd(m.realEV)}, fees=${fUsd(fees)}, slip=${fUsd(slip)}`,
               recommendation: 'Reduce trade frequency or improve execution (limit orders, better timing, lower-fee venues).' };
    }

    return { rootCause: 'No significant issues detected', category: 'none', severity: 'none',
             evidence: `EV=${fUsd(m.realEV)}, Sharpe=${m.sharpe.toFixed(2)}, PF=${m.profitFactor.toFixed(2)}`,
             recommendation: 'System is performing within all tolerances.' };
  }

  // --- Scaling Decision ---

  getScalingDecision(): ScalingDecision {
    const m = this.getMetrics(), c = this.config;
    const n = this.closedTrades().length;
    const checks = this.getChecks();
    const failed = checks.filter(ch => ch.status === 'FAIL');
    const pending = checks.filter(ch => ch.status === 'PENDING');

    if (n < c.minimumTrades)
      return { action: 'not_ready', capitalMultiplier: 1,
               reason: `Only ${n}/${c.minimumTrades} minimum trades completed`,
               confidence: 0, blockers: [`Need ${c.minimumTrades - n} more trades`] };
    if (failed.length > 0)
      return { action: 'fix_then_retry', capitalMultiplier: 1,
               reason: `${failed.length} validation check(s) failing`, confidence: 0,
               blockers: failed.map(ch => `${ch.name}: ${ch.value.toFixed(3)} ${ch.operator} ${ch.threshold}`) };
    if (pending.length > 0)
      return { action: 'not_ready', capitalMultiplier: 1,
               reason: 'Some checks still pending', confidence: 0,
               blockers: pending.map(ch => ch.name) };
    if (n < c.requiredTrades)
      return { action: 'hold', capitalMultiplier: 1,
               reason: `All checks pass but only ${n}/${c.requiredTrades} trades completed`,
               confidence: safe(n / c.requiredTrades),
               blockers: [`Need ${c.requiredTrades - n} more trades for full validation`] };
    if (m.sharpe >= 1.0 && m.profitFactor >= 2.0 && m.maxDrawdownPct <= c.maxDrawdownPct * 0.5)
      return { action: 'scale_up', capitalMultiplier: 5,
               reason: 'Exceptional edge confirmed — Sharpe >= 1.0, PF >= 2.0, DD well within limit',
               confidence: 0.95, blockers: [] };
    return { action: 'scale_up', capitalMultiplier: 2,
             reason: 'Edge confirmed — all checks passing with sufficient trade count',
             confidence: 0.80, blockers: [] };
  }

  // --- Report ---

  getReport(): ValidationReport {
    const n = this.closedTrades().length, c = this.config;
    const checks = this.getChecks();
    const failed = checks.filter(ch => ch.status === 'FAIL');
    const allPassing = checks.every(ch => ch.pass);

    let mode: ValidationReport['mode'] = 'inactive';
    if (this.active) mode = 'active';
    else if (n >= c.requiredTrades) mode = 'complete';

    let verdict: ValidationReport['verdict'] = 'IN_PROGRESS';
    let verdictReason: string;
    if (n < c.minimumTrades) {
      verdictReason = `${n}/${c.minimumTrades} minimum trades needed before verdict`;
    } else if (allPassing && n >= c.requiredTrades) {
      const m = this.getMetrics();
      verdict = 'EDGE_CONFIRMED';
      verdictReason = `All checks pass after ${n} trades. EV=${fUsd(m.realEV)}, Sharpe=${m.sharpe.toFixed(2)}`;
    } else if (allPassing) {
      verdict = 'INCONCLUSIVE';
      verdictReason = `All checks pass but only ${n}/${c.requiredTrades} trades completed`;
    } else {
      const m = this.getMetrics();
      if (m.realEV <= 0) { verdict = 'NO_EDGE'; verdictReason = `Negative EV (${fUsd(m.realEV)}) after ${n} trades. Strategy does not have edge.`; }
      else { verdict = 'INCONCLUSIVE'; verdictReason = `${failed.length} check(s) failing after ${n} trades: ${failed.map(f => f.name).join(', ')}`; }
    }

    return { mode, tradesCompleted: n, tradesRequired: c.requiredTrades,
             progress: safe(Math.min(100, (n / c.requiredTrades) * 100)),
             metrics: this.getMetrics(), checks, allPassing, failCount: failed.length,
             diagnosis: this.diagnose(), scaling: this.getScalingDecision(),
             verdict, verdictReason };
  }

  formatReport(): string {
    const r = this.getReport(), m = r.metrics, L: string[] = [];
    const bar = this.progressBar(r.progress, 40);

    L.push('', '='.repeat(64), '  PRODUCTION VALIDATION REPORT', '='.repeat(64), '');
    L.push(`  Status:   ${r.mode.toUpperCase()}`);
    L.push(`  Progress: ${bar} ${r.progress.toFixed(0)}%`);
    L.push(`  Trades:   ${r.tradesCompleted} / ${r.tradesRequired}`);
    if (this.startedAt > 0) L.push(`  Elapsed:  ${((Date.now() - this.startedAt) / 3600000).toFixed(1)}h`);

    L.push('', '-'.repeat(64), '  CORE METRICS', '-'.repeat(64));
    L.push(`  Real EV (per trade):  ${fUsd(m.realEV)}`);
    L.push(`  Sharpe Ratio (50t):   ${m.sharpe.toFixed(3)}`);
    L.push(`  Max Drawdown:         ${fPct(m.maxDrawdownPct)}`);
    L.push(`  Win Rate:             ${fPct(m.winRate)}`);
    L.push(`  Profit Factor:        ${m.profitFactor.toFixed(2)}`);
    L.push(`  Utilization:          ${fPct(m.utilizationPct)}`);
    L.push(`  Clamp Frequency:      ${fPct(m.clampFrequencyPct)}`);
    L.push(`  Shadow-Live Delta:    ${m.shadowLiveDelta.toFixed(3)}`);

    L.push('', '-'.repeat(64), '  VALIDATION CHECKS', '-'.repeat(64));
    for (const ch of r.checks) {
      const icon = ch.status === 'PASS' ? '[PASS]' : ch.status === 'FAIL' ? '[FAIL]' : '[----]';
      const op = ch.operator === 'between' ? `${ch.threshold} - ${ch.upperBound}` : `${ch.operator} ${ch.threshold}`;
      L.push(`  ${icon}  ${padR(ch.name, 22)} ${padL(ch.value.toFixed(3), 8)}  (need ${op})`);
    }
    L.push('', `  Result: ${r.allPassing ? 'ALL PASSING' : `${r.failCount} FAILING`}`, '');

    if (r.diagnosis.category !== 'none') {
      L.push('-'.repeat(64), '  DIAGNOSIS', '-'.repeat(64));
      L.push(`  Root Cause:      ${r.diagnosis.rootCause}`);
      L.push(`  Category:        ${r.diagnosis.category.toUpperCase()}`);
      L.push(`  Severity:        ${r.diagnosis.severity.toUpperCase()}`);
      L.push(`  Evidence:        ${r.diagnosis.evidence}`);
      L.push(`  Recommendation:  ${r.diagnosis.recommendation}`, '');
    }

    L.push('-'.repeat(64), '  SCALING DECISION', '-'.repeat(64));
    L.push(`  Action:       ${r.scaling.action.toUpperCase().replace(/_/g, ' ')}`);
    L.push(`  Multiplier:   ${r.scaling.capitalMultiplier}x`);
    L.push(`  Confidence:   ${fPct(r.scaling.confidence)}`);
    L.push(`  Reason:       ${r.scaling.reason}`);
    if (r.scaling.blockers.length > 0) {
      L.push('  Blockers:');
      for (const b of r.scaling.blockers) L.push(`    - ${b}`);
    }

    L.push('', '='.repeat(64));
    L.push(`  VERDICT: ${r.verdict.replace(/_/g, ' ')}`);
    L.push(`  ${r.verdictReason}`);
    L.push('='.repeat(64), '');
    return L.join('\n');
  }

  // --- Utility ---

  getProgress(): { completed: number; required: number; pct: number } {
    const n = this.closedTrades().length;
    return { completed: n, required: this.config.requiredTrades,
             pct: safe(Math.min(100, (n / this.config.requiredTrades) * 100)) };
  }

  getTradeLogs(last?: number): TradeLog[] {
    return (last !== undefined && last > 0) ? this.tradeLogs.slice(-last) : [...this.tradeLogs];
  }

  reset(): void {
    this.active = false; this.frozen = false; this.startedAt = 0;
    this.tradeLogs = []; this.equityCurve = []; this.nextId = 1;
    this._utilizationPct = 0; this._clampFrequencyPct = 0; this._shadowLiveDelta = 0;
    this.peakEquity = 0; this.maxDrawdown = 0;
  }

  // --- Private ---

  private pushEquity(e: number): void {
    this.equityCurve.push(e);
    if (this.equityCurve.length > MAX_EQUITY_POINTS) this.equityCurve = this.equityCurve.slice(-MAX_EQUITY_POINTS);
    if (e > this.peakEquity) this.peakEquity = e;
    if (this.peakEquity > 0) {
      const dd = (this.peakEquity - e) / this.peakEquity;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    }
  }

  private progressBar(v: number, w: number): string {
    const filled = Math.round(clamp(v / 100, 0, 1) * w);
    return '[' + '#'.repeat(filled) + '.'.repeat(w - filled) + ']';
  }
}

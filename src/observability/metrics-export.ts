/**
 * Metrics Export — optional Prometheus, Datadog, and JSON export.
 *
 * Disabled by default. Enable via:
 *   METRICS_EXPORT=json     → JSON dump via CLI command
 *   METRICS_EXPORT=prometheus → Prometheus text format
 *
 * ADDITIVE ONLY — never affects trading execution.
 */

import { getMetrics, MetricSnapshot, HistogramSnapshot, METRIC } from './metrics.js';

// ─── Prometheus Format ───────────────────────────────────────────────────────

/** Export metrics in Prometheus text exposition format. */
export function toPrometheus(): string {
  const snap = getMetrics().snapshot();
  const lines: string[] = [];

  // Counters
  for (const [name, value] of Object.entries(snap.counters)) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }

  // Histograms (exported as summary-style gauges)
  for (const [name, hist] of Object.entries(snap.histograms)) {
    if (hist.count === 0) continue;
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}_count ${hist.count}`);
    lines.push(`${name}_sum ${hist.sum.toFixed(2)}`);
    lines.push(`${name}{quantile="0.5"} ${hist.p50.toFixed(2)}`);
    lines.push(`${name}{quantile="0.95"} ${hist.p95.toFixed(2)}`);
    lines.push(`${name}{quantile="0.99"} ${hist.p99.toFixed(2)}`);
  }

  // Uptime
  lines.push('# TYPE flash_uptime_ms gauge');
  lines.push(`flash_uptime_ms ${snap.uptime_ms}`);

  return lines.join('\n') + '\n';
}

// ─── Datadog Format ──────────────────────────────────────────────────────────

interface DatadogMetric {
  metric: string;
  type: 'count' | 'gauge';
  points: Array<[number, number]>;
  tags?: string[];
}

/** Export metrics in Datadog API format. */
export function toDatadog(tags?: string[]): { series: DatadogMetric[] } {
  const snap = getMetrics().snapshot();
  const now = Math.floor(Date.now() / 1000);
  const series: DatadogMetric[] = [];

  for (const [name, value] of Object.entries(snap.counters)) {
    series.push({
      metric: `flash.${name}`,
      type: 'count',
      points: [[now, value]],
      tags,
    });
  }

  for (const [name, hist] of Object.entries(snap.histograms)) {
    if (hist.count === 0) continue;
    series.push({
      metric: `flash.${name}.avg`,
      type: 'gauge',
      points: [[now, hist.avg]],
      tags,
    });
    series.push({
      metric: `flash.${name}.p95`,
      type: 'gauge',
      points: [[now, hist.p95]],
      tags,
    });
    series.push({
      metric: `flash.${name}.p99`,
      type: 'gauge',
      points: [[now, hist.p99]],
      tags,
    });
  }

  return { series };
}

// ─── JSON Format ─────────────────────────────────────────────────────────────

/** Export metrics as formatted JSON string. */
export function toJSON(pretty = true): string {
  const snap = getMetrics().snapshot();
  return pretty ? JSON.stringify(snap, null, 2) : JSON.stringify(snap);
}

// ─── CLI-Friendly Summary ────────────────────────────────────────────────────

/** Format metrics for CLI display. */
export function formatMetricsSummary(): string {
  const snap = getMetrics().snapshot();
  const lines: string[] = [];

  lines.push('  Operational Metrics');
  lines.push('  ─────────────────────────────');

  // Counters
  const counterOrder = [
    METRIC.TRADE_SUCCESS,
    METRIC.TRADE_FAILURE,
    METRIC.TRADE_OPEN,
    METRIC.TRADE_CLOSE,
    METRIC.CIRCUIT_BREAKER_TRIPS,
    METRIC.KILL_SWITCH_BLOCKS,
    METRIC.EXPOSURE_BLOCKS,
    METRIC.RPC_FAILOVER,
  ];

  for (const name of counterOrder) {
    const value = snap.counters[name] ?? 0;
    if (value > 0 || name === METRIC.TRADE_SUCCESS || name === METRIC.TRADE_FAILURE) {
      const label = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`  ${label}: ${value}`);
    }
  }

  // Histograms
  const histOrder = [METRIC.RPC_LATENCY, METRIC.TX_CONFIRM_TIME];
  for (const name of histOrder) {
    const hist = snap.histograms[name];
    if (hist && hist.count > 0) {
      const label = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`  ${label}: avg=${hist.avg.toFixed(0)}ms p95=${hist.p95.toFixed(0)}ms (n=${hist.count})`);
    }
  }

  const uptimeMin = (snap.uptime_ms / 60000).toFixed(1);
  lines.push(`  Uptime: ${uptimeMin} min`);

  return lines.join('\n');
}

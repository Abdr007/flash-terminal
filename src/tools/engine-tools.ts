/**
 * Execution Engine Tools
 *
 * CLI tools for inspecting and benchmarking the execution engine.
 * Display-only — never modifies trading logic or engine configuration.
 */

import { z } from 'zod';
import chalk from 'chalk';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { theme } from '../cli/theme.js';
import { getEngineRouter, initEngineRouter, type ExecutionEngine } from '../execution/engine-router.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';

// ─── engine status ──────────────────────────────────────────────────────────

export const engineStatusTool: ToolDefinition = {
  name: 'engine_status',
  description: 'Show execution engine configuration',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const router = getEngineRouter();

    const lines = [
      '',
      `  ${theme.accentBold('EXECUTION ENGINE')}`,
      `  ${theme.separator(40)}`,
      '',
    ];

    if (!router) {
      lines.push(`  ${theme.pair('Mode', theme.value('RPC (default)'))}`);
      lines.push(`  ${theme.dim('  Engine router not initialized (simulation mode).')}`);
    } else {
      const engineLabel = router.engine === 'magicblock'
        ? chalk.hex('#FF6B00').bold('MagicBlock')
        : theme.value('RPC');
      lines.push(`  ${theme.pair('Mode', engineLabel)}`);

      if (router.engine === 'magicblock' && router.magicblockEndpoint) {
        lines.push(`  ${theme.pair('Endpoint', theme.dim(router.magicblockEndpoint))}`);

        // Ping test
        try {
          const ping = await router.ping();
          const statusIcon = ping.ok ? chalk.green('✓') : chalk.red('✖');
          const latency = ping.ok ? theme.value(`${ping.latencyMs}ms`) : chalk.red('unreachable');
          lines.push(`  ${theme.pair('Status', `${statusIcon} ${latency}`)}`);
        } catch {
          lines.push(`  ${theme.pair('Status', chalk.red('✖ error'))}`);
        }
      }

      const rpcMgr = getRpcManagerInstance();
      if (rpcMgr) {
        lines.push(`  ${theme.pair('RPC Fallback', theme.dim(rpcMgr.activeEndpoint.label))}`);
      }
    }

    lines.push('');
    lines.push(`  ${theme.dim('Switch engines: engine set magicblock <url> | engine set rpc')}`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── engine benchmark ───────────────────────────────────────────────────────

export const engineBenchmarkTool: ToolDefinition = {
  name: 'engine_benchmark',
  description: 'Benchmark execution engine latency',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const router = getEngineRouter();
    const rpcMgr = getRpcManagerInstance();

    const lines = [
      '',
      `  ${theme.accentBold('ENGINE BENCHMARK')}`,
      `  ${theme.separator(40)}`,
      '',
    ];

    // RPC latency
    let rpcLatency = -1;
    if (rpcMgr) {
      try {
        rpcLatency = await rpcMgr.measureLatency();
        lines.push(`  ${theme.pair('RPC latency', theme.value(`${rpcLatency}ms`))}`);
      } catch {
        lines.push(`  ${theme.pair('RPC latency', chalk.red('error'))}`);
      }
    } else {
      lines.push(`  ${theme.pair('RPC latency', chalk.dim('N/A (simulation mode)'))}`);
    }

    // MagicBlock latency
    let mbLatency = -1;
    if (router && router.engine === 'magicblock') {
      try {
        const ping = await router.ping();
        if (ping.ok) {
          mbLatency = ping.latencyMs;
          lines.push(`  ${theme.pair('MagicBlock latency', theme.accent(`${mbLatency}ms`))}`);
        } else {
          lines.push(`  ${theme.pair('MagicBlock latency', chalk.red('unreachable'))}`);
        }
      } catch {
        lines.push(`  ${theme.pair('MagicBlock latency', chalk.red('error'))}`);
      }
    } else {
      lines.push(`  ${theme.pair('MagicBlock latency', chalk.dim('N/A (not configured)'))}`);
    }

    // Improvement factor
    lines.push('');
    if (rpcLatency > 0 && mbLatency > 0) {
      const factor = rpcLatency / mbLatency;
      const factorColor = factor > 1 ? theme.positive : theme.negative;
      lines.push(`  ${theme.pair('Improvement', factorColor(`${factor.toFixed(1)}x ${factor > 1 ? 'faster' : 'slower'}`))}`);
    } else if (rpcLatency > 0 && mbLatency < 0) {
      lines.push(`  ${theme.dim('  Configure MagicBlock to compare: EXECUTION_ENGINE=magicblock')}`);
    }

    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── engine set ──────────────────────────────────────────────────────────────

export const engineSetTool: ToolDefinition = {
  name: 'engine_set',
  description: 'Switch execution engine at runtime',
  parameters: z.object({
    engine: z.enum(['rpc', 'magicblock']),
    url: z.string().optional(),
  }),
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const engine = params.engine as ExecutionEngine;
    const url = params.url as string | undefined;

    const lines = [''];

    if (engine === 'magicblock') {
      if (!url) {
        lines.push(`  ${chalk.yellow('MagicBlock requires a URL.')}`);
        lines.push('');
        lines.push(`  ${theme.dim('Usage: engine set magicblock <url>')}`);
        lines.push(`  ${theme.dim('Example: engine set magicblock https://rpc.magicblock.xyz')}`);
        lines.push('');
        return { success: false, message: lines.join('\n') };
      }

      try {
        new URL(url);
      } catch {
        lines.push(`  ${chalk.red('Invalid URL:')} ${url}`);
        lines.push('');
        return { success: false, message: lines.join('\n') };
      }

      try {
        const router = initEngineRouter({ engine: 'magicblock', magicblockRpcUrl: url });
        const ping = await router.ping();
        const statusIcon = ping.ok ? chalk.green('✓') : chalk.yellow('⚠');
        const latency = ping.ok ? theme.value(`${ping.latencyMs}ms`) : chalk.yellow('unreachable');

        lines.push(`  ${chalk.green('✓')} Engine switched to ${chalk.hex('#FF6B00').bold('MagicBlock')}`);
        lines.push(`  ${theme.pair('Endpoint', theme.dim(url))}`);
        lines.push(`  ${theme.pair('Ping', `${statusIcon} ${latency}`)}`);

        if (!ping.ok) {
          lines.push('');
          lines.push(`  ${chalk.yellow('  Endpoint unreachable — transactions will fallback to RPC.')}`);
        }
      } catch (err: unknown) {
        lines.push(`  ${chalk.red('Failed to initialize MagicBlock engine.')}`);
        lines.push(`  ${theme.dim(String(err))}`);
        lines.push('');
        return { success: false, message: lines.join('\n') };
      }
    } else {
      initEngineRouter({ engine: 'rpc' });
      lines.push(`  ${chalk.green('✓')} Engine switched to ${theme.value('RPC')}`);
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const allEngineTools: ToolDefinition[] = [
  engineStatusTool,
  engineBenchmarkTool,
  engineSetTool,
];

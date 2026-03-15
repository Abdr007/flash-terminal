/**
 * _example-plugin.ts — Example Flash Terminal Plugin
 *
 * This file demonstrates how to build a plugin for Flash Terminal.
 * It is prefixed with underscore (_) so the plugin loader will NOT
 * auto-load it. To activate it, rename to `example-plugin.ts`.
 *
 * A plugin can:
 *   - Register custom CLI commands (tools)
 *   - Run initialization logic on startup
 *   - Run cleanup logic on shutdown
 *
 * See docs/PLUGIN_API.md for the full API reference.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/index.js';
import type { FlashPlugin } from './plugin-loader.js';

// ─── Plugin State ────────────────────────────────────────────────────────────
// Plugins can maintain their own state between tool invocations.

let initTimestamp: number | null = null;

// ─── Tool Definitions ────────────────────────────────────────────────────────
// Each tool is a ToolDefinition object with a name, description,
// optional Zod parameter schema, and an execute function.

/**
 * Tool: example_hello
 *
 * A simple greeting command that demonstrates:
 * - Accessing ToolContext (simulation mode, wallet address)
 * - Returning a formatted ToolResult
 *
 * CLI usage: The terminal's NLP interpreter or command registry
 * would need to route a command to this tool name.
 */
const helloTool: ToolDefinition = {
  name: 'example_hello',
  description: 'Say hello and show current session info',

  // No parameters needed for this tool — omit the `parameters` field
  // or set it to undefined.

  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const mode = context.simulationMode ? 'Simulation' : 'Live';
    const wallet = context.walletAddress;
    const walletShort = wallet.length > 8
      ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}`
      : wallet;
    const uptime = initTimestamp
      ? `${Math.round((Date.now() - initTimestamp) / 1000)}s`
      : 'unknown';

    const lines = [
      '',
      '  Hello from the example plugin!',
      '',
      `  Mode:       ${mode}`,
      `  Wallet:     ${walletShort}`,
      `  Degen:      ${context.degenMode ? 'Yes' : 'No'}`,
      `  Uptime:     ${uptime}`,
      '',
    ];

    return {
      success: true,
      message: lines.join('\n'),
    };
  },
};

/**
 * Tool: example_info
 *
 * Demonstrates Zod parameter validation. Accepts an optional
 * "verbose" boolean to control output detail.
 *
 * CLI usage example: This would be triggered by whatever command
 * routing you set up for the tool name "example_info".
 */

// Define a Zod schema for the tool's parameters.
// The schema is used for validation before execute() is called.
const InfoParamsSchema = z.object({
  verbose: z.boolean().default(false),
});

const infoTool: ToolDefinition = {
  name: 'example_info',
  description: 'Show plugin information and environment details',

  // The Zod schema is attached here. The tool engine validates
  // incoming params against this schema before calling execute().
  parameters: InfoParamsSchema,

  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const { verbose } = InfoParamsSchema.parse(params);
    const lines = [
      '',
      '  Example Plugin Info',
      '  ───────────────────',
      `  Name:        example-plugin`,
      `  Version:     1.0.0`,
      `  Loaded at:   ${initTimestamp ? new Date(initTimestamp).toISOString() : 'N/A'}`,
      '',
    ];

    // The verbose flag controls whether extra details are shown.
    // This demonstrates how Zod-validated params flow into execute().
    if (verbose) {
      lines.push('  Session Details');
      lines.push('  ───────────────────');
      lines.push(`  Simulation:  ${context.simulationMode}`);
      lines.push(`  Degen mode:  ${context.degenMode}`);
      lines.push(`  Wallet:      ${context.walletAddress}`);
      lines.push(`  Wallet name: ${context.walletName}`);

      // You can access the flash client to read live data.
      // Always wrap client calls in try/catch — they may fail.
      try {
        const balance = context.flashClient.getBalance();
        lines.push(`  Balance:     $${balance.toFixed(2)}`);
      } catch {
        lines.push('  Balance:     unavailable');
      }

      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  },
};

// ─── Plugin Definition ───────────────────────────────────────────────────────
// The plugin object must conform to the FlashPlugin interface.
// Export it as the default export (preferred) or as `export const plugin`.

const examplePlugin: FlashPlugin = {
  // Required: unique name used for logging and duplicate detection.
  name: 'example-plugin',

  // Optional: version string for display purposes.
  version: '1.0.0',

  // Optional: human-readable description.
  description: 'An example plugin demonstrating the Flash Terminal plugin API',

  // tools() returns an array of ToolDefinition objects.
  // These are registered with the ToolRegistry at startup.
  // Important: tool names must NOT collide with core tool names.
  // Core tools are protected by lockCore() — any collision is silently blocked.
  tools: () => [helloTool, infoTool],

  // onInit() is called once after the plugin is loaded and tools are registered.
  // Use it for one-time setup: logging, starting background tasks, etc.
  // The ToolContext is provided so you can inspect the current environment.
  onInit: (context: ToolContext): void => {
    initTimestamp = Date.now();
    // In a real plugin you might use getLogger() from '../utils/logger.js'
    // to log through the structured logging system. For this example,
    // we just record the timestamp.
    //
    // You can check context.simulationMode here to conditionally
    // enable features that only make sense in live or sim mode.
    if (context.simulationMode) {
      // Plugin is running in simulation mode — safe for testing
    }
  },

  // onShutdown() is called when the terminal exits.
  // Clean up any resources: stop intervals, close files, flush buffers.
  onShutdown: (): void => {
    initTimestamp = null;
    // In a real plugin: clearInterval(myTimer), ws.close(), etc.
  },
};

export default examplePlugin;

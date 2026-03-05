import { ToolDefinition, ToolContext, ToolResult } from '../types/index.js';
import { getErrorMessage } from '../utils/retry.js';

/**
 * Tool Registry following the Clawd agent architecture pattern.
 * Tools are registered by name and dispatched by the engine.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        message: `Unknown tool: ${toolName}`,
      };
    }

    try {
      return await tool.execute(params, context);
    } catch (error: unknown) {
      return {
        success: false,
        message: `Tool ${toolName} failed: ${getErrorMessage(error)}`,
      };
    }
  }
}

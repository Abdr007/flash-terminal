/**
 * Diff-Based Terminal Renderer
 *
 * Replaces full-screen redraw with line-level diffing.
 * Only updates rows that changed between frames.
 *
 * Benefits:
 * - No flicker (unchanged lines stay in place)
 * - Lower CPU usage (fewer write syscalls)
 * - Stable cursor positioning
 */

import * as readline from 'readline';

/**
 * TermRenderer maintains frame state and performs diff-based updates.
 */
export class TermRenderer {
  private previousFrame: string[] = [];
  private rendering = false;

  /**
   * Clear the entire screen and reset frame state.
   * Use only for initial render or mode transitions.
   */
  clear(): void {
    process.stdout.write('\x1Bc');
    this.previousFrame = [];
  }

  /**
   * Render a frame using line-level diffing.
   * Only writes lines that differ from the previous frame.
   *
   * @param lines - Array of lines to render (no trailing newlines)
   */
  render(lines: string[]): void {
    if (this.rendering) return;
    this.rendering = true;

    try {
      if (this.previousFrame.length === 0) {
        // First frame — write everything, position cursor at top
        readline.cursorTo(process.stdout, 0, 0);
        readline.clearScreenDown(process.stdout);
        for (let i = 0; i < lines.length; i++) {
          process.stdout.write(lines[i] + '\n');
        }
      } else {
        // Diff render — only update changed lines
        const maxLen = Math.max(lines.length, this.previousFrame.length);

        for (let i = 0; i < maxLen; i++) {
          const newLine = i < lines.length ? lines[i] : '';
          const oldLine = i < this.previousFrame.length ? this.previousFrame[i] : '';

          if (newLine !== oldLine) {
            readline.cursorTo(process.stdout, 0, i);
            readline.clearLine(process.stdout, 0);
            if (newLine) {
              process.stdout.write(newLine);
            }
          }
        }

        // If new frame is shorter, clear remaining old lines
        if (lines.length < this.previousFrame.length) {
          readline.cursorTo(process.stdout, 0, lines.length);
          readline.clearScreenDown(process.stdout);
        }
      }

      this.previousFrame = [...lines];
    } finally {
      this.rendering = false;
    }
  }

  /**
   * Check if a new frame differs from the current frame.
   * Useful for skipping no-op renders.
   */
  hasChanged(lines: string[]): boolean {
    if (lines.length !== this.previousFrame.length) return true;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.previousFrame[i]) return true;
    }
    return false;
  }

  /** Reset renderer state without clearing screen */
  reset(): void {
    this.previousFrame = [];
    this.rendering = false;
  }
}

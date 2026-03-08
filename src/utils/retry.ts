import { getLogger } from './logger.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Extract a rate-limit delay from a 429 error, if present.
 * Checks for Retry-After header value embedded in the error message,
 * or common RPC provider rate-limit patterns.
 * Returns delay in ms, or 0 if not a rate-limit error.
 */
function extractRateLimitDelay(error: Error): number {
  const msg = error.message ?? '';

  // Check for "429" in the error message (HTTP status or fetch error)
  if (!msg.includes('429') && !msg.toLowerCase().includes('rate limit') && !msg.toLowerCase().includes('too many requests')) {
    return 0;
  }

  // Try to extract Retry-After seconds from error message
  const retryAfterMatch = msg.match(/[Rr]etry-?[Aa]fter[:\s]+(\d+)/);
  if (retryAfterMatch) {
    const seconds = parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 300) {
      return seconds * 1000;
    }
  }

  // Default rate-limit backoff: 2 seconds
  return 2000;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };
  const logger = getLogger();

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        // Check for HTTP 429 rate limiting
        const rateLimitDelay = extractRateLimitDelay(lastError);
        let delay: number;

        if (rateLimitDelay > 0) {
          // Use rate-limit specific delay, clamped to maxDelayMs
          delay = Math.min(rateLimitDelay, maxDelayMs);
          logger.info('RETRY', `${label} rate limited (429), waiting ${Math.round(delay)}ms before retry ${attempt + 1}/${maxAttempts}`);
        } else {
          // Standard exponential backoff with jitter, clamped to maxDelayMs
          const exponential = baseDelayMs * 2 ** (attempt - 1);
          const jitter = Math.random() * baseDelayMs * 0.5;
          delay = Math.min(exponential + jitter, maxDelayMs);
          logger.info('RETRY', `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms`, {
            error: lastError.message,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('RETRY', `${label} failed after ${maxAttempts} attempts`, {
    error: lastError?.message ?? 'unknown',
  });
  throw lastError;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

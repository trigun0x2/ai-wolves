import { sleep } from "../engine/util";

/** Retry transient failures (429, 5xx, network); rethrow other 4xx immediately. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i + Math.random() * 500);
    }
  }
  throw lastErr;
}

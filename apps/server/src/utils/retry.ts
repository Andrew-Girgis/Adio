export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(task: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      const retryable = options.shouldRetry ? options.shouldRetry(error) : true;
      if (!retryable || attempt >= options.retries) {
        throw error;
      }

      const delay = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
      await sleep(delay);
      attempt += 1;
    }
  }
}

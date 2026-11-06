export interface ArkivRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function isTransientArkivError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (typeof current !== "object") return false;
    const candidate = current as { status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
    if (typeof status === "number" && (status === 429 || (status >= 500 && status <= 599))) return true;
    if (typeof candidate.message === "string" && /\b429\b|\b5\d{2}\b|timed?\s*out|timeout|econnreset|econnrefused|fetch failed|network error/i.test(candidate.message)) return true;
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
    current = candidate.cause;
  }
  return false;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Retry only transient Arkiv/RPC failures, with a fixed attempt cap and exponential backoff. */
export async function withArkivReadRetry<T>(
  operation: () => Promise<T>,
  { attempts = 3, baseDelayMs = 200, sleep: wait = sleep }: ArkivRetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientArkivError(error)) throw error;
      await wait(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

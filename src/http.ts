import { BusinessGatewayConnectionError, BusinessGatewayError, type ApiErrorBody } from "./errors.js";

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  /** Attempts after the first for a request that may be repeated. */
  maxRetries: number;
  timeoutMs: number;
  /** Waits between attempts; replaced in tests. */
  sleep: (ms: number) => Promise<void>;
}

export interface Call {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** Read the answer as text rather than JSON (the document payload). */
  text?: boolean;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * A request may be sent again only when doing so cannot do twice what it did
 * once: a read, or a write carrying an Idempotency-Key. Anything else is
 * tried once, and its failure is the caller's to judge.
 */
function repeatable(call: Call): boolean {
  return call.method === "GET" || call.idempotencyKey !== undefined;
}

export class Transport {
  constructor(private readonly o: TransportOptions) {}

  async request<T>(call: Call): Promise<T> {
    const url = new URL(this.o.baseUrl.replace(/\/+$/, "") + call.path);
    for (const [k, v] of Object.entries(call.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { "X-API-Key": this.o.apiKey, Accept: call.text ? "*/*" : "application/json" };
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey) headers["Idempotency-Key"] = call.idempotencyKey;
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.o.fetch(url, {
          method: call.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (err) {
        // No answer: the request may or may not have arrived. Only a
        // repeatable one is sent again.
        if (repeatable(call) && attempt < this.o.maxRetries) {
          await this.o.sleep(backoff(attempt));
          continue;
        }
        throw new BusinessGatewayConnectionError(`${call.method} ${call.path}: ${describe(err)}`, { cause: err });
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (call.text ? await res.text() : await res.json()) as T;
      }
      const error = await readError(res);
      // 429 is refused before anything is done, so any request may be
      // repeated; any other retryable error only when repeating is safe.
      const again = error.retryable && (res.status === 429 || repeatable(call)) && attempt < this.o.maxRetries;
      if (!again) throw new BusinessGatewayError(res.status, error);
      await this.o.sleep(retryAfter(res) ?? backoff(attempt));
    }
  }
}

async function readError(res: Response): Promise<ApiErrorBody> {
  const fallback: ApiErrorBody = {
    code: `HTTP_${res.status}`,
    message: res.statusText || "request failed",
    retryable: res.status === 429 || (res.status >= 500 && res.status !== 501),
    requestId: res.headers.get("X-Request-Id") ?? undefined,
  };
  try {
    const parsed = (await res.json()) as { error?: Partial<ApiErrorBody> };
    const e = parsed?.error;
    if (!e || typeof e.code !== "string") return fallback;
    return {
      code: e.code,
      message: e.message ?? fallback.message,
      retryable: typeof e.retryable === "boolean" ? e.retryable : fallback.retryable,
      requestId: e.requestId ?? fallback.requestId,
    };
  } catch {
    return fallback;
  }
}

/** Retry-After in seconds, capped so a misconfigured proxy cannot park the caller. */
function retryAfter(res: Response): number | undefined {
  const v = res.headers.get("Retry-After");
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_BACKOFF_MS);
  return undefined;
}

/** Exponential with full jitter: 0.5 s, 1 s, 2 s … ceilings, at most 30 s. */
function backoff(attempt: number): number {
  const ceiling = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(Math.random() * ceiling);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "timed out" : err.message;
  return String(err);
}

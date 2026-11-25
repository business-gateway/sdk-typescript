import {
  BusinessGatewayConnectionError,
  BusinessGatewayError,
  BusinessGatewayRateLimitError,
  type ApiErrorBody,
  type RateLimit,
  type ResponseMeta,
} from "./errors.js";

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  /** Attempts after the first for a request that may be repeated. */
  maxRetries: number;
  timeoutMs: number;
  /** Waits between attempts; replaced in tests. */
  sleep: (ms: number) => Promise<void>;
  /** Told about every answer, each attempt's, errors included. */
  onResponse?: (meta: ResponseMeta) => void;
}

export interface Call {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** A POST that stores and sends nothing (validate, a dry run), so may be repeated like a read. */
  safe?: boolean;
  /** Read the answer as text rather than JSON (the document payload). */
  text?: boolean;
  /** Added to the client's timeout, for a call the server holds on purpose (?wait=). */
  extraTimeoutMs?: number;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * The longest Retry-After the client sits out itself. The API's limits are
 * per minute, so it never asks for more; a longer one (a proxy, a
 * maintenance window) is thrown at once as the caller's to schedule, rather
 * than waited out short and refused again.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * A request may be sent again only when doing so cannot do twice what it did
 * once: a read, a write that changes nothing, or a write carrying an
 * Idempotency-Key. Anything else is tried once, 429 included, and its failure
 * is the caller's to judge.
 */
function repeatable(call: Call): boolean {
  return call.method === "GET" || call.safe === true || call.idempotencyKey !== undefined;
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
          signal: AbortSignal.timeout(this.o.timeoutMs + (call.extraTimeoutMs ?? 0)),
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
      const rateLimit = readRateLimit(res.headers);
      this.notify(call, res, rateLimit);
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (call.text ? await res.text() : await res.json()) as T;
      }
      const error = await readError(res);
      const wait = retryAfterSeconds(res.headers);
      const again =
        error.retryable &&
        repeatable(call) &&
        attempt < this.o.maxRetries &&
        (wait === undefined || wait * 1000 <= MAX_RETRY_AFTER_MS);
      if (!again) {
        if (res.status === 429) throw new BusinessGatewayRateLimitError(error, wait, rateLimit);
        throw new BusinessGatewayError(res.status, error, rateLimit);
      }
      await this.o.sleep(wait !== undefined ? wait * 1000 : backoff(attempt));
    }
  }

  private notify(call: Call, res: Response, rateLimit: RateLimit | undefined): void {
    if (!this.o.onResponse) return;
    const meta: ResponseMeta = { method: call.method, path: call.path, status: res.status };
    const requestId = res.headers.get("X-Request-Id");
    if (requestId) meta.requestId = requestId;
    if (rateLimit) meta.rateLimit = rateLimit;
    try {
      this.o.onResponse(meta);
    } catch {
      // An observer's failure must not turn an answered request (a send
      // that went out) into an error the caller would retry.
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

/** The RateLimit-* headers, when all three are there and are numbers. */
export function readRateLimit(h: Headers): RateLimit | undefined {
  const limit = whole(h.get("RateLimit-Limit"));
  const remaining = whole(h.get("RateLimit-Remaining"));
  const resetSeconds = whole(h.get("RateLimit-Reset"));
  if (limit === undefined || remaining === undefined || resetSeconds === undefined) return undefined;
  return { limit, remaining, resetSeconds };
}

/**
 * Retry-After in whole seconds, rounded up so waiting it is never early:
 * delay-seconds as the API sends it, or an HTTP date as a proxy may.
 */
export function retryAfterSeconds(h: Headers, now: number = Date.now()): number | undefined {
  const v = h.get("Retry-After")?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v));
  // Date.parse reads "-1" as a year, so only a value naming a day or month is a date.
  const at = /[a-z]/i.test(v) ? Date.parse(v) : NaN;
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function whole(v: string | null): number | undefined {
  if (v === null || !/^\s*\d+\s*$/.test(v)) return undefined;
  return Number(v);
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

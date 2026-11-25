/** The `error` object every non-2xx answer carries. */
export interface ApiErrorBody {
  code: string;
  message: string;
  /** Whether the same request may succeed later. The client already retried it if so. */
  retryable: boolean;
  /** Quote this to support. */
  requestId?: string;
}

/**
 * The RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers of an
 * answer. The API sends them on the calls that have a per-account limit
 * (validate and dry runs share 120 a minute), on success as on 429.
 */
export interface RateLimit {
  /** Calls allowed in the window. */
  limit: number;
  /** Calls left in the window, this one counted. */
  remaining: number;
  /** Seconds until a call is freed: the oldest in the window leaves it. */
  resetSeconds: number;
}

/** What the client saw of one HTTP answer, whatever its status. */
export interface ResponseMeta {
  method: string;
  path: string;
  status: number;
  /** X-Request-Id: quote it to support. */
  requestId?: string;
  /** Only on answers that carry the RateLimit-* headers. */
  rateLimit?: RateLimit;
}

/** A request the API answered with an error. */
export class BusinessGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  /** The RateLimit-* headers of the answer, when it carried them. */
  readonly rateLimit?: RateLimit;

  constructor(status: number, body: ApiErrorBody, rateLimit?: RateLimit) {
    super(`${body.code}: ${body.message}`);
    this.name = "BusinessGatewayError";
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.requestId = body.requestId;
    if (rateLimit) this.rateLimit = rateLimit;
  }
}

/**
 * A 429: over a limit, which passes. Thrown once the client's own retries are
 * spent, or at once for a request it may not repeat or a wait longer than it
 * sits out for you. Wait `retryAfter` seconds and send it again.
 */
export class BusinessGatewayRateLimitError extends BusinessGatewayError {
  /** Seconds to wait, from Retry-After; undefined when the answer gave none. */
  readonly retryAfter?: number;

  constructor(body: ApiErrorBody, retryAfter?: number, rateLimit?: RateLimit) {
    super(429, body, rateLimit);
    this.name = "BusinessGatewayRateLimitError";
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** The request never got an answer: network failure or timeout. */
export class BusinessGatewayConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BusinessGatewayConnectionError";
  }
}

/** A webhook call whose signature or timestamp does not check out. Answer it with 400 or 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

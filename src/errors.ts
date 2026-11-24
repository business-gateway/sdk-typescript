/** The `error` object every non-2xx answer carries. */
export interface ApiErrorBody {
  code: string;
  message: string;
  /** Whether the same request may succeed later. The client already retried it if so. */
  retryable: boolean;
  /** Quote this to support. */
  requestId?: string;
}

/** A request the API answered with an error. */
export class BusinessGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = "BusinessGatewayError";
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.requestId = body.requestId;
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

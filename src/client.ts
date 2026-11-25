import { BusinessGatewayError, type ResponseMeta } from "./errors.js";
import { Transport, type TransportOptions } from "./http.js";
import type {
  DryRunResult,
  EventPage,
  FeedEvent,
  ListEventsParams,
  ListMessagesParams,
  Message,
  Page,
  Ruleset,
  Upload,
  SendInput,
  ValidateInput,
  ValidateResult,
} from "./types.js";

export interface ClientOptions {
  /** An API key from Settings → API keys. */
  apiKey: string;
  /** Defaults to https://api.businessgateway.se. */
  baseUrl?: string;
  /** Retries of a request that is safe to repeat; default 3. */
  maxRetries?: number;
  /** Per attempt; default 30 s. */
  timeoutMs?: number;
  /** A fetch implementation; defaults to the global one. */
  fetch?: typeof fetch;
  /**
   * Called with every answer the API gives, each retry's included: status,
   * request id and, where the call has a limit, its RateLimit-* headers. Use
   * it rather than `lastResponse` when calls run concurrently.
   */
  onResponse?: (meta: ResponseMeta) => void;
}

/**
 * Documents at or under this many bytes go inline in the JSON body; larger
 * ones are staged with POST /v1/messages/uploads first. The API's JSON body
 * limit is 1 MiB and escaping can grow a document, so the line is drawn well
 * below it.
 */
export const INLINE_MAX_BYTES = 512 * 1024;

export class BusinessGateway {
  readonly messages: Messages;
  readonly events: Events;
  private readonly t: Transport;
  private readonly fetchImpl: typeof fetch;
  private last?: ResponseMeta;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) throw new Error("BusinessGateway: apiKey is required");
    const onResponse = options.onResponse;
    const opts: TransportOptions = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.businessgateway.se",
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onResponse: (meta) => {
        this.last = meta;
        onResponse?.(meta);
      },
    };
    this.fetchImpl = opts.fetch;
    this.t = new Transport(opts);
    this.messages = new Messages(this.t, this.fetchImpl);
    this.events = new Events(this.t);
  }

  /**
   * The latest answer this client received, from whichever call: undefined
   * before the first. `lastResponse.rateLimit` after `validate()` tells how
   * many calls are left this minute. With calls in flight concurrently it is
   * whichever answered last; use `onResponse` then.
   */
  get lastResponse(): ResponseMeta | undefined {
    return this.last;
  }

  /**
   * Runs a document through the validation a send gets and answers every
   * finding, warnings included. Nothing is stored or sent. `ruleset` checks
   * against one named Peppol release instead of the one in force.
   */
  async validate(input: ValidateInput, options: { ruleset?: string } = {}): Promise<ValidateResult> {
    const bytes = await toBytes(input.payload);
    const body: Record<string, unknown> = {
      type: input.type,
      documentTypeId: input.documentTypeId,
      processId: input.processId,
    };
    if (bytes.byteLength > INLINE_MAX_BYTES) {
      body.payloadObjectKey = await stage(this.t, this.fetchImpl, bytes, input.sender, input.companyId);
      body.sender = input.sender;
      body.companyId = input.companyId;
    } else {
      body.payload = new TextDecoder().decode(bytes);
    }
    return this.t.request<ValidateResult>({
      method: "POST",
      path: "/v1/validate",
      query: { ruleset: options.ruleset },
      body: compact(body),
      safe: true,
    });
  }

  /** The Peppol validation releases in force and scheduled, oldest first. */
  async rulesets(): Promise<Ruleset[]> {
    const res = await this.t.request<{ rulesets: Ruleset[] }>({ method: "GET", path: "/v1/validation/rulesets" });
    return res.rulesets;
  }
}

/** The most POST /v1/messages?wait= takes. */
const MAX_WAIT_SECONDS = 30;

class Messages {
  constructor(
    private readonly t: Transport,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Sends a document. The answer is usually status QUEUED_VALIDATION: the
   * Peppol validation runs after the call returns, so follow the message with
   * get(), a webhook or the event feed. A retried call — by this client or by
   * you with the same idempotencyKey — returns the message the first one
   * created instead of sending twice.
   *
   * With `wait` (seconds, at most 30) the answer is held until the
   * validation is decided, and carries that status; if the time runs out it
   * is QUEUED_VALIDATION as without it. The request timeout grows by the wait.
   */
  async send(input: SendInput): Promise<Message> {
    const wait = input.wait;
    if (wait !== undefined && (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS)) {
      throw new RangeError(`wait must be whole seconds from 0 to ${MAX_WAIT_SECONDS}`);
    }
    const body = await this.body(input);
    return this.t.request<Message>({
      method: "POST",
      path: "/v1/messages",
      query: { wait: wait || undefined },
      body,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      extraTimeoutMs: (wait ?? 0) * 1000,
    });
  }

  /** Every check send() makes and the validation, inline, with nothing stored or sent. */
  async dryRun(input: Omit<SendInput, "idempotencyKey" | "wait">): Promise<DryRunResult> {
    const body = await this.body(input);
    return this.t.request<DryRunResult>({ method: "POST", path: "/v1/messages", query: { dryRun: true }, body, safe: true });
  }

  async get(id: string): Promise<Message> {
    return this.t.request<Message>({ method: "GET", path: `/v1/messages/${encodeURIComponent(id)}` });
  }

  /** The business document as stored, whatever its size. */
  async payload(id: string): Promise<string> {
    return this.t.request<string>({ method: "GET", path: `/v1/messages/${encodeURIComponent(id)}/payload`, text: true });
  }

  /** Marks an inbound message as collected; it leaves the delivery=pending list. */
  async ack(id: string): Promise<Message> {
    return this.t.request<Message>({ method: "POST", path: `/v1/messages/${encodeURIComponent(id)}/ack` });
  }

  /** One page, newest first. */
  async list(params: ListMessagesParams = {}): Promise<Page<Message>> {
    const res = await this.t.request<{ messages: Message[]; nextCursor?: string }>({
      method: "GET",
      path: "/v1/messages",
      query: { ...params },
    });
    return { items: res.messages ?? [], nextCursor: res.nextCursor };
  }

  /** Every matching message, page by page. */
  async *listAll(params: Omit<ListMessagesParams, "cursor"> = {}): AsyncGenerator<Message> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor);
  }

  private async body(input: Omit<SendInput, "idempotencyKey">): Promise<Record<string, unknown>> {
    if (!input?.sender) throw new Error("sender is required");
    const bytes = await toBytes(input.payload);
    const body: Record<string, unknown> = {
      sender: input.sender,
      receiver: input.receiver,
      type: input.type,
      documentTypeId: input.documentTypeId,
      processId: input.processId,
      externalReference: input.externalReference,
      metadata: input.metadata,
    };
    if (bytes.byteLength > INLINE_MAX_BYTES) {
      body.payloadObjectKey = await stage(this.t, this.fetchImpl, bytes, input.sender);
    } else {
      body.payload = new TextDecoder().decode(bytes);
    }
    return compact(body);
  }
}

class Events {
  constructor(private readonly t: Transport) {}

  /**
   * One page of the event feed, oldest first: every event a webhook would
   * carry, kept 30 days. Store nextCursor and pass it as `cursor` next time.
   * An event appears about ten seconds after it happens.
   */
  async list(params: ListEventsParams = {}): Promise<EventPage> {
    const res = await this.t.request<{ events?: FeedEvent[]; nextCursor: string }>({
      method: "GET",
      path: "/v1/events",
      query: { ...params },
    });
    return { events: res.events ?? [], nextCursor: res.nextCursor };
  }
}


/**
 * Stages a document too large to send inline and answers its key. The upload
 * is filed under the sender's company. The URL is signed over the headers and
 * the length, so the PUT carries exactly those.
 */
async function stage(t: Transport, fetchImpl: typeof fetch, bytes: Uint8Array, sender?: string, companyId?: string): Promise<string> {
  const grant = await t.request<Upload>({
    method: "POST",
    path: "/v1/messages/uploads",
    body: compact({ bytes: bytes.byteLength, sender, companyId }),
  });
  // A copy, so the body is backed by a plain ArrayBuffer whatever the caller
  // passed (a Buffer slice of a pool, a SharedArrayBuffer view).
  const res = await fetchImpl(grant.uploadUrl, { method: "PUT", headers: grant.headers, body: new Uint8Array(bytes) });
  if (!res.ok) {
    throw new BusinessGatewayError(res.status, {
      code: "UPLOAD_FAILED",
      message: `the object store refused the upload (${res.status})`,
      retryable: res.status >= 500,
    });
  }
  return grant.payloadObjectKey;
}

async function toBytes(payload: string | Uint8Array | Blob): Promise<Uint8Array> {
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (typeof Blob !== "undefined" && payload instanceof Blob) return new Uint8Array(await payload.arrayBuffer());
  throw new TypeError("payload must be a string, Uint8Array or Blob");
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

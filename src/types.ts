// The API's JSON shapes, written from the platform's own response structs
// (internal/http/public, internal/webhook). The OpenAPI document names its
// routes, parameters and errors but describes most bodies only as "object",
// so these are kept by hand; test/openapi-paths.test.ts checks every route the
// client calls against it. Fields are optional where the API omits them.

/** A Peppol participant id as `scheme:value`, e.g. `0007:5561234567`. */
export type PeppolId = string;

export type Direction = "OUTBOUND" | "INBOUND";

/** One finding from validation. `layer` "schema" means XSD failed and Schematron did not run. */
export interface Finding {
  severity: "fatal" | "error" | "warning" | (string & {});
  rule?: string;
  location?: string;
  message: string;
  layer?: "schema" | "schematron";
  /** How many identical findings this one stands for; absent means one. */
  count?: number;
}

/** The Peppol rules a message was validated under, and the forecast against the next release. */
export interface MessageValidation {
  /** The Peppol release, e.g. "2026.5" (May 2026). */
  ruleset: string;
  vesid: string;
  validatedAt: string;
  upcoming?: UpcomingValidation;
}

/** A check against the Peppol release that takes effect at `effectiveFrom`. It never changes a status. */
export interface UpcomingValidation {
  ruleset: string;
  vesid?: string;
  effectiveFrom: string;
  valid: boolean;
  findings: Finding[];
}

export interface MLSIssue {
  location: string;
  reasonCode: string;
  description?: string;
}

export interface MLSEvent {
  id: string;
  status: string;
  direction: Direction;
  lastError?: string;
  createdAt: string;
  responseCode?: "AP" | "AB" | "RE" | (string & {});
  description?: string;
  reasons?: string[];
  issues?: MLSIssue[];
  receivedAt?: string;
}

export interface Message {
  id: string;
  accountId?: string;
  companyId?: string;
  companyName?: string;
  accountName?: string;
  direction: Direction;
  sender: PeppolId;
  receiver: PeppolId;
  documentTypeId: string;
  processId: string;
  /** The document type alias, e.g. "invoice". */
  type?: string;
  documentNumber?: string;
  issueDate?: string;
  externalReference?: string;
  metadata?: Record<string, string>;
  payloadSha256: string;
  payloadBytes: number;
  /** The document itself, on a single-message fetch when it is small enough to inline. */
  payload?: string;
  status: string;
  as4MessageId?: string;
  sbdhInstanceId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  /** A SEND_FAILED message the receiver may have anyway. Never resend it. */
  deliveryUnconfirmed?: boolean;
  queuedAt?: string;
  sentAt?: string;
  as4AcceptedAt?: string;
  receivedAt?: string;
  deliveredToCustomerAt?: string;
  validationErrors?: Finding[];
  validation?: MessageValidation;
  mlsEvents?: MLSEvent[];
  recipientStatus?: "CONFIRMED" | "DELIVERED" | "REJECTED" | (string & {});
  recipientStatusReasons?: string[];
  createdAt: string;
}

/** What to send. Only `sender` and `payload` are required; the rest is read off the document when left out. */
export interface SendInput {
  sender: PeppolId;
  receiver?: PeppolId;
  /** A document type alias from GET /v1/document-types, e.g. "invoice". */
  type?: string;
  documentTypeId?: string;
  processId?: string;
  /** The business document, UBL XML. Larger documents are staged through an upload automatically. */
  payload: string | Uint8Array | Blob;
  /** Your own reference, returned on the message and its webhooks. */
  externalReference?: string;
  metadata?: Record<string, string>;
  /**
   * Makes a retried send safe: the same key within 24 hours answers with the
   * message it created instead of sending again. Generated when left out.
   */
  idempotencyKey?: string;
}

/** The answer to a dry run: what the send would do, with nothing stored or sent. */
export interface DryRunResult {
  dryRun: true;
  companyId: string;
  sender: PeppolId;
  receiver: PeppolId;
  type?: string;
  documentTypeId: string;
  processId: string;
  validated: boolean;
  /** null for a type with no rules that its capability lets go unvalidated. */
  valid: boolean | null;
  findings: Finding[];
  ruleset?: string;
  vesid?: string;
  upcoming?: UpcomingValidation;
}

export interface ValidateInput {
  payload: string | Uint8Array | Blob;
  type?: string;
  documentTypeId?: string;
  processId?: string;
  /** Needed only for a document large enough to be staged, when the key reaches several companies. */
  sender?: PeppolId;
  companyId?: string;
}

export interface ValidateResult {
  valid: boolean;
  documentTypeId: string;
  processId: string;
  type?: string;
  findings: Finding[];
  ruleset?: string;
  vesid?: string;
  upcoming?: UpcomingValidation;
}

export interface ListMessagesParams {
  direction?: Direction;
  status?: string;
  /** "pending": inbound messages not yet collected. */
  delivery?: "pending";
  companyId?: string;
  externalReference?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; absent on the last one. */
  nextCursor?: string;
}

/** The body of a webhook call and of an event-feed entry. */
export interface WebhookEvent {
  id: string;
  type:
    | "message.outbound.as4_accepted"
    | "message.outbound.failed"
    | "message.outbound.ruleset_warning"
    | "message.inbound.received"
    | "message.inbound.validation_failed"
    | "message.mls"
    | (string & {});
  accountId?: string;
  companyId?: string;
  documentId: string;
  status: string;
  unvalidated?: boolean;
  externalReference?: string;
  metadata?: Record<string, string>;
  // message.mls
  mlsEventId?: string;
  responseCode?: string;
  reasons?: string[];
  issues?: MLSIssue[];
  // message.outbound.ruleset_warning
  ruleset?: string;
  effectiveFrom?: string;
  rules?: string[];
}

export interface FeedEvent extends WebhookEvent {
  createdAt: string;
}

export interface ListEventsParams {
  /** The cursor from the previous page. Without it the feed starts at its oldest event (30 days back). */
  after?: string;
  companyId?: string;
  type?: WebhookEvent["type"];
  limit?: number;
}

export interface EventPage {
  events: FeedEvent[];
  /** Always set: store it and pass it as `after` next time, even when `events` is empty. */
  nextCursor: string;
}

export interface Ruleset {
  name: string;
  title: string;
  effectiveFrom?: string;
  status: "in_force" | "scheduled" | (string & {});
}

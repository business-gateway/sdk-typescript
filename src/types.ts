// The API's JSON shapes. Response types are aliases of the schemas the
// platform publishes in its OpenAPI document (src/generated/openapi.ts, made
// from spec/openapi.json by `npm run generate`), which the platform derives
// from the very structs its handlers encode — so a field added there reaches
// these types on the next sync, and CI fails if the generated file is stale.
// The aliases only narrow plain strings to the values the API documents
// (direction, event types, statuses), keeping room for values added later.
// Request types are written here: the document describes request bodies only
// in prose.

import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

/**
 * Narrows some properties of T, keeping the rest. R may name only T's
 * properties, each with a type T's accepts, so a field renamed or retyped in
 * the API breaks the build here instead of reappearing under its old name.
 */
type Refine<T, R extends { [K in keyof R]: K extends keyof T ? T[K] : never }> = Omit<T, keyof R> & R;

/** A Peppol participant id as `scheme:value`, e.g. `0007:5561234567`. */
export type PeppolId = string;

export type Direction = "OUTBOUND" | "INBOUND";

export type EventType =
  | "message.outbound.as4_accepted"
  | "message.outbound.failed"
  | "message.outbound.ruleset_warning"
  | "message.inbound.received"
  | "message.inbound.validation_failed"
  | "message.mls"
  | (string & {});

/** One finding from validation, as /v1/validate and the dry run answer it. */
export type Finding = Refine<Schemas["Finding"], {
  severity: "fatal" | "error" | "warning" | (string & {});
  layer?: "schema" | "schematron" | (string & {});
}>;

/** A stored finding on a message: grouped, with how many times it occurred. */
export type ValidationError = Refine<Schemas["ValidationError"], {
  severity: "fatal" | "error" | "warning" | (string & {});
}>;

/** A document checked inline against the Peppol release taking effect at `effectiveFrom`. */
export type UpcomingCheck = Refine<Schemas["UpcomingCheck"], { findings: Finding[] }>;

/** A message's stored check against the next release. It never changes the message's status. */
export type UpcomingValidation = Refine<Schemas["MessageUpcomingValidation"], { findings: ValidationError[] }>;

/** The Peppol rules a message was validated under. */
export type MessageValidation = Refine<Schemas["MessageValidation"], { upcoming?: UpcomingValidation }>;

export type MLSIssue = Schemas["MLSIssue"];

export type MLSEvent = Refine<Schemas["MLSEvent"], {
  direction: Direction;
  responseCode?: "AP" | "AB" | "RE" | (string & {});
}>;

export type Message = Refine<Schemas["Message"], {
  direction: Direction;
  validationErrors?: ValidationError[];
  validation?: MessageValidation;
  mlsEvents?: MLSEvent[];
  recipientStatus?: "CONFIRMED" | "DELIVERED" | "REJECTED" | (string & {});
}>;

/** The answer to a dry run: what the send would do, with nothing stored or sent. */
export type DryRunResult = Refine<Schemas["DryRun"], {
  dryRun: true;
  findings: Finding[];
  upcoming?: UpcomingCheck;
}>;

export type ValidateResult = Refine<Schemas["ValidationResult"], {
  findings: Finding[];
  upcoming?: UpcomingCheck;
}>;

/** The body of a webhook call. */
export type WebhookEvent = Refine<Schemas["WebhookEvent"], { type: EventType }>;

/** An event-feed entry: the webhook body plus when it was raised. */
export type FeedEvent = Refine<Schemas["Event"], { type: EventType }>;

export type EventPage = Refine<Schemas["EventPage"], { events: FeedEvent[] }>;

export type Ruleset = Refine<Schemas["Ruleset"], { status: "in_force" | "scheduled" | (string & {}) }>;

export type Upload = Schemas["Upload"];

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
  /**
   * Seconds, at most 30, to hold the answer for the Peppol validation
   * verdict instead of answering QUEUED_VALIDATION at once.
   */
  wait?: number;
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

export interface ListEventsParams {
  /** The cursor from the previous page. Without it the feed starts at its oldest event (30 days back). */
  cursor?: string;
  /** @deprecated Use `cursor`. The API still accepts it as an alias. */
  after?: string;
  companyId?: string;
  type?: EventType;
  limit?: number;
}

import { WebhookVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  /**
   * The request body exactly as it arrived. Parsing it and serialising it
   * again changes the bytes, and the signature never matches.
   */
  body: string | Uint8Array;
  /** The request headers: a Fetch Headers, or Node's/Express's header object. */
  headers: HeaderBag;
  /**
   * Your webhook secret. While you are moving to a new one, pass both: a call
   * is accepted when either header matches either secret.
   */
  secret: string | string[];
  /** How far X-Peppol-Timestamp may be from now; default 300 seconds. */
  toleranceSeconds?: number;
  now?: Date;
}

/**
 * Checks that a webhook call came from Business Gateway and is recent, and
 * answers its body. It throws WebhookVerificationError otherwise.
 *
 * X-Peppol-Signature is `sha256=` + hex HMAC-SHA256 of `timestamp + "." +
 * body` under the endpoint's secret. For 24 hours after the secret is changed
 * the replaced one signs X-Peppol-Signature-Previous too, so a server still
 * holding the old secret keeps accepting calls.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<WebhookEvent> {
  const raw = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
  const timestamp = header(input.headers, "x-peppol-timestamp");
  if (!timestamp) throw new WebhookVerificationError("missing X-Peppol-Timestamp");
  const sent = Date.parse(timestamp);
  if (Number.isNaN(sent)) throw new WebhookVerificationError("X-Peppol-Timestamp is not a timestamp");
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  const now = (input.now ?? new Date()).getTime();
  if (Math.abs(now - sent) > tolerance) {
    throw new WebhookVerificationError("X-Peppol-Timestamp is too far from now; the call may be a replay");
  }
  const given = [header(input.headers, "x-peppol-signature"), header(input.headers, "x-peppol-signature-previous")].filter(
    (s): s is string => Boolean(s),
  );
  if (given.length === 0) throw new WebhookVerificationError("missing X-Peppol-Signature");
  const secrets = (Array.isArray(input.secret) ? input.secret : [input.secret]).filter(Boolean);
  if (secrets.length === 0) throw new Error("verifyWebhook: a secret is required");

  let match = false;
  for (const secret of secrets) {
    const expected = await computeSignature(secret, timestamp, raw);
    for (const g of given) {
      // Every pair is compared, matched or not, so the time taken does not
      // say which one matched.
      if (timingSafeEqual(expected, g.trim())) match = true;
    }
  }
  if (!match) throw new WebhookVerificationError("signature does not match");
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("body is not JSON");
  }
}

/** The X-Peppol-Signature value for a body: for tests that post signed calls to your own endpoint. */
export async function computeSignature(secret: string, timestamp: string, body: string | Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const raw = typeof body === "string" ? enc.encode(body) : body;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = enc.encode(timestamp + ".");
  const signed = new Uint8Array(prefix.byteLength + raw.byteLength);
  signed.set(prefix);
  signed.set(raw, prefix.byteLength);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

// timingSafeEqual compares two signatures in time that depends only on their
// length, which is public: every signature is "sha256=" and 64 hex digits.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

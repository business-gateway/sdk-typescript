import { describe, expect, it } from "vitest";
import { computeSignature, verifyWebhook, WebhookVerificationError } from "../src/index.js";

// Computed with the platform's own webhook.Sign (internal/webhook), so this
// pins the SDK to what the server actually sends.
const secret = "whsec_test_0123456789";
const timestamp = "2026-11-24T10:00:00.123456789Z";
const body = `{"id":"e1","type":"message.inbound.received","documentId":"d1","status":"VALID"}`;
const goSignature = "sha256=6536ab1358cac9d13f5f73a41f5ea7bb00b959708226c5e6ce969ab1084b1a08";
const now = new Date("2026-11-24T10:01:00Z");

describe("verifyWebhook", () => {
  it("computes the same signature as the platform", async () => {
    expect(await computeSignature(secret, timestamp, body)).toBe(goSignature);
  });

  it("accepts a genuine call and answers its body, with Node-style or Fetch headers", async () => {
    const node = { "x-peppol-timestamp": timestamp, "x-peppol-signature": goSignature };
    const ev = await verifyWebhook({ body, headers: node, secret, now });
    expect(ev).toMatchObject({ id: "e1", type: "message.inbound.received", documentId: "d1" });
    const fetchHeaders = new Headers({ "X-Peppol-Timestamp": timestamp, "X-Peppol-Signature": goSignature });
    await expect(verifyWebhook({ body: new TextEncoder().encode(body), headers: fetchHeaders, secret, now })).resolves.toBeTruthy();
  });

  it("refuses a body that was changed, even by re-serialising it", async () => {
    const headers = { "x-peppol-timestamp": timestamp, "x-peppol-signature": goSignature };
    const reserialised = JSON.stringify(JSON.parse(body), null, 1);
    await expect(verifyWebhook({ body: reserialised, headers, secret, now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("refuses the wrong secret, a missing signature and an old timestamp", async () => {
    const headers = { "x-peppol-timestamp": timestamp, "x-peppol-signature": goSignature };
    await expect(verifyWebhook({ body, headers, secret: "other-secret-0000", now })).rejects.toThrow(/does not match/);
    await expect(verifyWebhook({ body, headers: { "x-peppol-timestamp": timestamp }, secret, now })).rejects.toThrow(/missing X-Peppol-Signature/);
    await expect(verifyWebhook({ body, headers, secret, now: new Date("2026-11-24T11:00:00Z") })).rejects.toThrow(/too far/);
  });

  it("accepts the previous-secret signature during a change of secret", async () => {
    const newSig = await computeSignature("the-new-secret-xx", timestamp, body);
    const headers = { "x-peppol-timestamp": timestamp, "x-peppol-signature": newSig, "x-peppol-signature-previous": goSignature };
    // A server still holding the old secret.
    await expect(verifyWebhook({ body, headers, secret, now })).resolves.toBeTruthy();
    // A server already moved, or one passing both.
    await expect(verifyWebhook({ body, headers, secret: "the-new-secret-xx", now })).resolves.toBeTruthy();
    await expect(verifyWebhook({ body, headers, secret: ["the-new-secret-xx", secret], now })).resolves.toBeTruthy();
  });
});

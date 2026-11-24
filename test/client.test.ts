import { describe, expect, it } from "vitest";
import { BusinessGateway, INLINE_MAX_BYTES } from "../src/index.js";
import { json, scriptedFetch } from "./fake.js";

const message = { id: "m1", direction: "OUTBOUND", status: "QUEUED_VALIDATION", sender: "0007:5561234567", receiver: "0007:5569876542", documentTypeId: "d", processId: "p", payloadSha256: "x", payloadBytes: 4, createdAt: "2026-11-24T10:00:00Z" };

function client(answers: Parameters<typeof scriptedFetch>[0]) {
  const f = scriptedFetch(answers);
  return { bg: new BusinessGateway({ apiKey: "k", baseUrl: "https://api.test", fetch: f.fetch, maxRetries: 0 }), seen: f.seen };
}

describe("messages", () => {
  it("sends inline with a generated Idempotency-Key and only the fields given", async () => {
    const { bg, seen } = client([json(202, message)]);
    const m = await bg.messages.send({ sender: "0007:5561234567", payload: "<Invoice/>", externalReference: "INV-1" });
    expect(m.id).toBe("m1");
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/v1/messages");
    expect(req.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.body).toEqual({ sender: "0007:5561234567", payload: "<Invoice/>", externalReference: "INV-1" });
  });

  it("uses the caller's Idempotency-Key", async () => {
    const { bg, seen } = client([json(200, message)]);
    await bg.messages.send({ sender: "0007:1", payload: "<x/>", idempotencyKey: "erp-INV-1" });
    expect(seen[0]!.headers.get("Idempotency-Key")).toBe("erp-INV-1");
  });

  it("stages a large document under its sender, PUTs it as signed, and sends the key", async () => {
    const big = "<Invoice>" + "x".repeat(INLINE_MAX_BYTES) + "</Invoice>";
    const { bg, seen } = client([
      json(201, { payloadObjectKey: "uploads/c1/k", uploadUrl: "https://s3.test/put?sig=1", expiresAt: "", headers: { "Content-Type": "application/xml" } }),
      new Response(null, { status: 200 }),
      json(202, message),
    ]);
    await bg.messages.send({ sender: "0007:5561234567", payload: big });
    const [grant, put, send] = seen;
    expect(grant!.url.pathname).toBe("/v1/messages/uploads");
    expect(grant!.body).toEqual({ bytes: new TextEncoder().encode(big).byteLength, sender: "0007:5561234567" });
    expect(put!.method).toBe("PUT");
    expect(put!.url.toString()).toBe("https://s3.test/put?sig=1");
    expect(put!.headers.get("Content-Type")).toBe("application/xml");
    expect(put!.headers.get("X-API-Key")).toBeNull();
    expect(send!.body).toEqual({ sender: "0007:5561234567", payloadObjectKey: "uploads/c1/k" });
  });

  it("dry-runs without an Idempotency-Key", async () => {
    const { bg, seen } = client([json(200, { dryRun: true, valid: true, findings: [] })]);
    await bg.messages.dryRun({ sender: "0007:1", payload: "<x/>" });
    expect(seen[0]!.url.search).toBe("?dryRun=true");
    expect(seen[0]!.headers.get("Idempotency-Key")).toBeNull();
  });

  it("pages through every message", async () => {
    const { bg, seen } = client([
      json(200, { messages: [{ ...message, id: "a" }, { ...message, id: "b" }], nextCursor: "c2" }),
      json(200, { messages: [{ ...message, id: "c" }] }),
    ]);
    const ids: string[] = [];
    for await (const m of bg.messages.listAll({ direction: "INBOUND", delivery: "pending" })) ids.push(m.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(seen[0]!.url.searchParams.get("delivery")).toBe("pending");
    expect(seen[1]!.url.searchParams.get("cursor")).toBe("c2");
  });

  it("reads the payload as text and acks", async () => {
    const { bg, seen } = client([new Response("<Invoice/>", { status: 200 }), json(200, message)]);
    expect(await bg.messages.payload("m 1")).toBe("<Invoice/>");
    await bg.messages.ack("m1");
    expect(seen[0]!.url.pathname).toBe("/v1/messages/m%201/payload");
    expect(seen[1]!.method).toBe("POST");
    expect(seen[1]!.url.pathname).toBe("/v1/messages/m1/ack");
  });
});

describe("validation and events", () => {
  it("validates against a named ruleset", async () => {
    const { bg, seen } = client([json(200, { valid: true, findings: [], ruleset: "2026.11" })]);
    const r = await bg.validate({ payload: "<Invoice/>" }, { ruleset: "2026.11" });
    expect(r.ruleset).toBe("2026.11");
    expect(seen[0]!.url.search).toBe("?ruleset=2026.11");
    expect(seen[0]!.body).toEqual({ payload: "<Invoice/>" });
  });

  it("lists rulesets and reads the event feed from a cursor", async () => {
    const { bg, seen } = client([
      json(200, { rulesets: [{ name: "2026.5", title: "Q2", status: "in_force" }] }),
      json(200, { events: [], nextCursor: "n2" }),
    ]);
    expect((await bg.rulesets())[0]!.name).toBe("2026.5");
    const page = await bg.events.list({ after: "n1", type: "message.inbound.received" });
    expect(page).toEqual({ events: [], nextCursor: "n2" });
    expect(seen[1]!.url.search).toBe("?after=n1&type=message.inbound.received");
  });
});

describe("construction", () => {
  it("needs an API key", () => {
    expect(() => new BusinessGateway({ apiKey: "" })).toThrow(/apiKey/);
  });
});

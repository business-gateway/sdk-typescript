import { describe, expect, it, vi } from "vitest";
import { BusinessGatewayConnectionError, BusinessGatewayError } from "../src/errors.js";
import { Transport } from "../src/http.js";
import { apiError, json, scriptedFetch } from "./fake.js";

function transport(answers: Parameters<typeof scriptedFetch>[0], maxRetries = 3) {
  const f = scriptedFetch(answers);
  const sleep = vi.fn(async () => {});
  const t = new Transport({ apiKey: "k", baseUrl: "https://api.test/", fetch: f.fetch, maxRetries, timeoutMs: 1000, sleep });
  return { t, seen: f.seen, sleep };
}

describe("Transport retries", () => {
  it("repeats a GET after a retryable error and a dropped connection", async () => {
    const { t, seen } = transport([apiError(503, "VALIDATION_UNAVAILABLE", true), new TypeError("socket hang up"), json(200, { ok: 1 })]);
    await expect(t.request({ method: "GET", path: "/v1/x" })).resolves.toEqual({ ok: 1 });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.headers.get("X-API-Key")).toBe("k");
    expect(seen[0]!.url.toString()).toBe("https://api.test/v1/x");
  });

  it("repeats a POST with an Idempotency-Key, under the same key", async () => {
    const { t, seen } = transport([apiError(502, "UPSTREAM", true), json(202, { id: "m1" })]);
    await t.request({ method: "POST", path: "/v1/messages", body: {}, idempotencyKey: "key-1" });
    expect(seen.map((s) => s.headers.get("Idempotency-Key"))).toEqual(["key-1", "key-1"]);
  });

  it("does not repeat a POST without a key after a 5xx or a dropped connection", async () => {
    const a = transport([apiError(503, "X", true)]);
    await expect(a.t.request({ method: "POST", path: "/v1/x", body: {} })).rejects.toMatchObject({ status: 503, code: "X" });
    expect(a.seen).toHaveLength(1);
    const b = transport([new TypeError("reset")]);
    await expect(b.t.request({ method: "POST", path: "/v1/x", body: {} })).rejects.toBeInstanceOf(BusinessGatewayConnectionError);
    expect(b.seen).toHaveLength(1);
  });

  it("repeats any request after 429, waiting Retry-After", async () => {
    const { t, seen, sleep } = transport([apiError(429, "RATE_LIMITED", true, { "Retry-After": "2" }), json(200, {})]);
    await t.request({ method: "POST", path: "/v1/validate", body: {} });
    expect(seen).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("never repeats what is not retryable, and reports it", async () => {
    const { t, seen } = transport([apiError(400, "PARTY_MISMATCH", false)]);
    const err = await t.request({ method: "GET", path: "/v1/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessGatewayError);
    expect(err).toMatchObject({ status: 400, code: "PARTY_MISMATCH", retryable: false, requestId: "req-1" });
    expect(seen).toHaveLength(1);
  });

  it("gives up after maxRetries", async () => {
    const { t, seen } = transport([apiError(503, "X", true), apiError(503, "X", true), apiError(503, "X", true)], 2);
    await expect(t.request({ method: "GET", path: "/v1/x" })).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(3);
  });

  it("reads an error body that is not the API's own", async () => {
    const { t } = transport([new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" })], 0);
    await expect(t.request({ method: "GET", path: "/v1/x" })).rejects.toMatchObject({ code: "HTTP_502", retryable: true });
  });

  it("sends query parameters and leaves out empty ones", async () => {
    const { t, seen } = transport([json(200, {})]);
    await t.request({ method: "GET", path: "/v1/x", query: { a: "1", b: undefined, c: "", d: true } });
    expect(seen[0]!.url.search).toBe("?a=1&d=true");
  });
});

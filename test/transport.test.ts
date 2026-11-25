import { describe, expect, it, vi } from "vitest";
import { BusinessGatewayConnectionError, BusinessGatewayError, BusinessGatewayRateLimitError } from "../src/errors.js";
import { readRateLimit, retryAfterSeconds, Transport } from "../src/http.js";
import { apiError, json, scriptedFetch } from "./fake.js";

function transport(answers: Parameters<typeof scriptedFetch>[0], maxRetries = 3) {
  const f = scriptedFetch(answers);
  const sleep = vi.fn(async (_ms: number) => {});
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

  it("repeats a safe POST after 429, waiting Retry-After", async () => {
    const { t, seen, sleep } = transport([apiError(429, "RATE_LIMITED", true, { "Retry-After": "2" }), json(200, {})]);
    await t.request({ method: "POST", path: "/v1/validate", body: {}, safe: true });
    expect(seen).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not repeat a POST without a key after 429, and throws the typed error", async () => {
    const { t, seen, sleep } = transport([apiError(429, "RATE_LIMITED", true, { "Retry-After": "7" })]);
    const err = await t.request<never>({ method: "POST", path: "/v1/x", body: {} }).catch((e: BusinessGatewayRateLimitError) => e);
    expect(err).toBeInstanceOf(BusinessGatewayRateLimitError);
    expect(err).toBeInstanceOf(BusinessGatewayError);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", retryable: true, retryAfter: 7 });
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("repeats a POST with an Idempotency-Key after 429", async () => {
    const { t, seen } = transport([apiError(429, "RATE_LIMITED", true, { "Retry-After": "1" }), json(202, {})]);
    await t.request({ method: "POST", path: "/v1/messages", body: {}, idempotencyKey: "k1" });
    expect(seen).toHaveLength(2);
  });

  it("throws at once rather than sit out a Retry-After over a minute", async () => {
    const { t, seen, sleep } = transport([apiError(429, "RATE_LIMITED", true, { "Retry-After": "120" })]);
    const err = await t.request<never>({ method: "GET", path: "/v1/x" }).catch((e: BusinessGatewayRateLimitError) => e);
    expect(err).toBeInstanceOf(BusinessGatewayRateLimitError);
    expect(err.retryAfter).toBe(120);
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("carries the RateLimit headers and Retry-After once retries are spent", async () => {
    const limited = () =>
      apiError(429, "RATE_LIMITED", true, { "Retry-After": "3", "RateLimit-Limit": "120", "RateLimit-Remaining": "0", "RateLimit-Reset": "3" });
    const { t, seen, sleep } = transport([limited(), limited()], 1);
    const err = await t.request<never>({ method: "GET", path: "/v1/x" }).catch((e: BusinessGatewayRateLimitError) => e);
    expect(seen).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(err).toBeInstanceOf(BusinessGatewayRateLimitError);
    expect(err).toMatchObject({ retryAfter: 3, rateLimit: { limit: 120, remaining: 0, resetSeconds: 3 } });
  });

  it("gives a 429 without Retry-After the usual backoff, and no retryAfter", async () => {
    const { t, sleep } = transport([new Response("", { status: 429 }), new Response("", { status: 429 })], 1);
    const err = await t.request<never>({ method: "GET", path: "/v1/x" }).catch((e: BusinessGatewayRateLimitError) => e);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeLessThan(500);
    expect(err).toBeInstanceOf(BusinessGatewayRateLimitError);
    expect(err.retryAfter).toBeUndefined();
    expect(err.code).toBe("HTTP_429");
  });

  it("puts the RateLimit headers on other errors too, and reports every answer", async () => {
    const seenMeta: unknown[] = [];
    const f = scriptedFetch([
      json(200, {}, { "RateLimit-Limit": "120", "RateLimit-Remaining": "5", "RateLimit-Reset": "40", "X-Request-Id": "r1" }),
      apiError(400, "VALIDATION_FAILED", false, { "RateLimit-Limit": "120", "RateLimit-Remaining": "4", "RateLimit-Reset": "39" }),
      json(200, {}),
    ]);
    const t = new Transport({ apiKey: "k", baseUrl: "https://api.test", fetch: f.fetch, maxRetries: 0, timeoutMs: 1000, sleep: async () => {}, onResponse: (m) => seenMeta.push(m) });
    await t.request({ method: "POST", path: "/v1/validate", body: {}, safe: true });
    const err = await t.request<never>({ method: "POST", path: "/v1/validate", body: {}, safe: true }).catch((e: BusinessGatewayRateLimitError) => e);
    expect(err).not.toBeInstanceOf(BusinessGatewayRateLimitError);
    expect(err.rateLimit).toEqual({ limit: 120, remaining: 4, resetSeconds: 39 });
    await t.request({ method: "GET", path: "/v1/y" });
    expect(seenMeta).toEqual([
      { method: "POST", path: "/v1/validate", status: 200, requestId: "r1", rateLimit: { limit: 120, remaining: 5, resetSeconds: 40 } },
      { method: "POST", path: "/v1/validate", status: 400, rateLimit: { limit: 120, remaining: 4, resetSeconds: 39 } },
      { method: "GET", path: "/v1/y", status: 200 },
    ]);
  });

  it("does not let a throwing onResponse fail an answered request", async () => {
    const f = scriptedFetch([json(202, { id: "m1" })]);
    const onResponse = () => {
      throw new Error("observer bug");
    };
    const t = new Transport({ apiKey: "k", baseUrl: "https://api.test", fetch: f.fetch, maxRetries: 0, timeoutMs: 1000, sleep: async () => {}, onResponse });
    await expect(t.request({ method: "POST", path: "/v1/messages", body: {}, idempotencyKey: "k" })).resolves.toEqual({ id: "m1" });
  });

  it("never repeats what is not retryable, and reports it", async () => {
    const { t, seen } = transport([apiError(400, "PARTY_MISMATCH", false)]);
    const err = await t.request<never>({ method: "GET", path: "/v1/x" }).catch((e: BusinessGatewayRateLimitError) => e);
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

describe("rate-limit headers", () => {
  it("reads RateLimit-* only when all three are whole numbers", () => {
    expect(readRateLimit(new Headers({ "RateLimit-Limit": "120", "RateLimit-Remaining": "0", "RateLimit-Reset": "12" }))).toEqual({ limit: 120, remaining: 0, resetSeconds: 12 });
    expect(readRateLimit(new Headers({ "RateLimit-Limit": "120", "RateLimit-Remaining": "3" }))).toBeUndefined();
    expect(readRateLimit(new Headers({ "RateLimit-Limit": "x", "RateLimit-Remaining": "3", "RateLimit-Reset": "1" }))).toBeUndefined();
    expect(readRateLimit(new Headers())).toBeUndefined();
  });

  it("reads Retry-After as seconds or an HTTP date, rounding up", () => {
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(retryAfterSeconds(new Headers({ "Retry-After": "5" }), now)).toBe(5);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "1.2" }), now)).toBe(2);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "Wed, 25 Nov 2026 10:00:30 GMT" }), now)).toBe(30);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "Wed, 25 Nov 2026 09:00:00 GMT" }), now)).toBe(0);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "-1" }), now)).toBeUndefined();
    expect(retryAfterSeconds(new Headers({ "Retry-After": "soon" }), now)).toBeUndefined();
    expect(retryAfterSeconds(new Headers(), now)).toBeUndefined();
  });
});

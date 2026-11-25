# Business Gateway TypeScript SDK

A small client for the [Business Gateway](https://businessgateway.se) Peppol API: send and receive documents, validate before you send, read the event feed, and verify webhooks. No runtime dependencies; it uses `fetch` and Web Crypto, so it runs on Node 20+, Deno, Bun and edge runtimes.

```bash
npm install @businessgateway/sdk
```

## Sending a document

```ts
import { BusinessGateway } from "@businessgateway/sdk";

const bg = new BusinessGateway({ apiKey: process.env.BG_API_KEY! });

const message = await bg.messages.send({
  sender: "0007:5561234567",
  payload: invoiceXml,          // string, Uint8Array or Blob
  externalReference: "INV-1001", // your own reference, returned on webhooks
});
// message.status is usually QUEUED_VALIDATION: the Peppol validation runs
// after the call returns. Follow it with a webhook, the event feed or get().
```

Pass `wait: 20` (seconds, at most 30) to hold the answer until the validation is decided: the message then carries `QUEUED` or `VALIDATION_FAILED` instead of `QUEUED_VALIDATION`, unless the time runs out first.

Only `sender` and `payload` are required; the receiver and document type are read off the document when you leave them out.

Every send carries an `Idempotency-Key`. The client generates one, or you pass your own (`idempotencyKey: "erp-INV-1001"`) so a retry from your side cannot send twice either. Within 24 hours the same key answers with the message the first call created.

A document over 512 KB is staged through `POST /v1/messages/uploads` automatically; you do nothing different.

### Trying first

```ts
const check = await bg.messages.dryRun({ sender, payload });     // every check a send makes, nothing sent
const result = await bg.validate({ payload });                   // just the Peppol validation
if (!result.valid) console.log(result.findings);
```

Both answers say which Peppol release the document was checked against (`ruleset`). While a new release is scheduled they also carry `upcoming`: the same document under the coming rules, and the date they apply from. `bg.rulesets()` lists the releases, and `bg.validate({ payload }, { ruleset: "2026.11" })` checks against one.

## Receiving documents

```ts
for await (const m of bg.messages.listAll({ direction: "INBOUND", delivery: "pending" })) {
  const xml = await bg.messages.payload(m.id);
  await importIntoErp(xml);
  await bg.messages.ack(m.id); // leaves the pending list
}
```

## Webhooks

Verify every call before you trust it. Pass the raw body exactly as it arrived: parsing and re-serialising it changes the bytes and the signature never matches.

```ts
import { verifyWebhook, WebhookVerificationError } from "@businessgateway/sdk";

// Next.js route handler, or any Fetch-style handler
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const event = await verifyWebhook({ body, headers: req.headers, secret: process.env.BG_WEBHOOK_SECRET! });
    await queue.add(event); // record it, answer 2xx, do the work afterwards
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw err;
  }
}
```

With Express, use `express.raw({ type: "application/json" })` on the route and pass `req.body` (a Buffer) and `req.headers`.

While you change the secret, the replaced one keeps signing `X-Peppol-Signature-Previous` for 24 hours. `verifyWebhook` checks both headers, so a server holding either secret keeps accepting calls; pass both (`secret: [newSecret, oldSecret]`) where you have both.

Calls can arrive more than once. Deduplicate on `event.id`.

## The event feed

Everything a webhook would carry, kept 30 days, whether or not you have a webhook:

```ts
let cursor = await loadCursor(); // undefined the first time: starts at the oldest event
const page = await bg.events.list({ cursor });
for (const event of page.events) await handle(event);
await saveCursor(page.nextCursor); // always set, even when events is empty
```

## Errors and retries

A failed request throws `BusinessGatewayError` with the API's `code`, `status`, `retryable` and `requestId` (quote it to support). `BusinessGatewayConnectionError` is a request that never got an answer.

The client retries for you, at most `maxRetries` times (default 3), but only when repeating cannot do something twice: a read (`GET`), a call that stores and sends nothing (`validate()`, `messages.dryRun()`), or a write that carries an `Idempotency-Key` (every `send()`). Those are repeated after a dropped connection, a timeout or a retryable error, `429` included, waiting the `Retry-After` the API gives or else backing off. Everything else is tried once and its error is yours to judge.

```ts
new BusinessGateway({ apiKey, maxRetries: 5, timeoutMs: 60_000, baseUrl: "https://api.businessgateway.se" });
```

## Rate limits

Sending is not rate limited. Validation is: `validate()` and `messages.dryRun()` share 120 calls a minute per account. Their answers carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until a call is freed), on success as on refusal, and the client reads them for you:

```ts
await bg.validate({ payload });
bg.lastResponse?.rateLimit; // { limit: 120, remaining: 87, resetSeconds: 41 }
```

`lastResponse` is the latest answer this client got, from whichever call. When calls run concurrently, pass `onResponse` instead; it is told about every answer, each retry's included:

```ts
const bg = new BusinessGateway({
  apiKey,
  onResponse: ({ method, path, status, requestId, rateLimit }) => {
    if (rateLimit && rateLimit.remaining < 10) log.warn("validation budget low", { path, rateLimit });
  },
});
```

Over the limit the API answers `429` with `Retry-After`. The client waits that long and tries again, within `maxRetries`, as long as the wait is at most a minute. When it gives up it throws `BusinessGatewayRateLimitError`, a `BusinessGatewayError` with `retryAfter` in seconds:

```ts
import { BusinessGatewayRateLimitError } from "@businessgateway/sdk";

try {
  await bg.validate({ payload });
} catch (err) {
  if (err instanceof BusinessGatewayRateLimitError) {
    await queue.retryLater(payload, (err.retryAfter ?? 60) * 1000);
  } else throw err;
}
```

Every `BusinessGatewayError` carries `rateLimit` too, when its answer had the headers.

Sign-in routes have per-address limits of their own, which answer `429` with `Retry-After` but no `RateLimit-*` headers.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/
npm run sync-spec # copy ../docs/openapi.json and regenerate src/generated/openapi.ts
npm run generate  # regenerate the types from spec/openapi.json alone
node scripts/spec-drift.mjs # compare the copy with what the API publishes
```

The response types in `src/types.ts` are aliases of the schemas in the OpenAPI document, generated into `src/generated/openapi.ts` by openapi-typescript; the platform derives those schemas from the structs its handlers encode. The aliases only narrow strings to the documented values, and the build refuses a narrowing that names a field the schema does not have. CI fails when the generated file is stale, and the weekly spec-drift workflow fails when the API publishes a route or field the SDK's copy lacks. The webhook test pins the signature to a vector computed by the platform's own signing code.

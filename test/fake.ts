// A scripted fetch: each call takes the next answer, and every request is kept
// for the test to inspect.
export interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
  rawBody?: BodyInit | null;
}

export type Answer = Response | Error | ((req: Seen) => Response);

export function scriptedFetch(answers: Answer[]) {
  const seen: Seen[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: Seen = { method: init?.method ?? "GET", url, headers, body, rawBody: init?.body };
    seen.push(req);
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected ${req.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  };
  return { fetch: fn as typeof fetch, seen };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function apiError(status: number, code: string, retryable: boolean, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: code.toLowerCase(), retryable, requestId: "req-1" } }, headers);
}

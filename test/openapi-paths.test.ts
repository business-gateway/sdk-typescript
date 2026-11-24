import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every route the client calls, as the API's OpenAPI document names it. The
// copy in spec/ comes from the docs site (npm run sync-spec); a route renamed
// or removed there fails here before a customer finds out.
const calls: [string, string][] = [
  ["post", "/v1/messages"],
  ["get", "/v1/messages"],
  ["get", "/v1/messages/{id}"],
  ["get", "/v1/messages/{id}/payload"],
  ["post", "/v1/messages/{id}/ack"],
  ["post", "/v1/messages/uploads"],
  ["post", "/v1/validate"],
  ["get", "/v1/validation/rulesets"],
  ["get", "/v1/events"],
];

const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
};

describe("the client against the OpenAPI document", () => {
  it.each(calls)("%s %s exists", (method, path) => {
    expect(spec.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
  });

  it("names the query parameters the client sends", () => {
    const params = (method: string, path: string) => (spec.paths[path]?.[method]?.parameters ?? []).map((p) => p.name);
    expect(params("post", "/v1/messages")).toContain("dryRun");
    expect(params("post", "/v1/validate")).toContain("ruleset");
  });
});

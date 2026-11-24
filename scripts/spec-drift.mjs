// Compares spec/openapi.json with the document the API publishes, and fails
// when the API has something the SDK's copy lacks: a path, an operation, a
// schema or a schema field. The copy being ahead — a change merged but not
// yet released — is reported and does not fail.
//
//   node scripts/spec-drift.mjs [url]
import { readFile } from "node:fs/promises";

const url = process.argv[2] ?? "https://api.businessgateway.se/v1/openapi.docs.json";
const local = JSON.parse(await readFile(new URL("../spec/openapi.json", import.meta.url), "utf8"));
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url}: ${res.status}`);
  process.exit(2);
}
const live = await res.json();

const methods = ["get", "post", "put", "patch", "delete"];
const ops = (doc) =>
  new Set(Object.entries(doc.paths ?? {}).flatMap(([p, item]) => methods.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${p}`)));
const fields = (doc) => {
  const out = new Set();
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) {
    out.add(name);
    for (const f of Object.keys(s.properties ?? {})) out.add(`${name}.${f}`);
  }
  return out;
};
const missing = (a, b) => [...a].filter((x) => !b.has(x)).sort();

const behind = [...missing(ops(live), ops(local)), ...missing(fields(live), fields(local))];
const ahead = [...missing(ops(local), ops(live)), ...missing(fields(local), fields(live))];
if (ahead.length) {
  const shown = ahead.slice(0, 10).join("\n  ");
  console.log(`In the SDK's copy, not yet published (${ahead.length}):\n  ${shown}${ahead.length > 10 ? "\n  …" : ""}`);
}
if (behind.length) {
  console.error(`Published by the API, missing from spec/openapi.json (${behind.length}):\n  ${behind.join("\n  ")}`);
  console.error("Run npm run sync-spec and update the types that use them.");
  process.exit(1);
}
console.log("spec/openapi.json covers everything the API publishes.");

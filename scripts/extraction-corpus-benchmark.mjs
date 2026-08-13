import { readFile } from "node:fs/promises";

const gateway = (process.env.OPENBROWSE_BENCHMARK_GATEWAY ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.OPENBROWSE_BENCHMARK_API_KEY;
const corpusPath = process.env.OPENBROWSE_CORPUS_FILE;
const concurrency = Number(process.env.OPENBROWSE_CORPUS_CONCURRENCY ?? 3);
const minimumPages = Number(process.env.OPENBROWSE_CORPUS_MIN_PAGES ?? 100);
const maximumPages = Number(process.env.OPENBROWSE_CORPUS_MAX_PAGES ?? 500);

if (!apiKey) throw new Error("OPENBROWSE_BENCHMARK_API_KEY is required");
if (!corpusPath) throw new Error("OPENBROWSE_CORPUS_FILE is required");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20)
  throw new Error("OPENBROWSE_CORPUS_CONCURRENCY must be an integer from 1 to 20");
if (!Number.isInteger(minimumPages) || !Number.isInteger(maximumPages) || minimumPages < 1 || maximumPages < minimumPages)
  throw new Error("Corpus page bounds must be positive integers with max >= min");

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
if (!Array.isArray(corpus)) throw new Error("Corpus file must be a JSON array");
if (corpus.length < minimumPages || corpus.length > maximumPages)
  throw new Error(`Corpus must contain ${minimumPages}-${maximumPages} pages; received ${corpus.length}`);

function validateCase(entry, index) {
  if (!entry || typeof entry !== "object") throw new Error(`Corpus entry ${index} must be an object`);
  if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url))
    throw new Error(`Corpus entry ${index} requires an http(s) url`);
  if (!entry.expect || typeof entry.expect !== "object")
    throw new Error(`Corpus entry ${index} requires an expect object`);
  const { markdownIncludes = [], markdownExcludes = [], minimumMarkdownChars = 1, minimumLinks = 0 } = entry.expect;
  if (!Array.isArray(markdownIncludes) || !markdownIncludes.every((value) => typeof value === "string" && value))
    throw new Error(`Corpus entry ${index} has invalid markdownIncludes`);
  if (!Array.isArray(markdownExcludes) || !markdownExcludes.every((value) => typeof value === "string" && value))
    throw new Error(`Corpus entry ${index} has invalid markdownExcludes`);
  if (!Number.isInteger(minimumMarkdownChars) || minimumMarkdownChars < 1)
    throw new Error(`Corpus entry ${index} has invalid minimumMarkdownChars`);
  if (!Number.isInteger(minimumLinks) || minimumLinks < 0)
    throw new Error(`Corpus entry ${index} has invalid minimumLinks`);
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : `page-${index + 1}`,
    url: entry.url,
    expect: { markdownIncludes, markdownExcludes, minimumMarkdownChars, minimumLinks },
  };
}

const cases = corpus.map(validateCase);
if (new Set(cases.map((entry) => entry.id)).size !== cases.length)
  throw new Error("Corpus entry ids must be unique");

const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const startedAt = new Date().toISOString();
async function fetchCase(entry) {
  const started = performance.now();
  try {
    const response = await fetch(`${gateway}/v1/fetch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: entry.url,
        strategy: "auto",
        output: ["markdown", "links"],
        cache: { mode: "no-store", ttlSeconds: 1 },
      }),
    });
    const body = await response.json().catch(() => ({}));
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    const links = Array.isArray(body.links) ? body.links : [];
    const checks = [
      ...entry.expect.markdownIncludes.map((value) => ({ name: `includes:${value}`, pass: markdown.includes(value) })),
      ...entry.expect.markdownExcludes.map((value) => ({ name: `excludes:${value}`, pass: !markdown.includes(value) })),
      { name: "minimumMarkdownChars", pass: markdown.length >= entry.expect.minimumMarkdownChars },
      { name: "minimumLinks", pass: links.length >= entry.expect.minimumLinks },
    ];
    return {
      id: entry.id,
      url: entry.url,
      ok: response.ok && checks.every((check) => check.pass),
      responseOk: response.ok,
      status: response.status,
      strategy: body.strategy ?? null,
      finalUrl: body.finalUrl ?? null,
      markdownChars: markdown.length,
      links: links.length,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      checks,
      ...(response.ok ? {} : { error: body.error?.message ?? JSON.stringify(body).slice(0, 500) }),
    };
  } catch (error) {
    return { id: entry.id, url: entry.url, ok: false, responseOk: false, status: 0, elapsedMs: Number((performance.now() - started).toFixed(1)), checks: [], error: String(error) };
  }
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < cases.length) {
    const entry = cases[next++];
    if (entry) results.push(await fetchCase(entry));
  }
}));
results.sort((left, right) => left.id.localeCompare(right.id));
const checks = results.flatMap((result) => result.checks);
const passedPages = results.filter((result) => result.ok).length;
const successfulRequests = results.filter((result) => result.responseOk).length;
const browserEscalations = results.filter((result) => result.strategy === "browser").length;

console.log(JSON.stringify({
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  gateway,
  corpusPath,
  pages: results.length,
  concurrency,
  summary: {
    passedPages,
    pagePassRate: Number((passedPages / results.length).toFixed(4)),
    successfulRequests,
    browserEscalations,
    assertions: checks.length,
    passedAssertions: checks.filter((check) => check.pass).length,
    assertionPassRate: checks.length ? Number((checks.filter((check) => check.pass).length / checks.length).toFixed(4)) : 0,
  },
  results,
}, null, 2));

if (passedPages !== results.length) process.exitCode = 1;

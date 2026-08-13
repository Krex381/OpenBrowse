const gateway = (process.env.OPENBROWSE_BENCHMARK_GATEWAY ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.OPENBROWSE_BENCHMARK_API_KEY;
const target = process.env.OPENBROWSE_BENCHMARK_TARGET ?? "https://example.com";
const requests = Number(process.env.OPENBROWSE_BENCHMARK_REQUESTS ?? 100);
const concurrency = Number(process.env.OPENBROWSE_BENCHMARK_CONCURRENCY ?? 4);

if (!apiKey) throw new Error("OPENBROWSE_BENCHMARK_API_KEY is required");
if (!Number.isInteger(requests) || requests < 1 || requests > 100000)
  throw new Error("OPENBROWSE_BENCHMARK_REQUESTS must be an integer from 1 to 100000");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100)
  throw new Error("OPENBROWSE_BENCHMARK_CONCURRENCY must be an integer from 1 to 100");

const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

async function pressure() {
  const response = await fetch(`${gateway}/pressure`);
  if (!response.ok) throw new Error(`/pressure returned ${response.status}`);
  return response.json();
}

async function run(index) {
  const browser = index % 5 === 4;
  const started = performance.now();
  const response = await fetch(`${gateway}/v1/fetch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: target,
      strategy: browser ? "browser" : "http",
      output: ["markdown"],
      cache: { mode: "no-store", ttlSeconds: 1 },
    }),
  });
  const body = await response.text();
  return {
    kind: browser ? "browser" : "http",
    ok: response.ok,
    status: response.status,
    ms: performance.now() - started,
    error: response.ok ? undefined : body.slice(0, 500),
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const before = await pressure();
const started = Date.now();
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next < requests) {
      const index = next++;
      results.push(await run(index));
    }
  }),
);
const after = await pressure();
const durationMs = Date.now() - started;
const summarize = (kind) => {
  const items = results.filter((result) => result.kind === kind);
  const successful = items.filter((result) => result.ok);
  return {
    requests: items.length,
    successful: successful.length,
    failed: items.length - successful.length,
    p50Ms: Number(percentile(successful.map((result) => result.ms), 0.5).toFixed(1)),
    p95Ms: Number(percentile(successful.map((result) => result.ms), 0.95).toFixed(1)),
  };
};
console.log(
  JSON.stringify(
    {
      target,
      requests,
      concurrency,
      durationMs,
      requestsPerSecond: Number((requests / (durationMs / 1000)).toFixed(2)),
      workloads: { http: summarize("http"), browser: summarize("browser") },
      memory: { before: before.memory, after: after.memory },
      browserWorkers: { before: before.sessions, after: after.sessions },
      failures: results.filter((result) => !result.ok).slice(0, 20),
    },
    null,
    2,
  ),
);

if (results.some((result) => !result.ok)) process.exitCode = 1;

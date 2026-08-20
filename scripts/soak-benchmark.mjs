import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright/package.json").version;
const gateway = (process.env.OPENBROWSE_BENCHMARK_GATEWAY ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.OPENBROWSE_BENCHMARK_API_KEY;
const target = process.env.OPENBROWSE_BENCHMARK_TARGET ?? "https://example.com";
const targets = (process.env.OPENBROWSE_BENCHMARK_TARGETS ?? target)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const requests = Number(process.env.OPENBROWSE_BENCHMARK_REQUESTS ?? 100);
const concurrency = Number(process.env.OPENBROWSE_BENCHMARK_CONCURRENCY ?? 4);
const durationSeconds = process.env.OPENBROWSE_BENCHMARK_DURATION_SECONDS === undefined
  ? undefined
  : Number(process.env.OPENBROWSE_BENCHMARK_DURATION_SECONDS);
const sampleIntervalSeconds = Number(process.env.OPENBROWSE_BENCHMARK_SAMPLE_INTERVAL_SECONDS ?? 60);
const maxLatencySamples = 20_000;
const browserEvery = Number(process.env.OPENBROWSE_BENCHMARK_BROWSER_EVERY ?? 5);

if (!apiKey) throw new Error("OPENBROWSE_BENCHMARK_API_KEY is required");
if (!Number.isInteger(requests) || requests < 1 || requests > 100000)
  throw new Error("OPENBROWSE_BENCHMARK_REQUESTS must be an integer from 1 to 100000");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100)
  throw new Error("OPENBROWSE_BENCHMARK_CONCURRENCY must be an integer from 1 to 100");
if (!Number.isInteger(browserEvery) || browserEvery < 1 || browserEvery > 100)
  throw new Error("OPENBROWSE_BENCHMARK_BROWSER_EVERY must be an integer from 1 to 100");
if (!targets.length || targets.some((value) => !/^https?:\/\//.test(value)))
  throw new Error("OPENBROWSE_BENCHMARK_TARGETS must contain comma-separated HTTP(S) URLs");
if (
  durationSeconds !== undefined &&
  (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400)
)
  throw new Error("OPENBROWSE_BENCHMARK_DURATION_SECONDS must be an integer from 1 to 86400");
if (!Number.isInteger(sampleIntervalSeconds) || sampleIntervalSeconds < 1 || sampleIntervalSeconds > 3600)
  throw new Error("OPENBROWSE_BENCHMARK_SAMPLE_INTERVAL_SECONDS must be an integer from 1 to 3600");

const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

async function pressure() {
  const response = await fetch(`${gateway}/pressure`);
  if (!response.ok) throw new Error(`/pressure returned ${response.status}`);
  return response.json();
}

function workerSnapshot(snapshot) {
  return snapshot.browserWorkers ?? snapshot.sessions;
}

async function run(index) {
  const browser = index % browserEvery === browserEvery - 1;
  const selectedTarget = targets[index % targets.length];
  const started = performance.now();
  const response = await fetch(`${gateway}/v1/fetch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: selectedTarget,
      strategy: browser ? "browser" : "http",
      output: ["markdown"],
      cache: { mode: "no-store", ttlSeconds: 1 },
    }),
  });
  const raw = await response.text();
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    // The failure record below retains a bounded copy of a non-JSON response.
  }
  return {
    kind: browser ? "browser" : "http",
    target: selectedTarget,
    ok: response.ok,
    status: response.status,
    ms: performance.now() - started,
    actualStrategy: body.execution?.strategyUsed ?? body.strategy,
    backend: body.execution?.selectedBackend,
    error: response.ok ? undefined : (body.error?.message ?? raw.slice(0, 500)),
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function createSummary() {
  return { requests: 0, successful: 0, failed: 0, samples: [], actualStrategies: {}, backends: {} };
}

function record(summary, result) {
  summary.requests++;
  if (!result.ok) {
    summary.failed++;
    return;
  }
  summary.successful++;
  if (result.actualStrategy)
    summary.actualStrategies[result.actualStrategy] = (summary.actualStrategies[result.actualStrategy] ?? 0) + 1;
  if (result.backend)
    summary.backends[result.backend] = (summary.backends[result.backend] ?? 0) + 1;
  if (summary.samples.length < maxLatencySamples) {
    summary.samples.push(result.ms);
    return;
  }
  // Reservoir sampling keeps percentiles useful for multi-hour runs without
  // retaining one latency record per request.
  const replacement = Math.floor(Math.random() * summary.successful);
  if (replacement < maxLatencySamples) summary.samples[replacement] = result.ms;
}

function formatSummary(summary) {
  return {
    requests: summary.requests,
    successful: summary.successful,
    failed: summary.failed,
    p50Ms: Number(percentile(summary.samples, 0.5).toFixed(1)),
    p95Ms: Number(percentile(summary.samples, 0.95).toFixed(1)),
    p99Ms: Number(percentile(summary.samples, 0.99).toFixed(1)),
    latencySamples: summary.samples.length,
    actualStrategies: summary.actualStrategies,
    backends: summary.backends,
  };
}

function peak(samples, select) {
  return Math.max(0, ...samples.map(select).filter(Number.isFinite));
}

function workerDelta(before, after) {
  const first = before ?? {};
  const last = after ?? {};
  return {
    launches: Math.max(0, (last.launches ?? 0) - (first.launches ?? 0)),
    crashes: Math.max(0, (last.crashes ?? 0) - (first.crashes ?? 0)),
    recycled: Math.max(0, (last.recycled ?? 0) - (first.recycled ?? 0)),
    replacements: Math.max(0, (last.replacements ?? 0) - (first.replacements ?? 0)),
  };
}

const before = await pressure();
const startedAt = new Date().toISOString();
const started = Date.now();
const deadline = durationSeconds === undefined ? undefined : started + durationSeconds * 1000;
const summaries = { http: createSummary(), browser: createSummary() };
const failures = [];
const memorySamples = [{ elapsedSeconds: 0, memory: before.memory, browserWorkers: workerSnapshot(before) }];
let next = 0;
let stoppedSampling = false;
let sampling = Promise.resolve();

const sample = () => {
  sampling = sampling.then(async () => {
    if (stoppedSampling) return;
    try {
      const snapshot = await pressure();
      memorySamples.push({
        elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        memory: snapshot.memory,
        browserWorkers: workerSnapshot(snapshot),
      });
    } catch (error) {
      if (failures.length < 20)
        failures.push({ kind: "sampling", ok: false, error: String(error) });
    }
  });
};
const sampler = setInterval(sample, sampleIntervalSeconds * 1000);

try {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (deadline === undefined ? next < requests : Date.now() < deadline) {
        const index = next++;
        const result = await run(index);
        record(summaries[result.kind], result);
        if (!result.ok && failures.length < 20) failures.push(result);
      }
    }),
  );
} finally {
  stoppedSampling = true;
  clearInterval(sampler);
  await sampling;
}

const after = await pressure();
const durationMs = Date.now() - started;
memorySamples.push({
  elapsedSeconds: Number((durationMs / 1000).toFixed(1)),
  memory: after.memory,
  browserWorkers: workerSnapshot(after),
});
const all = Object.values(summaries).reduce((total, summary) => total + summary.requests, 0);
const admissionAuthorities = [...new Set(memorySamples
  .map((sample) => sample.memory?.admissionAuthority)
  .filter(Boolean))];
const peakAdmissionRssMb = peak(memorySamples, (sample) => sample.memory?.rssMb);
const peakProcessTreeRssMb = peak(memorySamples, (sample) => sample.memory?.processTreeRssMb);
const peakContainerRssMb = peak(memorySamples, (sample) => sample.memory?.containerRssMb);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      target,
      targets,
      environment: {
        node: process.version,
        playwright: playwrightVersion,
        platform: process.platform,
        architecture: process.arch,
        commit: process.env.OPENBROWSE_BENCHMARK_COMMIT ?? process.env.GITHUB_SHA ?? "unrecorded",
        image: process.env.OPENBROWSE_BENCHMARK_IMAGE ?? "unrecorded",
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        hostMemoryMb: Number((os.totalmem() / 1024 / 1024).toFixed(1)),
        configuredMemorySoftMb: before.memory?.softLimitMb,
        configuredMemoryHardMb: before.memory?.hardLimitMb,
        browserEvery,
        sampleIntervalSeconds,
        maxLatencySamples,
      },
      mode: durationSeconds === undefined ? "requests" : "duration",
      ...(durationSeconds === undefined ? { requestedRequests: requests } : { requestedDurationSeconds: durationSeconds }),
      concurrency,
      durationMs,
      requestsPerSecond: Number((all / (durationMs / 1000)).toFixed(2)),
      workloads: { http: formatSummary(summaries.http), browser: formatSummary(summaries.browser) },
      memory: {
        before: before.memory,
        after: after.memory,
        samples: memorySamples,
        admissionAuthorities,
        peakAdmissionRssMb: Number(peakAdmissionRssMb.toFixed(1)),
        ...(peakProcessTreeRssMb ? { peakProcessTreeRssMb: Number(peakProcessTreeRssMb.toFixed(1)) } : {}),
        ...(peakContainerRssMb ? { peakContainerRssMb: Number(peakContainerRssMb.toFixed(1)) } : {}),
      },
      browserWorkers: { before: workerSnapshot(before), after: workerSnapshot(after) },
      workerTransitions: workerDelta(workerSnapshot(before), workerSnapshot(after)),
      failures,
    },
    null,
    2,
  ),
);

if (failures.length) process.exitCode = 1;

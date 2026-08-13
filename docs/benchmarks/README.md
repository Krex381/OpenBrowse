# Benchmark protocol

This protocol produces reproducible reliability evidence for the OpenBrowse
core: HTTP-first execution, controlled Chromium escalation, queue admission,
and browser-worker recovery. It is intentionally separate from optional
product interfaces such as BrowserQL, VNC, webhooks, and managed networking.

## Test environment

Run the suite in the deployment shape being evaluated. The reference profile
uses the checked-in Compose limits: 2 vCPU, a 2 GiB memory limit, 1 GiB shared
memory, a 256 MiB `/tmp` tmpfs, four request slots, and at most two Chromium
workers. Record every override beside the result.

Use a controlled, public test target that is allowed by its operator. It
should have a stable HTML response without rate limits, bot challenges, or
personal data. Do not point prolonged tests at a third-party news site or a
service that has not authorised the traffic.

## Runs

Set `OPENBROWSE_BENCHMARK_API_KEY` and
`OPENBROWSE_BENCHMARK_TARGET`, then run all three durations. `duration` mode
keeps submitting the normal 80% HTTP / 20% forced-browser workload until the
deadline, with a memory sample every 60 seconds by default.

```bash
for hours in 1 6 24; do
  OPENBROWSE_BENCHMARK_DURATION_SECONDS=$((hours * 3600)) \
    npm run benchmark:soak > "benchmark-${hours}h.json"
done
```

`OPENBROWSE_BENCHMARK_SAMPLE_INTERVAL_SECONDS` changes the sampling interval.
The runner caps retained latency samples with reservoir sampling, so a long run
does not itself consume unbounded memory.

The short Docker smoke in GitHub Actions validates that the resulting report
used cgroup admission and contains memory samples. It is a telemetry contract,
not a substitute for the 1 h / 6 h / 24 h runs above.

## Publication criteria

A published result must include the raw JSON, OpenBrowse commit SHA, container
limits, machine/host details, target description, and test date. Report:

| Field | Source |
| --- | --- |
| HTTP/browser mix and successful requests | `workloads` |
| p50/p95 latency | `workloads.*.p50Ms` and `p95Ms` |
| Peak and idle RSS | `memory.peakAdmissionRssMb`, `memory.samples`, and `memory.after` |
| Memory authority and RSS divergence | `memory.admissionAuthorities`, `peakContainerRssMb`, and `peakProcessTreeRssMb` |
| OOMs and browser recovery | container/runtime logs plus `browserWorkers.*.crashes` and `replacements` |
| Recycling activity | `workerTransitions.recycled` and `workerTransitions.replacements` |
| Request and sampling failures | `failures` |

Do not publish a capacity number when the report has failures that have not
been explained, missing memory samples, an unrecorded configuration, or a
target that changed behaviour during the run. This repository contains the
runner and protocol, not synthetic benchmark figures.

## Extraction corpus fidelity

Latency and worker health do not prove that extraction preserved the page. Run
an assertion-backed corpus of 100–500 pages across the content shapes you
support: news, documentation, blogs, product pages, and client-rendered apps.
Only include public pages that you own or are authorised to test; record a
stable, human-reviewed expectation for each one. The runner sends each page
through the deployed `/v1/fetch` `auto` path and fails if any page response or
assertion fails.

Start from [`extraction-corpus.example.json`](extraction-corpus.example.json),
copy it outside the repository if it contains private targets, and expand it
to the required corpus size:

```json
{
  "id": "product-page-017",
  "url": "https://www.example.com/product/017",
  "expect": {
    "markdownIncludes": ["Product name", "Specifications"],
    "markdownExcludes": ["Cookie settings"],
    "minimumMarkdownChars": 600,
    "minimumLinks": 3
  }
}
```

```bash
export OPENBROWSE_BENCHMARK_API_KEY="$OPENBROWSE_API_KEY"
export OPENBROWSE_CORPUS_FILE=/secure/path/extraction-corpus.json
export OPENBROWSE_CORPUS_CONCURRENCY=3
npm run benchmark:corpus > extraction-corpus-result.json
```

The default bounds enforce 100–500 pages. For a one-page wiring check only,
set `OPENBROWSE_CORPUS_MIN_PAGES=1`; do not treat that as fidelity evidence.
Publish the corpus revision, target authorisation, failed assertions, and raw
JSON with any extraction-quality claim. `pagePassRate` and
`assertionPassRate` measure the supplied checks; they are not a substitute for
human review of a sample from every content category.

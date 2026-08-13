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

## Publication criteria

A published result must include the raw JSON, OpenBrowse commit SHA, container
limits, machine/host details, target description, and test date. Report:

| Field | Source |
| --- | --- |
| HTTP/browser mix and successful requests | `workloads` |
| p50/p95 latency | `workloads.*.p50Ms` and `p95Ms` |
| Peak and idle RSS | `memory.samples` and `memory.after` |
| OOMs and browser recovery | container/runtime logs plus `browserWorkers.*.crashes` and `replacements` |
| Request and sampling failures | `failures` |

Do not publish a capacity number when the report has failures that have not
been explained, missing memory samples, an unrecorded configuration, or a
target that changed behaviour during the run. This repository contains the
runner and protocol, not synthetic benchmark figures.

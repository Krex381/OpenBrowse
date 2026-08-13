# Architecture

## Request lifecycle

Every authenticated request passes through API-key policy checks, rate limits,
target validation, cache lookup, and queue admission. The `auto` strategy uses
HTTP first. Sparse client-rendered responses can be escalated to a reusable
Chromium process, where each job receives an isolated browser context and
subresource URL validation. Auto-escalated pages use a bounded DOM-stability
observer before extraction (short observation period, 600 ms quiet window, 4 s maximum). It ignores small text-only
mutations such as live clocks; this does not
depend on network idle and is therefore safe for polling and WebSocket-heavy
applications. Callers can replace it with a typed wait condition such as a CSS
selector, delay, navigation state, network idle, or custom stability bounds.

## Storage and lifecycle

SQLite stores metadata in WAL mode. The filesystem backs artifacts and the
content-addressed cache. An in-memory LRU handles hot responses and identical
in-flight requests are coalesced. Browser processes recycle according to age,
job count, and per-worker process-tree RSS. Process-tree sums deliberately
remain a recycling signal: they include Chromium renderers and utility
processes even when their memory is shared. Queue admission has a different
authority: on Linux containers it uses the physical cgroup charge only when
the process has a finite cgroup memory limit. An unbounded host/parent cgroup
is not a workload envelope, so it falls back to the process-tree sum, then
Node RSS where `/proc` is unavailable. `/pressure` and `/metrics` expose both
the admission value and the process-tree diagnostic so a long soak can detect
divergence rather than hiding it.

## Deployment boundary

OpenBrowse is intentionally a single-node service. SQLite metadata, local
artifacts, the in-process admission queue, and live browser/session ownership
are local to one instance. Run one replica per independent workload or place
it behind a routing layer with explicit affinity; do not use round-robin
replicas for a single live session. Distributed queueing, shared artifact
storage, and cross-node session coordination are separate operator systems,
not implied by this deployment.

Persistent sessions store encrypted browser state. Replays and recordings are
authenticated artifacts. All retained resources are scoped to the API key that
created them.

## Runtime isolation

The Docker image runs as a non-root user with a read-only root filesystem,
bounded temporary storage, dropped capabilities, CPU/memory/PID limits, and
the bundled seccomp profile. Chromium keeps its sandbox enabled. The profile
allows the `chroot` call required after Chromium has entered its own user
namespace; it does not grant a host capability to the container.

Application-level SSRF validation is a defense in depth measure. Operators
must provide a DNS-aware egress proxy or firewall for production workloads.
Lighthouse and raw browser protocols use navigation paths that cannot share
the normal interception layer, so they remain disabled unless deployed in an
isolated worker environment.

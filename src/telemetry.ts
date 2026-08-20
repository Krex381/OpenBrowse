import {
  browserBackendIds,
  type BrowserBackendId,
  type PlannerReason,
} from "./execution.js";

type FetchObservation = {
  cacheHit: boolean;
  strategy: "http" | "browser";
  plannerReason: PlannerReason;
  backend?: BrowserBackendId;
};

const fetches = new Map<string, number>();
const increment = (key: string) => fetches.set(key, (fetches.get(key) ?? 0) + 1);

/** Low-cardinality process metrics; URLs, tenants, and secrets are never labels. */
export function recordFetchObservation(observation: FetchObservation): void {
  increment(`cache:${observation.cacheHit ? "hit" : "miss"}`);
  increment(`strategy:${observation.strategy}`);
  increment(`planner:${observation.plannerReason}`);
  if (observation.backend) increment(`backend:${observation.backend}`);
}

export function executionMetrics(): string {
  const lines: string[] = [];
  for (const outcome of ["hit", "miss"])
    lines.push(`openbrowse_fetch_cache_total{outcome="${outcome}"} ${fetches.get(`cache:${outcome}`) ?? 0}`);
  for (const strategy of ["http", "browser"])
    lines.push(`openbrowse_fetch_strategy_total{strategy="${strategy}"} ${fetches.get(`strategy:${strategy}`) ?? 0}`);
  for (const reason of [
    "explicit-http",
    "explicit-browser",
    "auto-http-first",
    "client-rendered-shell",
    "http-content-sufficient",
    "http-status-terminal",
    "non-html-response",
    "persistent-session",
    "browser-capacity-unavailable",
  ])
    lines.push(`openbrowse_execution_plan_total{reason="${reason}"} ${fetches.get(`planner:${reason}`) ?? 0}`);
  for (const backend of browserBackendIds)
    lines.push(
      `openbrowse_browser_backend_total{backend="${backend}"} ${fetches.get(`backend:${backend}`) ?? 0}`,
    );
  return `${lines.join("\n")}\n`;
}

import type {
  BrowserBackendId,
  ClientRenderAnalysis,
  ExecutionPlan,
  FetchInput,
} from "./types.js";
import type { DomainObservation } from "./domain-observations.js";
import { config } from "../config.js";

const standardBackend: BrowserBackendId = config.defaultBrowserBackend;

/** Pure, deterministic planning. Runtime escalation is recorded separately. */
export function planExecution(
  input: FetchInput,
  options: {
    cacheEligible?: boolean;
    cacheReason?: ExecutionPlan["cacheEligibility"]["reason"];
    browserAvailable?: boolean;
    domainObservation?: DomainObservation;
  } = {},
): ExecutionPlan {
  const strategy = input.strategy ?? "auto";
  const cacheEligible = options.cacheEligible ?? true;
  const cacheEligibility = {
    eligible: cacheEligible,
    reason:
      options.cacheReason ??
      (cacheEligible ? "public-request" : "private-request-headers"),
  } as const;
  const historySignal = options.domainObservation
    ? `domain-history:samples=${options.domainObservation.samples},shell-ratio=${options.domainObservation.shellRatio}`
    : undefined;
  if (strategy === "http")
    return {
      strategy: "HTTP",
      requestedStrategy: strategy,
      stages: ["http"],
      reason: "explicit-http",
      attemptBudget: 1,
      estimatedMemoryMb: 16,
      estimatedCost: { units: 1, basis: "http" },
      cacheEligible,
      cacheEligibility,
      browserRequired: false,
      signals: ["caller-requested-http", ...(historySignal ? [historySignal] : [])],
    };
  if (strategy === "browser")
    return {
      strategy: "BROWSER",
      requestedStrategy: strategy,
      stages: ["browser"],
      browserBackend: input.browserBackend ?? standardBackend,
      reason: "explicit-browser",
      attemptBudget: 1,
      estimatedMemoryMb: 256,
      estimatedCost: { units: 10, basis: "browser" },
      cacheEligible,
      cacheEligibility,
      browserRequired: true,
      signals: ["caller-requested-browser", ...(historySignal ? [historySignal] : [])],
    };
  return {
    strategy: "HTTP_THEN_BROWSER",
    requestedStrategy: strategy,
    stages: options.browserAvailable === false ? ["http"] : ["http", "browser"],
    browserBackend: input.browserBackend ?? standardBackend,
    reason:
      options.browserAvailable === false
        ? "browser-capacity-unavailable"
        : "auto-http-first",
    attemptBudget: options.browserAvailable === false ? 1 : 2,
    estimatedMemoryMb: 16,
    estimatedCost: {
      units:
        options.domainObservation && options.domainObservation.shellRatio >= 0.8
          ? 3
          : 1,
      basis: "http",
    },
    cacheEligible,
    cacheEligibility,
    browserRequired: false,
    signals: ["auto-prefers-http", ...(historySignal ? [historySignal] : [])],
  };
}

export function resolvedPlan(
  plan: ExecutionPlan,
  analysis: ClientRenderAnalysis,
): ExecutionPlan {
  if (!analysis.browserRecommended)
    return {
      ...plan,
      strategy: "HTTP",
      stages: ["http"],
      reason: analysis.reason,
      attemptBudget: 1,
      browserRequired: false,
      signals: [
        ...plan.signals.filter((signal) => signal.startsWith("domain-history:")),
        ...analysis.signals,
      ],
    };
  return {
    ...plan,
    reason: analysis.reason,
    estimatedMemoryMb: 256,
    estimatedCost: { units: 10, basis: "browser" },
    browserRequired: true,
    signals: [
      ...plan.signals.filter((signal) => signal.startsWith("domain-history:")),
      ...analysis.signals,
    ],
  };
}

export function planPersistentSession(input: {
  persistent: boolean;
  profile: boolean;
  liveViewer: boolean;
}): ExecutionPlan {
  return {
    strategy: "PERSISTENT_SESSION",
    requestedStrategy: "session",
    stages: ["browser"],
    browserBackend: standardBackend,
    reason: "persistent-session",
    attemptBudget: 1,
    estimatedMemoryMb: 256,
    estimatedCost: { units: 10, basis: "browser" },
    cacheEligible: false,
    cacheEligibility: { eligible: false, reason: "caller-disabled" },
    browserRequired: true,
    signals: [
      input.persistent ? "storage-state-retained" : "ephemeral-session",
      ...(input.profile ? ["profile-state-loaded"] : []),
      ...(input.liveViewer ? ["headed-live-viewer"] : []),
    ],
  };
}

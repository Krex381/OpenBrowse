import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import type { BrowserPool } from "./pool.js";
import type {
  BrowserBackendId,
  BrowserBackendOptions,
  FetchInput,
} from "./types.js";
import {
  browserBackendCapability,
  estimatedBrowserMemoryMb,
} from "./backends.js";

export interface ChallengeFallbackResult<T> {
  value: T;
  backendAttempts: BrowserBackendId[];
  selectedBackend: BrowserBackendId;
  challengeRemaining: boolean;
}

export function challengeFallbackBackends(
  preferred: BrowserBackendId,
): BrowserBackendId[] {
  return [
    preferred,
    "patchright-chromium" as const,
    "clearcote-chromium" as const,
    "camoufox-firefox" as const,
    "cloakbrowser-chromium" as const,
  ].filter(
    (backend, index, all): backend is BrowserBackendId =>
      config.enabledBrowserBackends.has(backend) &&
      all.indexOf(backend) === index,
  );
}

/** Runs each enabled backend at most once and never loops on a challenge. */
export async function runChallengeFallback<T>(
  pool: BrowserPool,
  input: FetchInput,
  preferred: BrowserBackendId,
  attempt: (
    backend: BrowserBackendId,
    options: BrowserBackendOptions | undefined,
  ) => Promise<{ value: T; challengeDetected: boolean }>,
  requiredCapability?: "screenshots" | "recordings" | "pdf" | "downloads",
): Promise<ChallengeFallbackResult<T>> {
  const backendAttempts: BrowserBackendId[] = [];
  let lastChallenge:
    | { value: T; selectedBackend: BrowserBackendId }
    | undefined;
  let lastUnavailable: OpenBrowseError | undefined;

  for (const backend of challengeFallbackBackends(preferred)) {
    if (
      requiredCapability &&
      !browserBackendCapability(backend)[requiredCapability]
    )
      continue;
    const options =
      backend === "cloakbrowser-chromium" ||
      backend === "camoufox-firefox" ||
      backend === "clearcote-chromium"
        ? input.browserOptions
        : undefined;
    const admission = await pool.browserAdmission(
      estimatedBrowserMemoryMb(backend),
      backend,
      options,
    );
    if (!admission.allowed) {
      lastUnavailable = new OpenBrowseError(
        "MEMORY_PRESSURE",
        admission.reason === "soft-pressure-no-launch"
          ? "Browser execution requires a new worker while the service is under memory pressure"
          : "Browser execution cannot fit within the configured memory reserve",
        503,
        true,
        { admission, backend },
      );
      continue;
    }

    backendAttempts.push(backend);
    try {
      const result = await attempt(backend, options);
      if (!result.challengeDetected)
        return {
          value: result.value,
          backendAttempts,
          selectedBackend: backend,
          challengeRemaining: false,
        };
      lastChallenge = { value: result.value, selectedBackend: backend };
    } catch (error) {
      if (
        error instanceof OpenBrowseError &&
        error.code === "BROWSER_BACKEND_UNAVAILABLE"
      ) {
        lastUnavailable = error;
        continue;
      }
      throw error;
    }
  }

  if (lastChallenge)
    return {
      value: lastChallenge.value,
      backendAttempts,
      selectedBackend: lastChallenge.selectedBackend,
      challengeRemaining: true,
    };

  throw (
    lastUnavailable ??
    new OpenBrowseError(
      "BROWSER_BACKEND_DISABLED",
      "No configured browser backend is available",
      409,
    )
  );
}

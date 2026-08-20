import type { BrowserPool } from "./pool.js";
import type { BrowserBackendId, FetchInput, FetchResult } from "./types.js";
import { config } from "../config.js";
import { assertBrowserBackendEnabled } from "./browser-launchers.js";

export interface BrowserBackendCapabilities {
  id: BrowserBackendId;
  engine: "chromium" | "firefox";
  playwright: boolean;
  cdp: boolean;
  persistentContexts: boolean;
  profiles: boolean;
  cookiesAndStorage: boolean;
  supportsProxy: boolean;
  downloads: boolean;
  screenshots: boolean;
  recordings: boolean;
  pdf: boolean;
  supportsPersistentPool: boolean;
  supportsExtensions: boolean;
  processPidVisibility: boolean;
  processTreeMemoryAccounting: boolean;
  chromiumSandboxCompatible: boolean;
  headless: boolean;
  headed: boolean;
  platforms: readonly ("linux" | "windows" | "macos")[];
  license:
    | "Apache-2.0"
    | "BSD-3-Clause"
    | "MPL-2.0"
    | "MIT-wrapper/proprietary-binary";
  stealthPatched: boolean;
  acceptsFingerprintOptions: boolean;
  acceptsHumanizationOptions: boolean;
  operatorLicenseRequired: boolean;
}

export interface BrowserBackend {
  capabilities: BrowserBackendCapabilities;
  render(
    pool: BrowserPool,
    input: FetchInput,
    options?: { defaultStability?: boolean },
  ): Promise<Omit<FetchResult, "strategy" | "attempted" | "fetchMs">>;
  health(pool: BrowserPool): BrowserBackendHealth;
}

export interface BrowserBackendHealth {
  id: BrowserBackendId;
  state: "healthy" | "degraded" | "unavailable";
  processes: number;
  capacity: number;
  failures: number;
  crashes: number;
}

export const playwrightChromiumCapabilities: BrowserBackendCapabilities = {
  id: "playwright-chromium",
  engine: "chromium",
  playwright: true,
  cdp: true,
  persistentContexts: true,
  profiles: true,
  cookiesAndStorage: true,
  supportsProxy: true,
  downloads: true,
  screenshots: true,
  recordings: true,
  pdf: true,
  supportsPersistentPool: true,
  supportsExtensions: true,
  processPidVisibility: true,
  processTreeMemoryAccounting: true,
  chromiumSandboxCompatible: true,
  headless: true,
  headed: true,
  platforms: ["linux", "windows", "macos"],
  license: "Apache-2.0",
  stealthPatched: false,
  acceptsFingerprintOptions: false,
  acceptsHumanizationOptions: false,
  operatorLicenseRequired: false,
};

export const patchrightChromiumCapabilities: BrowserBackendCapabilities = {
  ...playwrightChromiumCapabilities,
  id: "patchright-chromium",
  stealthPatched: true,
};

export const cloakBrowserChromiumCapabilities: BrowserBackendCapabilities = {
  ...playwrightChromiumCapabilities,
  id: "cloakbrowser-chromium",
  license: "MIT-wrapper/proprietary-binary",
  stealthPatched: true,
  acceptsFingerprintOptions: true,
  acceptsHumanizationOptions: true,
  operatorLicenseRequired: true,
};

export const camoufoxFirefoxCapabilities: BrowserBackendCapabilities = {
  ...playwrightChromiumCapabilities,
  id: "camoufox-firefox",
  engine: "firefox",
  cdp: false,
  profiles: false,
  pdf: false,
  supportsExtensions: false,
  chromiumSandboxCompatible: false,
  license: "MPL-2.0",
  stealthPatched: true,
  acceptsFingerprintOptions: true,
  acceptsHumanizationOptions: true,
  operatorLicenseRequired: false,
};

export const clearcoteChromiumCapabilities: BrowserBackendCapabilities = {
  ...playwrightChromiumCapabilities,
  id: "clearcote-chromium",
  license: "BSD-3-Clause",
  stealthPatched: true,
  acceptsFingerprintOptions: true,
  acceptsHumanizationOptions: false,
  operatorLicenseRequired: false,
};

export const browserBackendCapabilities = [
  playwrightChromiumCapabilities,
  patchrightChromiumCapabilities,
  cloakBrowserChromiumCapabilities,
  camoufoxFirefoxCapabilities,
  clearcoteChromiumCapabilities,
] as const;

export function estimatedBrowserMemoryMb(id: BrowserBackendId): number {
  if (id === "camoufox-firefox") return 384;
  if (id === "cloakbrowser-chromium" || id === "clearcote-chromium")
    return 320;
  return 256;
}

export function browserBackendCapability(
  id: BrowserBackendId,
): BrowserBackendCapabilities {
  const capability = browserBackendCapabilities.find((entry) => entry.id === id);
  if (!capability) throw new Error(`Unknown browser backend '${id}'`);
  return capability;
}

export function browserBackendCatalog(): Array<
  BrowserBackendCapabilities & { enabled: boolean; default: boolean }
> {
  return browserBackendCapabilities.map((capability) => ({
    ...capability,
    enabled: config.enabledBrowserBackends.has(capability.id),
    default: capability.id === config.defaultBrowserBackend,
  }));
}

export interface BrowserBackendDecision {
  preferred: BrowserBackendId;
  selected: BrowserBackendId;
  fallbackCandidates: BrowserBackendId[];
  reason: "requested-supported-backend" | "default-compatible-backend";
  estimatedMemoryMb: number;
}

/** Capability/cost decision point; no backend is selected by hostname or magic. */
export function selectBrowserBackend(input: FetchInput): BrowserBackendDecision {
  const selected = input.browserBackend ?? config.defaultBrowserBackend;
  assertBrowserBackendEnabled(selected);
  return {
    preferred: config.defaultBrowserBackend,
    selected,
    fallbackCandidates: [],
    reason: input.browserBackend
      ? "requested-supported-backend"
      : "default-compatible-backend",
    estimatedMemoryMb: estimatedBrowserMemoryMb(selected),
  };
}

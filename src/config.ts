import { apiKeyPolicies } from "./config/policies.js";
import {
  bool,
  corsOrigins,
  extensionDirs,
  externalAddress,
  int,
} from "./config/environment.js";
import { resolve } from "node:path";
import {
  browserBackendIds,
  type BrowserBackendId,
} from "./execution/types.js";
export type { ApiKeyPolicy } from "./config/policies.js";

const configuredPolicies = apiKeyPolicies();
function configuredBrowserBackends(): ReadonlySet<BrowserBackendId> {
  const raw = process.env.OPENBROWSE_BROWSER_BACKENDS ??
    "playwright-chromium,patchright-chromium";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const allowed = new Set<string>(browserBackendIds);
  for (const value of values)
    if (!allowed.has(value))
      throw new Error(
        `OPENBROWSE_BROWSER_BACKENDS contains unsupported backend '${value}'`,
      );
  if (values.length === 0)
    throw new Error("OPENBROWSE_BROWSER_BACKENDS must enable at least one backend");
  return new Set(values as BrowserBackendId[]);
}
const enabledBrowserBackends = configuredBrowserBackends();
const defaultBrowserBackend = (process.env.OPENBROWSE_DEFAULT_BROWSER_BACKEND ??
  "playwright-chromium") as BrowserBackendId;
export const config = {
  host: process.env.OPENBROWSE_HOST ?? "0.0.0.0",
  port: int("OPENBROWSE_PORT", 3000, 1, 65535),
  externalUrl: externalAddress(),
  corsAllowedOrigins: corsOrigins(),
  apiKeys: new Set([
    ...(process.env.OPENBROWSE_API_KEYS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...configuredPolicies.keys,
  ]),
  apiKeyPolicies: configuredPolicies.policies,
  dataDir: resolve(process.env.OPENBROWSE_DATA_DIR ?? "./data"),
  maxConcurrency: int("OPENBROWSE_MAX_CONCURRENCY", 4, 1, 100),
  browserPoolMin: int("OPENBROWSE_BROWSER_POOL_MIN", 0, 0, 20),
  browserPoolMax: int("OPENBROWSE_BROWSER_POOL_MAX", 2, 1, 20),
  browserContextsPerWorker: int(
    "OPENBROWSE_BROWSER_CONTEXTS_PER_WORKER",
    4,
    1,
    20,
  ),
  browserWorkerFailureLimit: int(
    "OPENBROWSE_BROWSER_WORKER_FAILURE_LIMIT",
    3,
    1,
    100,
  ),
  browserLaunchBackoffMs: int(
    "OPENBROWSE_BROWSER_LAUNCH_BACKOFF_MS",
    1000,
    100,
    60000,
  ),
  browserLaunchTimeoutMs: int(
    "OPENBROWSE_BROWSER_LAUNCH_TIMEOUT_MS",
    60000,
    1000,
    300000,
  ),
  browserHeadless: bool("OPENBROWSE_BROWSER_HEADLESS", true),
  memorySoftMb: int("OPENBROWSE_MEMORY_SOFT_MB", 1536, 64, 1048576),
  memoryHardMb: int("OPENBROWSE_MEMORY_HARD_MB", 1900, 64, 1048576),
  memoryReserveMb: int("OPENBROWSE_MEMORY_RESERVE_MB", 256, 0, 1048576),
  browserMaxJobs: int("OPENBROWSE_BROWSER_MAX_JOBS", 200, 1, 100000),
  browserMaxAgeMs: int(
    "OPENBROWSE_BROWSER_MAX_AGE_MS",
    1800000,
    1000,
    86400000,
  ),
  browserRecycleRssMb: int(
    "OPENBROWSE_BROWSER_RECYCLE_RSS_MB",
    900,
    64,
    1048576,
  ),
  queueMax: int("OPENBROWSE_QUEUE_MAX", 100, 0, 100000),
  jobTimeoutMs: int("OPENBROWSE_JOB_TIMEOUT_MS", 30000, 100, 300000),
  pageMax: int("OPENBROWSE_PAGE_MAX", 4, 1, 20),
  cacheMemoryBytes:
    int("OPENBROWSE_CACHE_MEMORY_MB", 64, 1, 4096) * 1024 * 1024,
  cacheDiskBytes:
    int("OPENBROWSE_CACHE_DISK_MB", 2048, 1, 1048576) * 1024 * 1024,
  maxResponseBytes: int(
    "OPENBROWSE_MAX_RESPONSE_BYTES",
    10485760,
    1024,
    1073741824,
  ),
  encryptionKey: process.env.OPENBROWSE_ENCRYPTION_KEY ?? "",
  searchEndpoint: process.env.OPENBROWSE_SEARCH_ENDPOINT ?? "",
  queueAlertUrl: process.env.OPENBROWSE_QUEUE_ALERT_URL ?? "",
  rejectAlertUrl: process.env.OPENBROWSE_REJECT_ALERT_URL ?? "",
  timeoutAlertUrl: process.env.OPENBROWSE_TIMEOUT_ALERT_URL ?? "",
  errorAlertUrl: process.env.OPENBROWSE_ERROR_ALERT_URL ?? "",
  failedHealthUrl: process.env.OPENBROWSE_FAILED_HEALTH_URL ?? "",
  dailyRequestLimit: int("OPENBROWSE_DAILY_REQUEST_LIMIT", 0, 0, 100000000),
  maxSessionTtlSeconds: int(
    "OPENBROWSE_MAX_SESSION_TTL_SECONDS",
    86400,
    60,
    7776000,
  ),
  allowClientLaunchOptions: bool(
    "OPENBROWSE_ALLOW_CLIENT_LAUNCH_OPTIONS",
    false,
  ),
  // Chromium sandboxing is required by default. Local Windows development and
  // test environments may explicitly opt out when the operating system cannot
  // provide the namespaces that Chromium requires.
  chromiumSandbox: bool("OPENBROWSE_CHROMIUM_SANDBOX", true),
  // Lighthouse controls its own navigation stack and therefore cannot use the
  // request interception that protects normal browser execution. It is opt-in
  // only for deployments with separately enforced browser-worker egress.
  lighthouseEnabled: bool("OPENBROWSE_LIGHTHOUSE_ENABLED", false),
  rawBrowserProtocolBridges: bool("OPENBROWSE_RAW_BROWSER_PROTOCOL_BRIDGES", false),
  cachePurgeEnabled: bool("OPENBROWSE_CACHE_PURGE_ENABLED", false),
  egressProxyUrl: process.env.OPENBROWSE_EGRESS_PROXY_URL ?? "",
  chromiumExtensionDirs: extensionDirs(),
  vncBridgeUrl: process.env.OPENBROWSE_VNC_BRIDGE_URL ?? "",
  enabledBrowserBackends,
  defaultBrowserBackend,
  cloakBrowserLicenseAccepted: bool(
    "OPENBROWSE_CLOAKBROWSER_LICENSE_ACCEPTED",
    false,
  ),
  clearcoteExecutablePath:
    process.env.OPENBROWSE_CLEARCOTE_EXECUTABLE_PATH?.trim() ?? "",
} as const;
export const chromiumExtensionArgs =
  config.chromiumExtensionDirs.length === 0
    ? []
    : [
        `--disable-extensions-except=${config.chromiumExtensionDirs.join(",")}`,
        `--load-extension=${config.chromiumExtensionDirs.join(",")}`,
      ];
if (config.memoryHardMb <= config.memoryReserveMb)
  throw new Error(
    "OPENBROWSE_MEMORY_HARD_MB must exceed OPENBROWSE_MEMORY_RESERVE_MB",
  );
if (config.browserPoolMin > config.browserPoolMax)
  throw new Error(
    "OPENBROWSE_BROWSER_POOL_MIN must not exceed OPENBROWSE_BROWSER_POOL_MAX",
  );
if (!browserBackendIds.includes(config.defaultBrowserBackend))
  throw new Error(
    "OPENBROWSE_DEFAULT_BROWSER_BACKEND must name a supported backend",
  );
if (!config.enabledBrowserBackends.has(config.defaultBrowserBackend))
  throw new Error(
    "OPENBROWSE_DEFAULT_BROWSER_BACKEND must also be enabled by OPENBROWSE_BROWSER_BACKENDS",
  );
if (
  config.enabledBrowserBackends.has("cloakbrowser-chromium") &&
  !config.cloakBrowserLicenseAccepted
)
  throw new Error(
    "OPENBROWSE_CLOAKBROWSER_LICENSE_ACCEPTED=true is required before enabling CloakBrowser; operators are responsible for the applicable binary and OEM/SaaS license",
  );
if (config.apiKeys.size === 0)
  throw new Error(
    "OPENBROWSE_API_KEYS or OPENBROWSE_API_KEY_POLICIES must define at least one API key",
  );
if (config.encryptionKey.length < 32)
  throw new Error(
    "OPENBROWSE_ENCRYPTION_KEY must be at least 32 characters",
  );
if (config.egressProxyUrl) {
  const proxy = new URL(config.egressProxyUrl);
  if (!/^https?:$/.test(proxy.protocol))
    throw new Error("OPENBROWSE_EGRESS_PROXY_URL must use http or https");
}

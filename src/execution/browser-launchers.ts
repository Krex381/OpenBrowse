import {
  chromium as playwrightChromium,
  type Browser,
  type BrowserServer,
  type LaunchOptions,
} from "playwright";
import { createHmac } from "node:crypto";
import { chromiumExtensionArgs, config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import type {
  BrowserBackendId,
  BrowserBackendOptions,
} from "./types.js";

export interface LaunchedBrowserWorker {
  backend: BrowserBackendId;
  browser: Browser;
  server: BrowserServer;
  pid: number;
  profileKey: string;
}

export function browserProfileKey(
  backend: BrowserBackendId,
  options?: BrowserBackendOptions,
): string {
  if (backend === "clearcote-chromium")
    return JSON.stringify({
      backend,
      fingerprintArgs: options?.fingerprintArgs ?? [],
    });
  if (backend === "camoufox-firefox")
    return JSON.stringify({
      backend,
      ...resolvedCamoufoxOptions(options),
    });
  if (backend !== "cloakbrowser-chromium") return backend;
  const humanConfig = Object.fromEntries(
    Object.entries(options?.humanConfig ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return JSON.stringify({
    backend,
    fingerprintArgs: options?.fingerprintArgs ?? [],
    humanize: options?.humanize ?? true,
    humanPreset: options?.humanPreset ?? "default",
    humanConfig,
  });
}

function hostCamoufoxOs(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function resolvedCamoufoxOptions(options?: BrowserBackendOptions): {
  os: "windows" | "macos" | "linux";
  locale?: string | string[];
  humanize: boolean | number;
  blockImages: boolean;
  blockWebrtc: boolean;
  enableCache: boolean;
} {
  const camoufox = options?.camoufox;
  return {
    os: camoufox?.os ?? hostCamoufoxOs(),
    ...(camoufox?.locale === undefined ? {} : { locale: camoufox.locale }),
    humanize: camoufox?.humanize ?? true,
    blockImages: camoufox?.blockImages ?? false,
    blockWebrtc: camoufox?.blockWebrtc ?? false,
    enableCache: camoufox?.enableCache ?? false,
  };
}

function clearcoteProfileEncryptionKey(): string {
  return createHmac("sha256", config.encryptionKey)
    .update("openbrowse/clearcote/profile-encryption-key/v1")
    .digest("hex");
}

export function redactBrowserLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(
      /--profile-encryption-key(?:=|\s+)[^\s"']+/giu,
      "--profile-encryption-key=[REDACTED]",
    )
    .replace(
      /((?:https?|socks5):\/\/)[^\s/@:]+:[^\s/@]+@/giu,
      "$1[REDACTED]@",
    );
}

export function assertBrowserBackendEnabled(backend: BrowserBackendId): void {
  if (!config.enabledBrowserBackends.has(backend))
    throw new OpenBrowseError(
      "BROWSER_BACKEND_DISABLED",
      `Browser backend '${backend}' is disabled by the operator`,
      409,
      false,
      { enabledBackends: [...config.enabledBrowserBackends] },
    );
  if (
    backend === "cloakbrowser-chromium" &&
    !config.cloakBrowserLicenseAccepted
  )
    throw new OpenBrowseError(
      "BROWSER_BACKEND_LICENSE_REQUIRED",
      "CloakBrowser requires explicit operator license acceptance",
      409,
    );
}

async function connectServer(
  backend: BrowserBackendId,
  server: BrowserServer,
  connect: (endpoint: string) => Promise<unknown>,
  options?: BrowserBackendOptions,
): Promise<LaunchedBrowserWorker> {
  let browser: Browser;
  try {
    browser = (await connect(server.wsEndpoint())) as Browser;
    if (backend === "cloakbrowser-chromium" && (options?.humanize ?? true)) {
      const cloak = await import("cloakbrowser");
      type HumanizeOptions = NonNullable<
        Parameters<typeof cloak.humanizeBrowser>[1]
      >;
      await cloak.humanizeBrowser(
        browser as unknown as Parameters<typeof cloak.humanizeBrowser>[0],
        {
        humanize: true,
        humanPreset: options?.humanPreset ?? "default",
        ...(options?.humanConfig
          ? {
              humanConfig:
                options.humanConfig as unknown as HumanizeOptions["humanConfig"],
            }
          : {}),
        },
      );
    }
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  const pid = server.process().pid;
  if (!pid) {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw new Error("Browser server did not expose a process PID");
  }
  return {
    backend,
    browser,
    server,
    pid,
    profileKey: browserProfileKey(backend, options),
  };
}

export async function launchBrowserWorker(
  backend: BrowserBackendId,
  options?: BrowserBackendOptions,
  runtime: { headless?: boolean } = {},
): Promise<LaunchedBrowserWorker> {
  assertBrowserBackendEnabled(backend);
  const headless = runtime.headless ?? config.browserHeadless;
  if (backend === "playwright-chromium") {
    const server = await playwrightChromium.launchServer({
      headless,
      chromiumSandbox: config.chromiumSandbox,
      args: chromiumExtensionArgs,
      timeout: config.browserLaunchTimeoutMs,
    });
    return connectServer(
      backend,
      server,
      (endpoint) =>
        playwrightChromium.connect(endpoint, {
          timeout: config.browserLaunchTimeoutMs,
        }),
      options,
    );
  }
  if (backend === "patchright-chromium") {
    try {
      const patchright = await import("patchright");
      const patchrightServer = await patchright.chromium.launchServer({
        headless,
        executablePath: playwrightChromium.executablePath(),
        chromiumSandbox: config.chromiumSandbox,
        args: chromiumExtensionArgs,
        timeout: config.browserLaunchTimeoutMs,
      });
      return connectServer(
        backend,
        patchrightServer as unknown as BrowserServer,
        (endpoint) =>
          patchright.chromium.connect(endpoint, {
            timeout: config.browserLaunchTimeoutMs,
          }),
        options,
      );
    } catch (error) {
      if (error instanceof OpenBrowseError) throw error;
      throw new OpenBrowseError(
        "BROWSER_BACKEND_UNAVAILABLE",
        "Patchright could not launch with the installed Playwright Chromium binary",
        503,
        true,
        { cause: redactBrowserLaunchError(error) },
      );
    }
  }
  if (backend === "camoufox-firefox") {
    try {
      const camoufox = await import("camoufox-js");
      const camoufoxPlaywright = await import("playwright-core");
      const resolved = resolvedCamoufoxOptions(options);
      const server = await camoufox.launchServer({
        headless,
        os: resolved.os,
        humanize: resolved.humanize,
        ...(resolved.locale === undefined ? {} : { locale: resolved.locale }),
        block_images: resolved.blockImages,
        block_webrtc: resolved.blockWebrtc,
        enable_cache: resolved.enableCache,
        timeout: config.browserLaunchTimeoutMs,
      });
      return connectServer(
        backend,
        server as unknown as BrowserServer,
        async (endpoint) =>
          (await camoufoxPlaywright.firefox.connect(endpoint, {
            timeout: config.browserLaunchTimeoutMs,
          })) as unknown as Browser,
        options,
      );
    } catch (error) {
      if (error instanceof OpenBrowseError) throw error;
      throw new OpenBrowseError(
        "BROWSER_BACKEND_UNAVAILABLE",
        "Camoufox could not launch; provision its verified browser with 'npm run prepare:camoufox' and CAMOUFOX_INSTALL_DIR when using a custom data path",
        503,
        true,
        { cause: redactBrowserLaunchError(error) },
      );
    }
  }
  if (backend === "clearcote-chromium") {
    if (!config.clearcoteExecutablePath)
      throw new OpenBrowseError(
        "BROWSER_BACKEND_UNAVAILABLE",
        "Clearcote requires OPENBROWSE_CLEARCOTE_EXECUTABLE_PATH to point at an operator-verified browser binary",
        503,
        true,
      );
    try {
      const server = await playwrightChromium.launchServer({
        headless,
        executablePath: config.clearcoteExecutablePath,
        chromiumSandbox: config.chromiumSandbox,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          ...chromiumExtensionArgs,
          `--profile-encryption-key=${clearcoteProfileEncryptionKey()}`,
          ...(options?.fingerprintArgs ?? []),
        ],
        timeout: config.browserLaunchTimeoutMs,
      });
      return connectServer(
        backend,
        server,
        (endpoint) =>
          playwrightChromium.connect(endpoint, {
            timeout: config.browserLaunchTimeoutMs,
          }),
        options,
      );
    } catch (error) {
      if (error instanceof OpenBrowseError) throw error;
      throw new OpenBrowseError(
        "BROWSER_BACKEND_UNAVAILABLE",
        "Clearcote could not launch its operator-managed browser binary",
        503,
        true,
        { cause: redactBrowserLaunchError(error) },
      );
    }
  }
  try {
    const cloak = await import("cloakbrowser");
    const launchOptions = await cloak.buildLaunchOptions({
      headless,
      args: [
        ...chromiumExtensionArgs,
        ...(options?.fingerprintArgs ?? []),
      ],
      humanize: options?.humanize ?? true,
      humanPreset: options?.humanPreset ?? "default",
      launchOptions: {
        chromiumSandbox: config.chromiumSandbox,
        timeout: config.browserLaunchTimeoutMs,
      },
    });
    const server = await playwrightChromium.launchServer(
      launchOptions as LaunchOptions,
    );
    return connectServer(
      backend,
      server,
      (endpoint) =>
        playwrightChromium.connect(endpoint, {
          timeout: config.browserLaunchTimeoutMs,
        }),
      options,
    );
  } catch (error) {
    if (error instanceof OpenBrowseError) throw error;
    throw new OpenBrowseError(
      "BROWSER_BACKEND_UNAVAILABLE",
      "CloakBrowser could not resolve or launch its operator-managed binary",
      503,
      true,
      { cause: redactBrowserLaunchError(error) },
    );
  }
}

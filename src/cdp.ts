import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { chromiumExtensionArgs, config } from "./config.js";
import { OpenBrowseError } from "./errors.js";

export interface CdpBrowser {
  endpoint: string;
  stop(): Promise<void>;
}
export interface SafeLaunchOptions {
  args?: string[];
  headless?: boolean;
  slowMo?: number;
  acceptInsecureCerts?: boolean;
}

async function waitForEndpoint(
  profile: string,
  context: BrowserContext,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!context.browser()?.isConnected())
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Chromium exited before exposing its CDP endpoint",
        422,
      );
    try {
      const [port, path] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      if (
        port &&
        path &&
        /^\d+$/.test(port) &&
        path.startsWith("/devtools/browser/")
      )
        return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Chromium has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new OpenBrowseError(
    "RENDER_FAILED",
    "Timed out waiting for Chromium CDP endpoint",
    422,
    true,
  );
}

/** Launch through Playwright so its supported Chromium arguments remain intact. */
export async function launchCdpBrowser(
  timeoutMs: number,
  launch: SafeLaunchOptions = {},
): Promise<CdpBrowser> {
  const profile = await mkdtemp(join(tmpdir(), "openbrowse-cdp-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: launch.headless ?? true,
      chromiumSandbox: config.chromiumSandbox,
      ...(launch.slowMo !== undefined ? { slowMo: launch.slowMo } : {}),
      ...(launch.acceptInsecureCerts !== undefined
        ? { ignoreHTTPSErrors: launch.acceptInsecureCerts }
        : {}),
      args: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        ...(config.chromiumExtensionDirs.length === 0
          ? [
              "--disable-extensions",
              "--disable-component-extensions-with-background-pages",
            ]
          : chromiumExtensionArgs),
        "--disable-background-networking",
        "--disable-features=MediaRouter,OptimizationHints",
        ...(launch.args ?? []),
      ],
    });
    const endpoint = await waitForEndpoint(profile, context);
    const killTimer = setTimeout(() => {
      void context?.close();
    }, timeoutMs);
    killTimer.unref();
    return {
      endpoint,
      stop: async () => {
        clearTimeout(killTimer);
        await context?.close().catch(() => undefined);
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { chromiumExtensionArgs, config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl } from "../security.js";
import type { StoredProxy } from "../storage.js";
import { defaultProxySettings, proxySettings } from "./shared.js";
import type { Viewport } from "./types.js";

interface Worker {
  browser: Browser;
  jobs: number;
  createdAt: number;
  active: number;
}

export class BrowserPool {
  private readonly workers: Worker[] = [];
  async initialize(): Promise<void> {
    await Promise.all(
      Array.from({ length: config.browserPoolMin }, () => this.launch()),
    );
  }
  async close(): Promise<void> {
    await Promise.all(
      this.workers
        .splice(0)
        .map(({ browser }) => browser.close().catch(() => undefined)),
    );
  }
  stats(): { ready: number; busy: number; processes: number } {
    return {
      ready: this.workers.filter((worker) => worker.active === 0).length,
      busy: this.workers.filter((worker) => worker.active > 0).length,
      processes: this.workers.length,
    };
  }
  async withContext<T>(
    viewport: Viewport | undefined,
    proxy: StoredProxy | undefined,
    task: (context: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T> {
    const worker = await this.acquire();
    worker.active++;
    let context: BrowserContext | undefined;
    try {
      const contextProxy = proxy
        ? proxySettings(proxy)
        : defaultProxySettings();
      context = await worker.browser.newContext({
        viewport: {
          width: viewport?.width ?? 1280,
          height: viewport?.height ?? 720,
        },
        deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
        serviceWorkers: "block",
        ...(contextProxy ? { proxy: contextProxy } : {}),
      });
      await context.route("**/*", async (route) => {
        try {
          await assertSafeUrl(route.request().url(), proxy?.allowedDomains);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      return await task(context, await context.newPage());
    } finally {
      await context?.close().catch(() => undefined);
      worker.active--;
      worker.jobs++;
      await this.recycle(worker);
    }
  }
  private async acquire(): Promise<Worker> {
    const available = this.workers
      .filter((worker) => worker.browser.isConnected())
      .sort((a, b) => a.active - b.active)[0];
    return (
      available ??
      (this.workers.length < config.browserPoolMax
        ? this.launch()
        : Promise.reject(
            new OpenBrowseError(
              "NO_BROWSER_CAPACITY",
              "No browser worker is available",
              503,
              true,
            ),
          ))
    );
  }
  private async launch(): Promise<Worker> {
    const worker = {
      browser: await chromium.launch({
        headless: true,
        chromiumSandbox: config.chromiumSandbox,
        args: chromiumExtensionArgs,
      }),
      jobs: 0,
      createdAt: Date.now(),
      active: 0,
    };
    this.workers.push(worker);
    return worker;
  }
  private async recycle(worker: Worker): Promise<void> {
    if (
      worker.active > 0 ||
      (worker.jobs < config.browserMaxJobs &&
        Date.now() - worker.createdAt < config.browserMaxAgeMs &&
        process.memoryUsage.rss() / 1024 / 1024 < config.browserRecycleRssMb)
    )
      return;
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    await worker.browser.close().catch(() => undefined);
  }
}

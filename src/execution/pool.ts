import {
  chromium,
  type Browser,
  type BrowserServer,
  type BrowserContext,
  type Page,
} from "playwright";
import { chromiumExtensionArgs, config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import {
  admissionMemory,
  measureBrowserProcessTrees,
  type MemoryAdmissionAuthority,
} from "../process-memory.js";
import { assertSafeUrl } from "../security.js";
import type { StoredProxy } from "../storage.js";
import { defaultProxySettings, proxySettings } from "./shared.js";
import type { Viewport } from "./types.js";

type WorkerState = "healthy" | "draining" | "dead";

interface Worker {
  id: string;
  browser: Browser;
  server: BrowserServer;
  pid: number;
  jobs: number;
  createdAt: number;
  active: number;
  failures: number;
  state: WorkerState;
  rssMb: number;
}

export interface BrowserMemorySnapshot {
  nodeRssMb: number;
  browserRssMb: number;
  processTreeRssMb: number;
  containerRssMb?: number;
  containerLimitMb?: number;
  admissionAuthority: MemoryAdmissionAuthority;
  totalRssMb: number;
  processTreesSupported: boolean;
  sampledAt: number;
}

export interface BrowserPoolStats {
  ready: number;
  busy: number;
  processes: number;
  healthy: number;
  draining: number;
  starting: number;
  dead: number;
  browserRssMb: number;
  contextCapacity: number;
  launches: number;
  crashes: number;
  recycled: number;
  replacements: number;
}

function nodeRssMb(): number {
  return process.memoryUsage.rss() / 1024 / 1024;
}

export class BrowserPool {
  private readonly workers: Worker[] = [];
  private launching = 0;
  private launchFailures = 0;
  private nextLaunchAt = 0;
  private closed = false;
  private launches = 0;
  private crashes = 0;
  private recycled = 0;
  private replacements = 0;
  private memory: BrowserMemorySnapshot = {
    nodeRssMb: nodeRssMb(),
    browserRssMb: 0,
    processTreeRssMb: nodeRssMb(),
    admissionAuthority: process.platform === "linux" ? "process-tree" : "node",
    totalRssMb: nodeRssMb(),
    processTreesSupported: process.platform === "linux",
    sampledAt: Date.now(),
  };
  private refreshing: Promise<void> | undefined;

  async initialize(): Promise<void> {
    this.closed = false;
    await Promise.all(
      Array.from({ length: config.browserPoolMin }, () => this.launch()),
    );
    await this.refreshMemory();
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = this.workers.splice(0);
    await Promise.all(
      workers.map(async (worker) => {
        worker.state = "dead";
        await worker.server.close().catch(() => undefined);
      }),
    );
    await this.refreshMemory(true);
  }

  stats(): BrowserPoolStats {
    const healthy = this.workers.filter((worker) => worker.state === "healthy");
    return {
      ready: healthy.filter((worker) => worker.active === 0).length,
      busy: healthy.reduce((total, worker) => total + worker.active, 0),
      processes: this.workers.length,
      healthy: healthy.length,
      draining: this.workers.filter((worker) => worker.state === "draining").length,
      starting: this.launching,
      dead: this.workers.filter((worker) => worker.state === "dead").length,
      browserRssMb: Number(this.memory.browserRssMb.toFixed(1)),
      contextCapacity: healthy.length * config.browserContextsPerWorker,
      launches: this.launches,
      crashes: this.crashes,
      recycled: this.recycled,
      replacements: this.replacements,
    };
  }

  memorySnapshot(): BrowserMemorySnapshot {
    return { ...this.memory };
  }

  async refreshMemory(force = false): Promise<void> {
    if (!force && Date.now() - this.memory.sampledAt < 1000) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const roots = this.workers
        .filter((worker) => worker.state !== "dead")
        .flatMap((worker) => (worker.pid ? [worker.pid] : []));
      const measurement = await measureBrowserProcessTrees(roots);
      let browserRssMb = 0;
      for (const worker of this.workers) {
        worker.rssMb = worker.pid
          ? (measurement.trees.get(worker.pid)?.rssMb ?? 0)
          : 0;
        browserRssMb += worker.rssMb;
      }
      const nodeRss = nodeRssMb();
      const admission = admissionMemory({
        nodeRssMb: nodeRss,
        browserTreeRssMb: browserRssMb,
        ...(measurement.containerRssMb === undefined
          ? {}
          : { containerRssMb: measurement.containerRssMb }),
        processTreesSupported: measurement.supported,
      });
      this.memory = {
        nodeRssMb: nodeRss,
        browserRssMb,
        processTreeRssMb: admission.processTreeRssMb,
        ...(measurement.containerRssMb === undefined
          ? {}
          : {
              containerRssMb: measurement.containerRssMb,
              ...(measurement.containerLimitMb === undefined
                ? {}
                : { containerLimitMb: measurement.containerLimitMb }),
            }),
        admissionAuthority: admission.authority,
        totalRssMb: admission.rssMb,
        processTreesSupported: measurement.supported,
        sampledAt: Date.now(),
      };
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
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
      const contextProxy = proxy ? proxySettings(proxy) : defaultProxySettings();
      try {
        context = await worker.browser.newContext({
          viewport: {
            width: viewport?.width ?? 1280,
            height: viewport?.height ?? 720,
          },
          deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
          serviceWorkers: "block",
          ...(contextProxy ? { proxy: contextProxy } : {}),
        });
      } catch (error) {
        this.recordFailure(worker);
        throw error;
      }
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
      await this.refreshMemory();
      await this.recycle(worker);
    }
  }

  private async acquire(): Promise<Worker> {
    if (this.closed)
      throw new OpenBrowseError(
        "NO_BROWSER_CAPACITY",
        "Browser pool is closed",
        503,
        true,
      );
    await this.refreshMemory();
    for (const worker of [...this.workers]) {
      if (worker.state === "healthy" && !worker.browser.isConnected())
        this.markDead(worker);
    }
    const available = this.workers
      .filter(
        (worker) =>
          worker.state === "healthy" &&
          worker.browser.isConnected() &&
          worker.active < config.browserContextsPerWorker,
      )
      .sort((a, b) => a.active - b.active)[0];
    if (available) return available;
    if (this.workers.length + this.launching >= config.browserPoolMax)
      throw new OpenBrowseError(
        "NO_BROWSER_CAPACITY",
        "No healthy browser worker has context capacity",
        503,
        true,
      );
    return this.launch();
  }

  private async launch(): Promise<Worker> {
    const delay = this.nextLaunchAt - Date.now();
    if (delay > 0)
      throw new OpenBrowseError(
        "NO_BROWSER_CAPACITY",
        `Browser worker restart is backing off for ${delay}ms`,
        503,
        true,
      );
    this.launching++;
    try {
      const server = await chromium.launchServer({
        headless: true,
        chromiumSandbox: config.chromiumSandbox,
        args: chromiumExtensionArgs,
      });
      let browser: Browser;
      try {
        browser = await chromium.connect(server.wsEndpoint());
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
      const worker: Worker = {
        id: `wrk_${crypto.randomUUID().replaceAll("-", "")}`,
        browser,
        server,
        pid,
        jobs: 0,
        createdAt: Date.now(),
        active: 0,
        failures: 0,
        state: "healthy",
        rssMb: 0,
      };
      server.on("close", () => this.markDead(worker));
      browser.on("disconnected", () => {
        if (worker.state === "healthy") {
          worker.state = "draining";
          void worker.server.close().catch(() => undefined);
        }
      });
      this.workers.push(worker);
      this.launches++;
      this.launchFailures = 0;
      this.nextLaunchAt = 0;
      await this.refreshMemory(true);
      return worker;
    } catch (error) {
      this.launchFailures++;
      this.nextLaunchAt =
        Date.now() +
        Math.min(
          60000,
          config.browserLaunchBackoffMs * 2 ** (this.launchFailures - 1),
        );
      throw error;
    } finally {
      this.launching--;
    }
  }

  private recordFailure(worker: Worker): void {
    worker.failures++;
    if (worker.failures >= config.browserWorkerFailureLimit)
      worker.state = "draining";
  }

  private markDead(worker: Worker): void {
    if (worker.state === "dead") return;
    this.crashes++;
    worker.state = "dead";
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    void this.refreshMemory(true);
    void this.replenish();
  }

  private async replenish(): Promise<void> {
    if (
      this.closed ||
      this.workers.length + this.launching >= config.browserPoolMin ||
      Date.now() < this.nextLaunchAt
    )
      return;
    const worker = await this.launch().catch(() => undefined);
    if (worker) this.replacements++;
  }

  private async recycle(worker: Worker): Promise<void> {
    if (
      worker.jobs >= config.browserMaxJobs ||
      Date.now() - worker.createdAt >= config.browserMaxAgeMs ||
      worker.rssMb >= config.browserRecycleRssMb
    )
      worker.state = "draining";
    if (worker.active > 0 || worker.state === "healthy") return;
    this.retire(worker);
    this.recycled++;
    await worker.server.close().catch(() => undefined);
    await this.refreshMemory(true);
    await this.replenish();
  }

  private retire(worker: Worker): void {
    worker.state = "dead";
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
  }
}

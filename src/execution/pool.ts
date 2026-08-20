import {
  type Browser,
  type BrowserServer,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import {
  admissionMemory,
  measureBrowserProcessTrees,
  type MemoryAdmissionAuthority,
} from "../process-memory.js";
import { assertSafeUrl } from "../security.js";
import type { StoredProxy } from "../storage.js";
import { defaultProxySettings, proxySettings } from "./shared.js";
import {
  browserProfileKey,
  launchBrowserWorker,
} from "./browser-launchers.js";
import type {
  BrowserBackendId,
  BrowserBackendOptions,
  Viewport,
} from "./types.js";

type WorkerState = "healthy" | "draining" | "dead";

interface Worker {
  id: string;
  backend: BrowserBackendId;
  profileKey: string;
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
  launchFailures: number;
  crashes: number;
  recycled: number;
  replacements: number;
}

export interface BrowserWorkerSnapshot {
  id: string;
  backend: BrowserBackendId;
  state: "HEALTHY" | "DRAINING" | "DEAD";
  pid: number;
  rssMb: number;
  contexts: number;
  capacity: number;
  jobs: number;
  ageMs: number;
  failures: number;
}

export interface BrowserAdmissionDecision {
  allowed: boolean;
  reason: "warm-capacity" | "launch-capacity" | "memory-pressure" | "soft-pressure-no-launch";
  currentRssMb: number;
  estimatedMemoryMb: number;
  warmCapacity: number;
}

export interface BrowserContextLease {
  workerId: string;
  acquireMs: number;
  reusedWorker: boolean;
}

function nodeRssMb(): number {
  return process.memoryUsage.rss() / 1024 / 1024;
}

export class BrowserPool {
  private readonly workers: Worker[] = [];
  private launching = 0;
  private readonly launchingByBackend = new Map<BrowserBackendId, number>();
  private launchFailures = 0;
  private readonly launchFailuresByBackend = new Map<BrowserBackendId, number>();
  private readonly consecutiveLaunchFailuresByBackend = new Map<
    BrowserBackendId,
    number
  >();
  private readonly nextLaunchAtByBackend = new Map<BrowserBackendId, number>();
  private closed = false;
  private launches = 0;
  private readonly launchesByBackend = new Map<BrowserBackendId, number>();
  private crashes = 0;
  private readonly crashesByBackend = new Map<BrowserBackendId, number>();
  private recycled = 0;
  private readonly recycledByBackend = new Map<BrowserBackendId, number>();
  private replacements = 0;
  private readonly replacementsByBackend = new Map<BrowserBackendId, number>();
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

  stats(backend?: BrowserBackendId): BrowserPoolStats {
    const workers = backend
      ? this.workers.filter((worker) => worker.backend === backend)
      : this.workers;
    const healthy = workers.filter((worker) => worker.state === "healthy");
    return {
      ready: healthy.filter((worker) => worker.active === 0).length,
      busy: healthy.reduce((total, worker) => total + worker.active, 0),
      processes: workers.length,
      healthy: healthy.length,
      draining: workers.filter((worker) => worker.state === "draining").length,
      starting: backend
        ? (this.launchingByBackend.get(backend) ?? 0)
        : this.launching,
      dead: workers.filter((worker) => worker.state === "dead").length,
      browserRssMb: Number(
        (backend
          ? workers.reduce((total, worker) => total + worker.rssMb, 0)
          : this.memory.browserRssMb
        ).toFixed(1),
      ),
      contextCapacity: healthy.length * config.browserContextsPerWorker,
      launches: backend
        ? (this.launchesByBackend.get(backend) ?? 0)
        : this.launches,
      launchFailures: backend
        ? (this.launchFailuresByBackend.get(backend) ?? 0)
        : this.launchFailures,
      crashes: backend
        ? (this.crashesByBackend.get(backend) ?? 0)
        : this.crashes,
      recycled: backend
        ? (this.recycledByBackend.get(backend) ?? 0)
        : this.recycled,
      replacements: backend
        ? (this.replacementsByBackend.get(backend) ?? 0)
        : this.replacements,
    };
  }

  workerSnapshots(): BrowserWorkerSnapshot[] {
    const now = Date.now();
    return this.workers.map((worker) => ({
      id: worker.id,
      backend: worker.backend,
      state: worker.state.toUpperCase() as BrowserWorkerSnapshot["state"],
      pid: worker.pid,
      rssMb: Number(worker.rssMb.toFixed(1)),
      contexts: worker.active,
      capacity: config.browserContextsPerWorker,
      jobs: worker.jobs,
      ageMs: Math.max(0, now - worker.createdAt),
      failures: worker.failures,
    }));
  }

  memorySnapshot(): BrowserMemorySnapshot {
    return { ...this.memory };
  }

  async browserAdmission(
    estimatedMemoryMb: number,
    backend: BrowserBackendId = config.defaultBrowserBackend,
    options?: BrowserBackendOptions,
  ): Promise<BrowserAdmissionDecision> {
    await this.refreshMemory(true);
    const healthy = this.workers.filter(
      (worker) =>
        worker.state === "healthy" &&
        worker.browser.isConnected() &&
        worker.backend === backend &&
        worker.profileKey === browserProfileKey(backend, options),
    );
    const warmCapacity = healthy.reduce(
      (total, worker) =>
        total + Math.max(0, config.browserContextsPerWorker - worker.active),
      0,
    );
    const currentRssMb = this.memory.totalRssMb;
    if (
      currentRssMb + estimatedMemoryMb >
      config.memoryHardMb - config.memoryReserveMb
    )
      return {
        allowed: false,
        reason: "memory-pressure",
        currentRssMb,
        estimatedMemoryMb,
        warmCapacity,
      };
    if (warmCapacity === 0 && currentRssMb >= config.memorySoftMb)
      return {
        allowed: false,
        reason: "soft-pressure-no-launch",
        currentRssMb,
        estimatedMemoryMb,
        warmCapacity,
      };
    return {
      allowed: true,
      reason: warmCapacity > 0 ? "warm-capacity" : "launch-capacity",
      currentRssMb,
      estimatedMemoryMb,
      warmCapacity,
    };
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
    task: (
      context: BrowserContext,
      page: Page,
      lease: BrowserContextLease,
    ) => Promise<T>,
    backend: BrowserBackendId = config.defaultBrowserBackend,
    backendOptions?: BrowserBackendOptions,
    contextOptions?: Pick<BrowserContextOptions, "recordVideo">,
  ): Promise<T> {
    const acquireStarted = Date.now();
    const launchesBefore = this.launches;
    const worker = await this.acquire(backend, backendOptions);
    const lease: BrowserContextLease = {
      workerId: worker.id,
      acquireMs: Date.now() - acquireStarted,
      reusedWorker: this.launches === launchesBefore,
    };
    worker.active++;
    let context: BrowserContext | undefined;
    try {
      const contextProxy = proxy ? proxySettings(proxy) : defaultProxySettings();
      try {
        context = await worker.browser.newContext({
          viewport:
            backend === "camoufox-firefox" && !viewport
              ? null
              : {
                  width: viewport?.width ?? 1280,
                  height: viewport?.height ?? 720,
                },
          deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
          serviceWorkers: "block",
          ...(contextProxy ? { proxy: contextProxy } : {}),
          ...(contextOptions?.recordVideo
            ? { recordVideo: contextOptions.recordVideo }
            : {}),
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
      return await task(context, await context.newPage(), lease);
    } finally {
      await context?.close().catch(() => undefined);
      worker.active--;
      worker.jobs++;
      await this.refreshMemory();
      await this.recycle(worker);
    }
  }

  private async acquire(
    backend: BrowserBackendId,
    options?: BrowserBackendOptions,
  ): Promise<Worker> {
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
          worker.backend === backend &&
          worker.profileKey === browserProfileKey(backend, options) &&
          worker.active < config.browserContextsPerWorker,
      )
      .sort((a, b) => a.active - b.active)[0];
    if (available) return available;
    if (this.memory.totalRssMb >= config.memorySoftMb)
      throw new OpenBrowseError(
        "MEMORY_PRESSURE",
        "Soft memory limit reached; a new browser worker will not be launched",
        503,
        true,
      );
    if (this.workers.length + this.launching >= config.browserPoolMax)
      throw new OpenBrowseError(
        "NO_BROWSER_CAPACITY",
        "No healthy browser worker has context capacity",
        503,
        true,
      );
    return this.launch(backend, options);
  }

  private async launch(
    backend: BrowserBackendId = config.defaultBrowserBackend,
    options?: BrowserBackendOptions,
  ): Promise<Worker> {
    const delay = (this.nextLaunchAtByBackend.get(backend) ?? 0) - Date.now();
    if (delay > 0)
      throw new OpenBrowseError(
        "NO_BROWSER_CAPACITY",
        `Browser worker restart is backing off for ${delay}ms`,
        503,
        true,
      );
    this.launching++;
    this.launchingByBackend.set(
      backend,
      (this.launchingByBackend.get(backend) ?? 0) + 1,
    );
    try {
      const launched = await launchBrowserWorker(backend, options);
      const { browser, server, pid, profileKey } = launched;
      const worker: Worker = {
        id: `wrk_${crypto.randomUUID().replaceAll("-", "")}`,
        backend,
        profileKey,
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
      this.launchesByBackend.set(
        backend,
        (this.launchesByBackend.get(backend) ?? 0) + 1,
      );
      this.consecutiveLaunchFailuresByBackend.set(backend, 0);
      this.nextLaunchAtByBackend.set(backend, 0);
      await this.refreshMemory(true);
      return worker;
    } catch (error) {
      this.launchFailures++;
      this.launchFailuresByBackend.set(
        backend,
        (this.launchFailuresByBackend.get(backend) ?? 0) + 1,
      );
      const consecutiveFailures =
        (this.consecutiveLaunchFailuresByBackend.get(backend) ?? 0) + 1;
      this.consecutiveLaunchFailuresByBackend.set(
        backend,
        consecutiveFailures,
      );
      this.nextLaunchAtByBackend.set(
        backend,
        Date.now() +
          Math.min(
            60000,
            config.browserLaunchBackoffMs * 2 ** (consecutiveFailures - 1),
          ),
      );
      throw error;
    } finally {
      this.launching--;
      this.launchingByBackend.set(
        backend,
        Math.max(0, (this.launchingByBackend.get(backend) ?? 1) - 1),
      );
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
    this.crashesByBackend.set(
      worker.backend,
      (this.crashesByBackend.get(worker.backend) ?? 0) + 1,
    );
    worker.state = "dead";
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    void this.refreshMemory(true);
    void this.replenish(worker.backend);
  }

  private async replenish(backend: BrowserBackendId): Promise<void> {
    const desired = backend === config.defaultBrowserBackend
      ? config.browserPoolMin
      : 0;
    if (
      this.closed ||
      this.workers.filter((worker) => worker.backend === backend).length +
        (this.launchingByBackend.get(backend) ?? 0) >=
        desired ||
      Date.now() < (this.nextLaunchAtByBackend.get(backend) ?? 0)
    )
      return;
    const worker = await this.launch(backend).catch(() => undefined);
    if (worker) {
      this.replacements++;
      this.replacementsByBackend.set(
        backend,
        (this.replacementsByBackend.get(backend) ?? 0) + 1,
      );
    }
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
    this.recycledByBackend.set(
      worker.backend,
      (this.recycledByBackend.get(worker.backend) ?? 0) + 1,
    );
    await worker.server.close().catch(() => undefined);
    await this.refreshMemory(true);
    await this.replenish(worker.backend);
  }

  private retire(worker: Worker): void {
    worker.state = "dead";
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
  }
}

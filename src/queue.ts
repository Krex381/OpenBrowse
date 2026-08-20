import { config } from "./config.js";
import { OpenBrowseError } from "./errors.js";

export type WorkloadKind =
  | "http"
  | "browser"
  | "screenshot"
  | "pdf"
  | "download"
  | "workflow"
  | "automation"
  | "unknown";

export interface QueueMemorySnapshot {
  totalRssMb: number;
}

interface Pending<T> {
  task: () => Promise<T>;
  resolve: (value: { result: T; queueMs: number }) => void;
  reject: (reason: unknown) => void;
  createdAt: number;
  workload: WorkloadKind;
}

const defaultEstimates: Record<WorkloadKind, number> = {
  http: 32,
  browser: 256,
  screenshot: 192,
  pdf: 256,
  download: 192,
  workflow: 256,
  automation: 256,
  unknown: 200,
};

function processSnapshot(): QueueMemorySnapshot {
  return { totalRssMb: process.memoryUsage.rss() / 1024 / 1024 };
}

function p90(values: readonly number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? fallback;
}

export class AdmissionQueue {
  private active = 0;
  private readonly pending: Pending<unknown>[] = [];
  private readonly samples = new Map<WorkloadKind, number[]>();
  private queueAlerted = false;
  private readonly rejections = { memory: 0, queue: 0 };

  constructor(
    private readonly onQueued?: () => void,
    private readonly memorySnapshot: () => QueueMemorySnapshot = processSnapshot,
  ) {}

  run<T>(
    task: () => Promise<T>,
    workload: WorkloadKind = "unknown",
  ): Promise<{ result: T; queueMs: number }> {
    const currentRssMb = this.memory().totalRssMb;
    if (
      currentRssMb >= config.memoryHardMb ||
      currentRssMb + this.estimate(workload) >
        config.memoryHardMb - config.memoryReserveMb
    ) {
      this.rejections.memory++;
      throw new OpenBrowseError(
        "MEMORY_PRESSURE",
        "Service cannot admit this workload within its configured memory reserve",
        503,
        true,
      );
    }
    if (this.pending.length >= config.queueMax) {
      this.rejections.queue++;
      throw new OpenBrowseError(
        "RATE_LIMITED",
        "Execution queue is full",
        429,
        true,
      );
    }
    if (
      (this.pending.length > 0 || this.active >= config.maxConcurrency) &&
      !this.queueAlerted
    ) {
      this.queueAlerted = true;
      queueMicrotask(() => this.onQueued?.());
    }
    return new Promise<{ result: T; queueMs: number }>((resolve, reject) => {
      const createdAt = Date.now();
      this.pending.push({
        createdAt,
        workload,
        task: async () => {
          const before = this.memory().totalRssMb;
          const result = await task();
          this.recordSample(workload, Math.max(1, this.memory().totalRssMb - before));
          return result;
        },
        resolve: (value) =>
          resolve(value as { result: T; queueMs: number }),
        reject,
      });
      this.drain();
    });
  }

  stats(): {
    active: number;
    pending: number;
    pressure: "normal" | "pressure" | "critical";
    estimatedJobMemoryMb: number;
    estimatesMb: Record<WorkloadKind, number>;
    rejections: { memory: number; queue: number };
  } {
    const rss = this.memory().totalRssMb;
    const estimatesMb = Object.fromEntries(
      (Object.keys(defaultEstimates) as WorkloadKind[]).map((workload) => [
        workload,
        Number(this.estimate(workload).toFixed(1)),
      ]),
    ) as Record<WorkloadKind, number>;
    return {
      active: this.active,
      pending: this.pending.length,
      pressure:
        rss >= config.memoryHardMb
          ? "critical"
          : rss >= config.memorySoftMb
            ? "pressure"
            : "normal",
      estimatedJobMemoryMb: estimatesMb.unknown,
      estimatesMb,
      rejections: { ...this.rejections },
    };
  }

  private memory(): QueueMemorySnapshot {
    return this.memorySnapshot();
  }

  private estimate(workload: WorkloadKind): number {
    return p90(this.samples.get(workload) ?? [], defaultEstimates[workload]);
  }

  private recordSample(workload: WorkloadKind, value: number): void {
    const history = this.samples.get(workload) ?? [];
    history.push(value);
    if (history.length > 128) history.splice(0, history.length - 128);
    this.samples.set(workload, history);
  }

  private drain(): void {
    const rss = this.memory().totalRssMb;
    if (this.pending.length === 0) this.queueAlerted = false;
    while (this.pending.length > 0 && this.active < config.maxConcurrency) {
      const next = this.pending[0];
      if (!next) return;
      const memorySlots = Math.floor(
        (config.memoryHardMb - config.memoryReserveMb - rss) /
          this.estimate(next.workload),
      );
      if (this.active >= Math.max(0, memorySlots)) return;
      const job = this.pending.shift();
      if (!job) return;
      const queueMs = Date.now() - job.createdAt;
      this.active++;
      void job.task().then(
        (result) => {
          this.active--;
          job.resolve({ result, queueMs });
          this.drain();
        },
        (error: unknown) => {
          this.active--;
          job.reject(error);
          this.drain();
        },
      );
    }
  }
}

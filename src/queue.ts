import { config } from "./config.js";
import { OpenBrowseError } from "./errors.js";

interface Pending<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  createdAt: number;
}

export class AdmissionQueue {
  private active = 0;
  private readonly pending: Pending<unknown>[] = [];
  private estimatedJobMemoryMb = 200;
  private queueAlerted = false;
  constructor(private readonly onQueued?: () => void) {}
  run<T>(task: () => Promise<T>): Promise<{ result: T; queueMs: number }> {
    if (process.memoryUsage.rss() / 1024 / 1024 >= config.memoryHardMb)
      throw new OpenBrowseError(
        "MEMORY_PRESSURE",
        "Service is at its configured memory limit",
        503,
        true,
      );
    if (this.pending.length >= config.queueMax)
      throw new OpenBrowseError(
        "RATE_LIMITED",
        "Execution queue is full",
        429,
        true,
      );
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
        task: async () => {
          const before = process.memoryUsage.rss();
          const result = await task();
          const after = process.memoryUsage.rss();
          this.estimatedJobMemoryMb =
            0.2 * Math.max(1, (after - before) / 1024 / 1024) +
            0.8 * this.estimatedJobMemoryMb;
          return result;
        },
        resolve: (result) =>
          resolve({ result: result as T, queueMs: Date.now() - createdAt }),
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
  } {
    const rss = process.memoryUsage.rss() / 1024 / 1024;
    return {
      active: this.active,
      pending: this.pending.length,
      pressure:
        rss >= config.memoryHardMb
          ? "critical"
          : rss >= config.memorySoftMb
            ? "pressure"
            : "normal",
      estimatedJobMemoryMb: this.estimatedJobMemoryMb,
    };
  }
  private drain(): void {
    const rss = process.memoryUsage.rss() / 1024 / 1024;
    const memorySlots = Math.max(
      0,
      Math.floor(
        (config.memoryHardMb - config.memoryReserveMb - rss) /
          this.estimatedJobMemoryMb,
      ),
    );
    const limit = Math.min(config.maxConcurrency, Math.max(1, memorySlots));
    if (this.pending.length === 0) this.queueAlerted = false;
    while (this.active < limit && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      this.active++;
      void job.task().then(
        (result) => {
          this.active--;
          job.resolve(result);
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

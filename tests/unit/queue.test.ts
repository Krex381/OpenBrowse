import { describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { AdmissionQueue } from "../../src/queue.js";

describe("admission queue", () => {
  it("runs submitted work and exposes its state", async () => {
    const queue = new AdmissionQueue();
    const run = await queue.run(async () => 42);
    expect(run.result).toBe(42);
    expect(run.queueMs).toBeGreaterThanOrEqual(0);
    expect(queue.stats().active).toBe(0);
  });
  it("notifies once when work begins queueing", async () => {
    let alerts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new AdmissionQueue(() => {
      alerts++;
    });
    const active = Array.from({ length: config.maxConcurrency }, () =>
      queue.run(async () => gate),
    );
    await Promise.resolve();
    const queued = queue.run(async () => 7);
    await Promise.resolve();
    expect(alerts).toBe(1);
    release?.();
    await Promise.all(active);
    expect((await queued).result).toBe(7);
  });
  it("keeps independent p90 memory estimates for workload classes", async () => {
    let rssMb = 100;
    const queue = new AdmissionQueue(undefined, () => ({ totalRssMb: rssMb }));
    await queue.run(async () => {
      rssMb = 132;
      return "http";
    }, "http");
    await queue.run(async () => {
      rssMb = 388;
      return "browser";
    }, "browser");
    const estimates = queue.stats().estimatesMb;
    expect(estimates.http).toBe(32);
    expect(estimates.browser).toBe(256);
    expect(estimates.pdf).toBe(256);
  });
});

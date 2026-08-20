import { describe, expect, it, vi } from "vitest";
import { runChallengeFallback } from "../../src/execution/challenge-fallback.js";
import type { BrowserPool } from "../../src/execution/pool.js";

function admittedPool(): BrowserPool {
  return {
    browserAdmission: vi.fn(async () => ({
      allowed: true,
      reason: "launch-capacity",
      currentRssMb: 100,
      estimatedMemoryMb: 256,
      warmCapacity: 0,
    })),
  } as unknown as BrowserPool;
}

describe("challenge backend fallback", () => {
  it("moves from stock Chromium to Patchright once when a challenge remains", async () => {
    const attempts: string[] = [];
    const result = await runChallengeFallback(
      admittedPool(),
      { url: "https://example.com" },
      "playwright-chromium",
      async (backend) => {
        attempts.push(backend);
        return {
          value: backend,
          challengeDetected: backend === "playwright-chromium",
        };
      },
    );

    expect(attempts).toEqual([
      "playwright-chromium",
      "patchright-chromium",
    ]);
    expect(result).toMatchObject({
      value: "patchright-chromium",
      backendAttempts: ["playwright-chromium", "patchright-chromium"],
      selectedBackend: "patchright-chromium",
      challengeRemaining: false,
    });
  });

  it("returns an honest final state instead of throwing when all enabled backends see a challenge", async () => {
    const result = await runChallengeFallback(
      admittedPool(),
      { url: "https://example.com" },
      "playwright-chromium",
      async (backend) => ({ value: backend, challengeDetected: true }),
    );

    expect(result).toMatchObject({
      value: "patchright-chromium",
      selectedBackend: "patchright-chromium",
      challengeRemaining: true,
    });
    expect(result.backendAttempts).toEqual([
      "playwright-chromium",
      "patchright-chromium",
    ]);
  });
});

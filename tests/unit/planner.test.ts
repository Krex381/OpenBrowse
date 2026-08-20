import { describe, expect, it } from "vitest";
import { planExecution, planPersistentSession, resolvedPlan } from "../../src/execution/planner.js";

describe("execution planner", () => {
  it("keeps auto execution HTTP-first with a bounded browser fallback", () => {
    const plan = planExecution({ url: "https://example.com", strategy: "auto" });
    expect(plan).toMatchObject({
      strategy: "HTTP_THEN_BROWSER",
      requestedStrategy: "auto",
      stages: ["http", "browser"],
      browserBackend: "playwright-chromium",
      reason: "auto-http-first",
      attemptBudget: 2,
      estimatedMemoryMb: 16,
      cacheEligible: true,
      browserRequired: false,
    });
    expect(resolvedPlan(plan, {
      browserRecommended: true,
      reason: "client-rendered-shell",
      signals: ["empty-app-root:#root", "framework:vite"],
      textChars: 0,
      htmlChars: 100,
      scriptChars: 40,
      scriptCount: 1,
      meaningfulTextDensity: 0,
    })).toMatchObject({
      reason: "client-rendered-shell",
      estimatedMemoryMb: 256,
      browserRequired: true,
    });
  });

  it("does not allocate a browser stage for explicit HTTP", () => {
    expect(planExecution({ url: "https://example.com", strategy: "http" })).toMatchObject({
      stages: ["http"],
      attemptBudget: 1,
      estimatedMemoryMb: 16,
      reason: "explicit-http",
      strategy: "HTTP",
    });
  });

  it("represents stateful sessions as a single bounded browser plan", () => {
    expect(planPersistentSession({
      persistent: true,
      profile: true,
      liveViewer: false,
    })).toMatchObject({
      strategy: "PERSISTENT_SESSION",
      requestedStrategy: "session",
      stages: ["browser"],
      reason: "persistent-session",
      attemptBudget: 1,
      cacheEligible: false,
      signals: ["storage-state-retained", "profile-state-loaded"],
    });
  });
});

import { describe, expect, it } from "vitest";
import { DomainObservationStore } from "../../src/execution/domain-observations.js";
import { planExecution } from "../../src/execution/planner.js";
import type { ClientRenderAnalysis } from "../../src/execution/types.js";

const shell: ClientRenderAnalysis = {
  browserRecommended: true,
  reason: "client-rendered-shell",
  signals: ["empty-app-root:#root"],
  textChars: 0,
  htmlChars: 100,
  scriptChars: 20,
  scriptCount: 1,
  meaningfulTextDensity: 0,
};

describe("domain observations", () => {
  it("adds bounded advisory evidence without skipping HTTP", () => {
    const store = new DomainObservationStore(2, 3, 1000);
    store.record("https://spa.example/one", shell, 100);
    store.record("https://spa.example/two", shell, 101);
    const observation = store.get("https://spa.example/three", 102);
    expect(observation).toMatchObject({ samples: 2, shellRatio: 1 });
    expect(planExecution(
      { url: "https://spa.example/three", strategy: "auto" },
      { domainObservation: observation },
    )).toMatchObject({
      stages: ["http", "browser"],
      attemptBudget: 2,
      estimatedCost: { units: 3, basis: "http" },
    });
  });

  it("expires old evidence and caps retained samples", () => {
    const store = new DomainObservationStore(2, 2, 10);
    store.record("https://one.example", shell, 1);
    store.record("https://one.example", shell, 2);
    store.record("https://one.example", shell, 3);
    expect(store.get("https://one.example", 4)?.samples).toBe(2);
    expect(store.get("https://one.example", 20)).toBeUndefined();
  });
});

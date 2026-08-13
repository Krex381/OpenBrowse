import { describe, expect, it, vi } from "vitest";
import { waitForBrowserReadiness } from "../../src/execution/content.js";
import { fetchInput } from "../../src/server/input.js";

describe("browser render readiness", () => {
  it("waits for the caller's selector and state", async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn().mockReturnValue({ waitFor });
    await waitForBrowserReadiness({ locator } as never, {
      type: "selector",
      selector: "[data-profile-loaded]",
    });
    expect(locator).toHaveBeenCalledWith("[data-profile-loaded]");
    expect(waitFor).toHaveBeenCalledWith({ state: "visible" });
  });

  it("uses network idle only when the caller explicitly requests it", async () => {
    const waitForLoadState = vi.fn().mockResolvedValue(undefined);
    await waitForBrowserReadiness({ waitForLoadState } as never, {
      type: "networkidle",
      timeoutMs: 1200,
    });
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 1200 });
  });

  it("installs a bounded stability observer", async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    await waitForBrowserReadiness({ evaluate } as never, {
      type: "stability",
      quietMs: 650,
      timeoutMs: 2400,
    });
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      quietMs: 650,
      timeoutMs: 2400,
      minimumObservationMs: 0,
    });
  });

  it("validates the public wait contract and prevents ambiguous legacy input", () => {
    expect(
      fetchInput.parse({
        url: "https://example.com",
        wait: { type: "selector", selector: "[data-ready]", state: "attached" },
      }).wait,
    ).toEqual({ type: "selector", selector: "[data-ready]", state: "attached" });
    expect(() =>
      fetchInput.parse({
        url: "https://example.com",
        waitUntil: "load",
        wait: { type: "stability" },
      }),
    ).toThrow(/wait and waitUntil/);
  });
});

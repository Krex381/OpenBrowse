import { describe, expect, it, vi } from "vitest";
import { observeChallengeResolution } from "../../src/execution/content.js";

describe("passive challenge observation", () => {
  it("returns immediately for ordinary content", async () => {
    const page = {
      content: vi.fn(),
      waitForTimeout: vi.fn(),
    };
    const result = await observeChallengeResolution(
      page,
      "<html><title>Ready</title></html>",
      8_000,
    );
    expect(result).toEqual({
      html: "<html><title>Ready</title></html>",
      waitedMs: 0,
      resolved: true,
    });
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("observes a non-interactive challenge until the document becomes ordinary", async () => {
    const page = {
      content: vi.fn(async () => "<html><title>Ready</title></html>"),
      waitForTimeout: vi.fn(async () => undefined),
    };
    const result = await observeChallengeResolution(
      page,
      '<html><script src="/cf-chl-platform/test.js"></script></html>',
      8_000,
    );
    expect(result.resolved).toBe(true);
    expect(result.html).toContain("Ready");
    expect(page.waitForTimeout).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import { settleRenderedPage } from "../../src/execution/content.js";

describe("browser render settling", () => {
  it("waits briefly for an implicit browser fetch to settle", async () => {
    const waitForLoadState = vi.fn().mockResolvedValue(undefined);
    await settleRenderedPage({ waitForLoadState } as never, {});
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 2500,
    });
  });

  it("keeps an explicit navigation policy authoritative", async () => {
    const waitForLoadState = vi.fn().mockResolvedValue(undefined);
    await settleRenderedPage(
      { waitForLoadState } as never,
      { waitUntil: "domcontentloaded" },
    );
    expect(waitForLoadState).not.toHaveBeenCalled();
  });

  it("does not discard usable HTML when the bounded settle wait times out", async () => {
    const waitForLoadState = vi.fn().mockRejectedValue(new Error("Timeout 2500ms exceeded"));
    await expect(
      settleRenderedPage({ waitForLoadState } as never, {}),
    ).resolves.toBeUndefined();
  });
});

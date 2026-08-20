import { describe, expect, it, vi } from "vitest";
import { Cache } from "../../src/cache.js";
import type { Storage } from "../../src/storage.js";

describe("response cache invalidation", () => {
  it("removes an entry from memory and persistent storage", async () => {
    const stored = new Map<string, Buffer>();
    const storage = {
      getCache: vi.fn(async (key: string) => {
        const body = stored.get(key);
        return body ? { body, metadata: {} } : undefined;
      }),
      putCache: vi.fn(async (key: string, body: Buffer) => {
        stored.set(key, body);
      }),
      deleteCache: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      cacheStats: vi.fn(() => ({ disk: { entries: 0, bytes: 0 } })),
    } as unknown as Storage;
    const cache = new Cache(storage);

    await cache.put("sha256:test", Buffer.from("challenge"), 60, {});
    expect((await cache.get("sha256:test"))?.body.toString()).toBe(
      "challenge",
    );
    await cache.delete("sha256:test");

    expect(await cache.get("sha256:test")).toBeUndefined();
    expect(storage.deleteCache).toHaveBeenCalledWith("sha256:test");
  });
});

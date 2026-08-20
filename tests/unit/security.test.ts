import { describe, expect, it } from "vitest";
import {
  assertSafeUrl,
  isPrivateIp,
  normalizeUrl,
  resolveSafeUrl,
} from "../../src/security.js";

describe("SSRF guard", () => {
  it("classifies private, metadata, loopback, and public addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("::ffff:172.16.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateIp("::ffff:ac10:1")).toBe(true);
  });
  it("blocks dangerous schemes and loopback URLs before execution", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
    await expect(assertSafeUrl("http://127.0.0.1:8080")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    await expect(assertSafeUrl("http://[::1]/")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    await expect(
      assertSafeUrl("http://[::ffff:169.254.169.254]/"),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });
  it("normalizes default ports and fragments for cache keys", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/path#fragment")).toBe(
      "https://example.com/path",
    );
    expect(
      normalizeUrl(
        "https://example.com/path?keep=yes&__cf_chl_rt_tk=ephemeral#fragment",
      ),
    ).toBe("https://example.com/path?keep=yes");
  });

  it("pins every public DNS answer and rejects mixed public/private answers", async () => {
    let calls = 0;
    const resolver = async () => {
      calls++;
      return [
        { address: "203.0.113.10", family: 4 as const },
        { address: "2001:4860:4860::8888", family: 6 as const },
      ];
    };
    const resolved = await resolveSafeUrl(
      "https://public.example/path",
      undefined,
      resolver as never,
    );
    expect(calls).toBe(1);
    expect(resolved.addresses).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);

    await expect(
      resolveSafeUrl(
        "https://rebinding.example",
        undefined,
        (async () => [
          { address: "203.0.113.10", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]) as never,
      ),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });
});

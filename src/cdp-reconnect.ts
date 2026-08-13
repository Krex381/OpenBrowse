import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { launchCdpBrowser, type CdpBrowser, type SafeLaunchOptions } from "./cdp.js";
import { OpenBrowseError } from "./errors.js";

type ReconnectableCdp = {
  id: string;
  ownerKeyHash: string;
  accessHash: string;
  browser: CdpBrowser;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Keeps CDP targets alive across socket disconnects without exposing their endpoint. */
export class CdpReconnectManager {
  private readonly targets = new Map<string, ReconnectableCdp>();

  async create(
    ownerKeyHash: string,
    ttlSeconds: number,
    launch: SafeLaunchOptions = {},
  ): Promise<{ id: string; accessToken: string; expiresAt: number }> {
    const ttlMs = Math.min(ttlSeconds * 1000, config.maxSessionTtlSeconds * 1000);
    const browser = await launchCdpBrowser(ttlMs, launch);
    const id = `cdp_${randomUUID().replaceAll("-", "")}`;
    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => void this.close(id), ttlMs);
    timer.unref();
    this.targets.set(id, {
      id,
      ownerKeyHash,
      accessHash: this.hash(accessToken),
      browser,
      expiresAt,
      timer,
    });
    return { id, accessToken, expiresAt };
  }

  get(id: string, ownerKeyHash: string, accessToken: string): CdpBrowser {
    const target = this.targets.get(id);
    if (
      !target ||
      target.expiresAt < Date.now() ||
      target.ownerKeyHash !== ownerKeyHash ||
      this.hash(accessToken) !== target.accessHash
    )
      throw new OpenBrowseError(
        "CDP_SESSION_NOT_FOUND",
        "Reconnectable CDP session does not exist or has expired",
        404,
      );
    return target.browser;
  }

  async close(id: string): Promise<void> {
    const target = this.targets.get(id);
    if (!target) return;
    this.targets.delete(id);
    clearTimeout(target.timer);
    await target.browser.stop();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.targets.keys()].map((id) => this.close(id)));
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

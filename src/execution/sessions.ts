import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type Cookie,
  type LaunchOptions,
  type Page,
} from "playwright";
import { chromiumExtensionArgs, config } from "../config.js";
import type { SafeLaunchOptions } from "../cdp.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl } from "../security.js";
import type { StoredProxy, StoredSession } from "../storage.js";
import { defaultProxySettings, proxySettings } from "./shared.js";

export interface LiveSession {
  session: StoredSession;
  server: BrowserServer;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export class SessionManager {
  private readonly active = new Map<string, LiveSession>();
  private readonly tracing = new Set<string>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  async create(
    session: StoredSession,
    proxy?: StoredProxy,
    launchOptions: SafeLaunchOptions = {},
  ): Promise<LiveSession> {
    await this.closeExpired();
    if (session.liveViewer && [...this.active.values()].some((live) => live.session.liveViewer))
      throw new OpenBrowseError(
        "VIEWER_BUSY",
        "Only one live VNC session may run per OpenBrowse instance",
        409,
        true,
      );
    const launchProxy = proxy ? proxySettings(proxy) : defaultProxySettings();
    const launch: LaunchOptions = {
      headless: launchOptions.headless ?? !session.liveViewer,
      chromiumSandbox: config.chromiumSandbox,
      ...(launchOptions.slowMo !== undefined
        ? { slowMo: launchOptions.slowMo }
        : {}),
      ...(launchOptions.acceptInsecureCerts !== undefined
        ? { ignoreHTTPSErrors: launchOptions.acceptInsecureCerts }
        : {}),
      ...(launchProxy ? { proxy: launchProxy } : {}),
      args: [...chromiumExtensionArgs, ...(launchOptions.args ?? [])],
    };
    const server = await chromium.launchServer(launch);
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({
      viewport: session.viewport,
      serviceWorkers: "block",
      ...(session.storageState
        ? {
            storageState: JSON.parse(session.storageState) as {
              cookies: Cookie[];
              origins: Array<{
                origin: string;
                localStorage: Array<{ name: string; value: string }>;
              }>;
            },
          }
        : {}),
    });
    await context.route("**/*", async (route) => {
      try {
        await assertSafeUrl(route.request().url(), proxy?.allowedDomains);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    const live = { session, server, browser, context, page };
    this.active.set(session.id, live);
    const expiresInMs = Math.max(0, session.expiresAt - Date.now());
    const expiryTimer = setTimeout(() => void this.close(session.id), expiresInMs);
    expiryTimer.unref();
    this.expiryTimers.set(session.id, expiryTimer);
    return live;
  }
  async get(
    session: StoredSession,
    proxy?: StoredProxy,
    launch?: SafeLaunchOptions,
  ): Promise<LiveSession> {
    return this.active.get(session.id) ?? this.create(session, proxy, launch);
  }
  async startTrace(session: StoredSession, proxy?: StoredProxy): Promise<void> {
    const live = await this.get(session, proxy);
    if (this.tracing.has(session.id)) return;
    await live.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
      title: `OpenBrowse ${session.id}`,
    });
    this.tracing.add(session.id);
  }
  async stopTrace(id: string): Promise<Buffer | undefined> {
    const live = this.active.get(id);
    if (!live || !this.tracing.delete(id)) return undefined;
    const directory = await mkdtemp(join(tmpdir(), "openbrowse-trace-"));
    const path = join(directory, "trace.zip");
    try {
      await live.context.tracing.stop({ path });
      const trace = await readFile(path);
      if (trace.length > config.maxResponseBytes)
        throw new OpenBrowseError(
          "PAYLOAD_TOO_LARGE",
          "Trace exceeds the configured artifact byte limit",
          413,
        );
      return trace;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async close(id: string): Promise<void> {
    const live = this.active.get(id);
    const expiryTimer = this.expiryTimers.get(id);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.expiryTimers.delete(id);
    this.active.delete(id);
    this.tracing.delete(id);
    await live?.browser.close().catch(() => undefined);
    await live?.server.close().catch(() => undefined);
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.close(id)));
  }
  private async closeExpired(): Promise<void> {
    await Promise.all(
      [...this.active.values()]
        .filter((live) => live.session.expiresAt <= Date.now())
        .map((live) => this.close(live.session.id)),
    );
  }
  async storageState(id: string): Promise<string | undefined> {
    const live = this.active.get(id);
    return live ? JSON.stringify(await live.context.storageState()) : undefined;
  }
  wsEndpoint(id: string): string | undefined {
    return this.active.get(id)?.server.wsEndpoint();
  }
  isTracing(id: string): boolean {
    return this.tracing.has(id);
  }
  isActive(id: string): boolean {
    return this.active.has(id);
  }
}

export function redactCookies(
  cookies: Cookie[],
): Array<Omit<Cookie, "value"> & { value: string }> {
  return cookies.map((cookie) => ({ ...cookie, value: "***" }));
}

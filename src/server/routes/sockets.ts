import type { FastifyInstance } from "fastify";
import { firefox, webkit, type BrowserType } from "playwright";
import WebSocket, { type RawData } from "ws";
import { dispatchWebhooks } from "../../automation.js";
import { launchCdpBrowser } from "../../cdp.js";
import { config } from "../../config.js";
import type { SessionManager } from "../../execution.js";
import { parseClientLaunchOptions } from "../input.js";
import type { Storage } from "../../storage.js";

export function registerSocketRoutes(input: {
  app: FastifyInstance;
  storage: Storage;
  sessions: SessionManager;
  requestKeyHash(request: unknown): string;
}): void {
  const { app, storage, sessions, requestKeyHash } = input;
  if (config.rawBrowserProtocolBridges) {
    app.get(
    "/chromium/playwright",
    { websocket: true },
    async (client, request) => {
      const query = request.query as {
        timeout?: unknown;
        record?: unknown;
        replay?: unknown;
        launch?: unknown;
        headless?: unknown;
      };
      const requestedTimeout =
        typeof query.timeout === "string"
          ? Number.parseInt(query.timeout, 10)
          : config.jobTimeoutMs;
      const ttl = Number.isSafeInteger(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 1000), config.jobTimeoutMs)
        : config.jobTimeoutMs;
      const launchOptions = parseClientLaunchOptions(query);
      if (launchOptions.headless === false && config.vncBridgeUrl)
        return client.close(1008, "Headful Playwright is reserved for live VNC sessions");
      const session = storage.createSession({
        ownerKeyHash: requestKeyHash(request),
        persistent: false,
        expiresAt: Date.now() + ttl,
        viewport: { width: 1280, height: 720 },
      });
      const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
      let upstream: WebSocket | undefined;
      client.on("message", (data: RawData, isBinary: boolean) => {
        if (upstream?.readyState === WebSocket.OPEN)
          upstream.send(data, { binary: isBinary });
        else pendingMessages.push({ data, isBinary });
      });
      const live = await sessions.get(session, undefined, launchOptions);
      if (query.record === "true" || query.replay === "true")
        await sessions.startTrace(session);
      upstream = new WebSocket(live.server.wsEndpoint());
      const cleanup = async (): Promise<void> => {
        const trace = await sessions.stopTrace(session.id);
        if (trace) {
          const artifact = await storage.createArtifact(
            trace,
            "application/zip",
            requestKeyHash(request),
            Math.ceil(ttl / 1000),
          );
          storage.createReplay(session.id, artifact.id, Math.ceil(ttl / 1000), requestKeyHash(request));
        }
        await sessions.close(session.id);
        await storage.deleteSession(session.id);
        await dispatchWebhooks(storage, requestKeyHash(request), "session.closed", {
          sessionId: session.id,
        });
      };
      upstream.on("open", () => {
        for (const message of pendingMessages.splice(0))
          upstream?.send(message.data, { binary: message.isBinary });
      });
      upstream.on("message", (data: RawData, isBinary: boolean) =>
        client.send(data, { binary: isBinary }),
      );
      upstream.on("close", () => client.close());
      upstream.on("error", () =>
        client.close(1011, "Playwright upstream error"),
      );
      client.once("close", () => {
        upstream?.close();
        void cleanup();
      });
      setTimeout(() => client.close(1000, "Session timeout"), ttl).unref();
    },
    );
  }
  app.get("/v1/sessions/:id/vnc", { websocket: true }, async (client, request) => {
    if (!config.vncBridgeUrl) return client.close(1013, "VNC viewer unavailable");
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !storage.getSession(id)?.liveViewer)
      return client.close(1008, "Session is not a live VNC session");
    const upstream = new WebSocket(config.vncBridgeUrl);
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => client.send(data, { binary: isBinary }));
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close(1011, "VNC bridge error"));
    client.once("close", () => upstream.close());
  });
  // Raw browser protocols can bypass application-level request interception. They
  // are intentionally off unless an operator provides a separate egress boundary.
  if (!config.rawBrowserProtocolBridges) return;
  const cdpCompatibilityHandler = async (
    client: WebSocket,
    request: { query: unknown },
  ) => {
    const query = request.query as {
      timeout?: unknown;
      launch?: unknown;
      headless?: unknown;
    };
    const requestedTimeout =
      typeof query.timeout === "string"
        ? Number.parseInt(query.timeout, 10)
        : config.jobTimeoutMs;
    const ttl = Number.isSafeInteger(requestedTimeout)
      ? Math.min(Math.max(requestedTimeout, 1000), config.jobTimeoutMs)
      : config.jobTimeoutMs;
    const launchOptions = parseClientLaunchOptions(query);
    if (launchOptions.headless === false && config.vncBridgeUrl)
      return client.close(1008, "Headful CDP is reserved for live VNC sessions");
    const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    let upstream: WebSocket | undefined;
    let browser: Awaited<ReturnType<typeof launchCdpBrowser>> | undefined;
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (upstream?.readyState === WebSocket.OPEN)
        upstream.send(data, { binary: isBinary });
      else pendingMessages.push({ data, isBinary });
    });
    const cleanup = async (): Promise<void> => {
      upstream?.close();
      await browser?.stop();
    };
    client.once("close", () => {
      void cleanup();
    });
    try {
      browser = await launchCdpBrowser(ttl, launchOptions);
      upstream = new WebSocket(browser.endpoint);
      upstream.on("open", () => {
        for (const message of pendingMessages.splice(0))
          upstream?.send(message.data, { binary: message.isBinary });
      });
      upstream.on("message", (data: RawData, isBinary: boolean) =>
        client.send(data, { binary: isBinary }),
      );
      upstream.on("close", () => client.close());
      upstream.on("error", () => client.close(1011, "CDP upstream error"));
      setTimeout(() => client.close(1000, "Session timeout"), ttl).unref();
    } catch {
      client.close(1011, "Could not start Chromium CDP session");
    }
  };
  app.get("/", { websocket: true }, cdpCompatibilityHandler);
  app.get("/chromium", { websocket: true }, cdpCompatibilityHandler);
  app.get("/chrome", { websocket: true }, cdpCompatibilityHandler);
  const nativePlaywrightHandler =
    (browserType: BrowserType) =>
    async (client: WebSocket, request: { query: unknown }) => {
      const query = request.query as {
        timeout?: unknown;
        launch?: unknown;
        headless?: unknown;
      };
      const requestedTimeout =
        typeof query.timeout === "string"
          ? Number.parseInt(query.timeout, 10)
          : config.jobTimeoutMs;
      const ttl = Number.isSafeInteger(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 1000), config.jobTimeoutMs)
        : config.jobTimeoutMs;
      const launchOptions = parseClientLaunchOptions(query);
      if (launchOptions.headless === false && config.vncBridgeUrl)
        return client.close(1008, "Headful Playwright is reserved for live VNC sessions");
      const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
      let upstream: WebSocket | undefined;
      let server: Awaited<ReturnType<BrowserType["launchServer"]>> | undefined;
      client.on("message", (data: RawData, isBinary: boolean) => {
        if (upstream?.readyState === WebSocket.OPEN)
          upstream.send(data, { binary: isBinary });
        else pendingMessages.push({ data, isBinary });
      });
      const cleanup = async (): Promise<void> => {
        upstream?.close();
        await server?.close();
      };
      client.once("close", () => {
        void cleanup();
      });
      try {
        server = await browserType.launchServer({
          headless: launchOptions.headless ?? true,
          ...(launchOptions.slowMo !== undefined
            ? { slowMo: launchOptions.slowMo }
            : {}),
          ...(launchOptions.acceptInsecureCerts !== undefined
            ? { ignoreHTTPSErrors: launchOptions.acceptInsecureCerts }
            : {}),
          ...(browserType.name() === "chromium" && launchOptions.args
            ? { args: launchOptions.args }
            : {}),
        });
        upstream = new WebSocket(server.wsEndpoint());
        upstream.on("open", () => {
          for (const message of pendingMessages.splice(0))
            upstream?.send(message.data, { binary: message.isBinary });
        });
        upstream.on("message", (data: RawData, isBinary: boolean) =>
          client.send(data, { binary: isBinary }),
        );
        upstream.on("close", () => client.close());
        upstream.on("error", () =>
          client.close(1011, "Playwright upstream error"),
        );
        setTimeout(() => client.close(1000, "Session timeout"), ttl).unref();
      } catch {
        client.close(1011, "Could not start Playwright browser session");
      }
    };
  app.get(
    "/firefox/playwright",
    { websocket: true },
    nativePlaywrightHandler(firefox),
  );
  app.get(
    "/webkit/playwright",
    { websocket: true },
    nativePlaywrightHandler(webkit),
  );
}

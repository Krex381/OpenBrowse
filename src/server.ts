import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import { Cache } from "./cache.js";
import { notifyOperationalAlert } from "./alerts.js";
import { AdmissionQueue } from "./queue.js";
import { BrowserPool, SessionManager } from "./execution.js";
import { Storage } from "./storage.js";
import { installRequestPolicies } from "./server/lifecycle.js";
import { createBqlHandler } from "./server/browserql-handler.js";
import { createExecutionCore } from "./server/execution-core.js";
import { registerSocketRoutes } from "./server/routes/sockets.js";
import { registerPublicRoutes } from "./server/routes/public.js";
import { registerMcpRoutes } from "./server/routes/mcp.js";
import { registerExecutionRoutes } from "./server/routes/execution.js";
import { registerContentRoutes } from "./server/routes/content.js";
import { registerSessionRoutes } from "./server/routes/sessions.js";
import { registerAdminRoutes } from "./server/routes/admin.js";
import { CdpReconnectManager } from "./cdp-reconnect.js";
import { registerReconnectableCdpRoutes } from "./server/routes/cdp-reconnect.js";
export interface Services {
  app: FastifyInstance;
  storage: Storage;
  pool: BrowserPool;
  sessions: SessionManager;
  queue: AdmissionQueue;
  cache: Cache;
  close(): Promise<void>;
}

function redactRequestUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value, "http://openbrowse.invalid");
    for (const key of new Set(url.searchParams.keys()))
      if (/token|key|secret|password|credential/i.test(key))
        url.searchParams.set(key, "[REDACTED]");
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}
export async function buildServer(): Promise<Services> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactRequestUrl(request.url),
            host: request.headers.host,
            remoteAddress: request.socket.remoteAddress,
            remotePort: request.socket.remotePort,
          };
        },
      },
    },
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => `req_${randomUUID().replaceAll("-", "")}`,
  });
  const storage = new Storage();
  await storage.initialize();
  const cache = new Cache(storage);
  const pool = new BrowserPool();
  const queue = new AdmissionQueue(() => {
    const stats = queue.stats();
    void notifyOperationalAlert("queue", {
      active: stats.active,
      pending: stats.pending,
      pressure: stats.pressure,
      estimatedJobMemoryMb: stats.estimatedJobMemoryMb,
    });
  }, () => pool.memorySnapshot());
  const sessions = new SessionManager();
  const cdp = new CdpReconnectManager();
  await app.register(swagger, {
    openapi: {
      info: {
        title: "OpenBrowse API",
        version: "1.0.0",
        description: "Self-hosted, HTTP-first browser execution gateway",
      },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  const { requestKeyHash, assertSessionOwner } = installRequestPolicies(
    app,
    storage,
  );

  registerPublicRoutes({ app, storage, pool, queue });
  const {
    resolveProxy,
    runFetch,
    executeAgentCommand,
    executeBqlField,
    bqlNetwork,
  } = createExecutionCore({ storage, cache, queue, pool, sessions });
  const bqlHandler = createBqlHandler({
    storage,
    queue,
    sessions,
    requestKeyHash,
    resolveProxy,
    executeBqlField,
    bqlNetwork,
  });
  app.post("/chromium/bql", bqlHandler);
  app.post("/chrome/bql", bqlHandler);
  registerMcpRoutes({
    app,
    storage,
    pool,
    queue,
    sessions,
    requestKeyHash,
    assertSessionOwner,
    resolveProxy,
    runFetch,
    executeAgentCommand,
  });
  registerExecutionRoutes({
    app,
    storage,
    pool,
    queue,
    resolveProxy,
    runFetch,
    requestKeyHash,
  });
  registerContentRoutes({ app, pool, queue, resolveProxy, runFetch, requestKeyHash });
  registerSessionRoutes({
    app,
    storage,
    sessions,
    requestKeyHash,
    assertSessionOwner,
    resolveProxy,
    executeAgentCommand,
  });
  registerReconnectableCdpRoutes({ app, cdp, requestKeyHash });
  registerAdminRoutes({ app, storage, cache, queue, pool, resolveProxy, requestKeyHash });
  registerSocketRoutes({ app, storage, sessions, requestKeyHash });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    storage,
    pool,
    sessions,
    queue,
    cache,
    close: () => {
      closePromise ??= (async () => {
        await app.close();
        await sessions.closeAll();
        await cdp.closeAll();
        await pool.close();
        storage.close();
      })();
      return closePromise;
    },
  };
}

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { notifyOperationalAlert } from "../../alerts.js";
import { config, type ApiKeyPolicy } from "../../config.js";
import { errorPageCsp, renderErrorPage } from "../../error-pages.js";
import { OpenBrowseError } from "../../errors.js";
import type { BrowserPool } from "../../execution.js";
import type { AdmissionQueue } from "../../queue.js";
import type { Storage } from "../../storage.js";

export function registerPublicRoutes(input: {
  app: FastifyInstance;
  storage: Storage;
  pool: BrowserPool;
  queue: AdmissionQueue;
}): void {
  const { app, storage, pool, queue } = input;
  const landingRoot = fileURLToPath(
    new URL("../../../public/landing/", import.meta.url),
  );
  const setLandingSecurityHeaders = () =>
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'";
  const sendLandingIndex = async (reply: FastifyReply) => {
    const landing = await readFile(resolve(landingRoot, "index.html"), "utf8");
    reply
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", setLandingSecurityHeaders())
      .header("Cache-Control", "no-cache");
    return landing;
  };
  app.get("/landing", async (_request, reply) => sendLandingIndex(reply));
  app.get("/landing/", async (_request, reply) => sendLandingIndex(reply));
  app.get("/browserql", async (_request, reply) => sendLandingIndex(reply));
  app.get("/viewer", async (_request, reply) => sendLandingIndex(reply));
  app.get("/landing/*", async (request, reply) => {
    const asset = (request.params as { "*": string })["*"];
    const assetPath = resolve(landingRoot, asset);
    const localPath = relative(landingRoot, assetPath);
    if (
      !asset ||
      asset.includes("\0") ||
      isAbsolute(asset) ||
      localPath.startsWith("..") ||
      isAbsolute(localPath)
    ) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .header("Content-Security-Policy", errorPageCsp())
        .header("Cache-Control", "no-store")
        .send(renderErrorPage(404));
    }
    const contentTypes: Record<string, string> = {
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    try {
      const file = await readFile(assetPath);
      return reply
        .type(contentTypes[extname(assetPath)] ?? "application/octet-stream")
        .header("Content-Security-Policy", setLandingSecurityHeaders())
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(file);
    } catch {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .header("Content-Security-Policy", errorPageCsp())
        .header("Cache-Control", "no-store")
        .send(renderErrorPage(404));
    }
  });
  app.get("/errors/:status", async (request, reply) => {
    const status = Number((request.params as { status: string }).status);
    const statusCode =
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 404;
    return reply
      .code(statusCode)
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", errorPageCsp())
      .header("Cache-Control", "no-store")
      .send(renderErrorPage(statusCode));
  });
  app.get("/blocked", async (_request, reply) =>
    reply
      .code(423)
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", errorPageCsp())
      .header("Cache-Control", "no-store")
      .send(renderErrorPage(423)),
  );
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/v1/") || request.url === "/mcp") {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: request.id,
        },
      });
    }
    return reply
      .code(404)
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", errorPageCsp())
      .header("Cache-Control", "no-store")
      .send(renderErrorPage(404));
  });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    await pool.refreshMemory();
    const memory = pool.memorySnapshot();
    const ready = memory.totalRssMb < config.memoryHardMb;
    if (!ready)
      void notifyOperationalAlert("health-failure", {
        rssMb: Math.round(memory.totalRssMb),
      });
    return reply.code(ready ? 200 : 503).send({
      ready,
      browserWorkers: pool.stats(),
    });
  });
  app.get("/metrics", async (_request, reply) => {
    await pool.refreshMemory();
    const stats = queue.stats();
    const browser = pool.stats();
    const memory = pool.memorySnapshot();
    reply.type("text/plain; version=0.0.4");
    const authority = memory.admissionAuthority === "cgroup" ? 1 : memory.admissionAuthority === "process-tree" ? 2 : 3;
    return `openbrowse_queue_depth ${stats.pending}\nopenbrowse_active_jobs ${stats.active}\nopenbrowse_memory_pressure ${stats.pressure === "normal" ? 0 : stats.pressure === "pressure" ? 1 : 2}\nopenbrowse_node_rss_megabytes ${memory.nodeRssMb.toFixed(1)}\nopenbrowse_browser_tree_rss_megabytes ${memory.browserRssMb.toFixed(1)}\nopenbrowse_process_tree_rss_megabytes ${memory.processTreeRssMb.toFixed(1)}\nopenbrowse_admission_rss_megabytes ${memory.totalRssMb.toFixed(1)}\nopenbrowse_memory_admission_authority ${authority}\nopenbrowse_browser_processes ${browser.processes}\nopenbrowse_browser_contexts ${browser.busy}\nopenbrowse_browser_workers_healthy ${browser.healthy}\nopenbrowse_browser_workers_draining ${browser.draining}\nopenbrowse_browser_workers_starting ${browser.starting}\nopenbrowse_browser_worker_launches_total ${browser.launches}\nopenbrowse_browser_worker_crashes_total ${browser.crashes}\nopenbrowse_browser_worker_recycles_total ${browser.recycled}\nopenbrowse_browser_worker_replacements_total ${browser.replacements}\n`;
  });
  app.get("/pressure", async () => {
    await pool.refreshMemory();
    const stats = queue.stats();
    const browser = pool.stats();
    const memory = pool.memorySnapshot();
    return {
      pressure: stats.pressure,
      memory: {
        rssMb: Number(memory.totalRssMb.toFixed(1)),
        admissionAuthority: memory.admissionAuthority,
        nodeRssMb: Number(memory.nodeRssMb.toFixed(1)),
        browserRssMb: Number(memory.browserRssMb.toFixed(1)),
        processTreeRssMb: Number(memory.processTreeRssMb.toFixed(1)),
        ...(memory.containerRssMb === undefined
          ? {}
          : { containerRssMb: Number(memory.containerRssMb.toFixed(1)) }),
        ...(memory.containerLimitMb === undefined
          ? {}
          : { containerLimitMb: Number(memory.containerLimitMb.toFixed(1)) }),
        processTreesSupported: memory.processTreesSupported,
        sampledAt: new Date(memory.sampledAt).toISOString(),
        softLimitMb: config.memorySoftMb,
        hardLimitMb: config.memoryHardMb,
      },
      sessions: {
        active: stats.active,
        queued: stats.pending,
        browserProcesses: browser.processes,
        browserContexts: browser.busy,
      },
      browserWorkers: browser,
    };
  });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/v1/usage", async (request) => {
    const keyedRequest = request as typeof request & {
      openbrowseKeyHash?: string;
      openbrowseKeyPolicy?: ApiKeyPolicy;
    };
    const keyHash = keyedRequest.openbrowseKeyHash;
    if (!keyHash)
      throw new OpenBrowseError(
        "UNAUTHORIZED",
        "A valid bearer API key is required",
        401,
      );
    const usage = storage.getUsage(keyHash);
    const dailyRequestLimit =
      keyedRequest.openbrowseKeyPolicy?.dailyRequestLimit ??
      config.dailyRequestLimit;
    return {
      keyId: keyHash.slice(0, 12),
      policy: keyedRequest.openbrowseKeyPolicy?.name ?? null,
      usage,
      quota: {
        dailyRequests: dailyRequestLimit || null,
        remaining:
          dailyRequestLimit > 0
            ? Math.max(0, dailyRequestLimit - usage.requests)
            : null,
      },
    };
  });
}

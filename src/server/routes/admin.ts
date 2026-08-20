import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { OpenBrowseError } from "../../errors.js";
import type { Cache } from "../../cache.js";
import type { AdmissionQueue } from "../../queue.js";
import {
  browserBackendCatalog,
  pdf,
  screenshot,
  type BrowserPool,
} from "../../execution.js";
import { assertSafeUrl } from "../../security.js";
import type { StoredProxy, Storage } from "../../storage.js";
import { parse, url, viewport } from "../input.js";

export function registerAdminRoutes(input: {
  app: FastifyInstance;
  storage: Storage;
  cache: Cache;
  queue: AdmissionQueue;
  pool: BrowserPool;
  resolveProxy(id: string | undefined, ownerKeyHash: string): Promise<StoredProxy | undefined>;
  requestKeyHash(request: FastifyRequest): string;
}): void {
  const { app, storage, cache, queue, pool, resolveProxy, requestKeyHash } = input;
  app.post("/v1/proxies", async (request) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(128),
        url: z
          .string()
          .url()
          .refine(
            (value) => ["http:", "https:"].includes(new URL(value).protocol),
            "Proxy must use http or https",
          ),
        allowedDomains: z
          .array(
            z
              .string()
              .min(1)
              .max(253)
              .regex(/^[a-z0-9.-]+$/i),
          )
          .max(100)
          .default([]),
      }),
      request.body,
    );
    const created = storage.createProxy(
      body.name,
      body.url,
      body.allowedDomains,
      requestKeyHash(request),
    );
    const parsed = new URL(body.url);
    return {
      id: created.id,
      name: created.name,
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    };
  });
  app.delete("/v1/proxies/:id", async (request) => ({
    deleted: storage.deleteProxy(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    ),
  }));
  app.post("/v1/webhooks", async (request) => {
    const body = parse(
      z.object({
        url,
        events: z
          .array(z.enum(["job.complete", "job.failed", "session.closed", "*"]))
          .min(1)
          .max(4),
      }),
      request.body,
    );
    await assertSafeUrl(body.url);
    const created = storage.createWebhook(body.url, body.events, requestKeyHash(request));
    return {
      id: created.id,
      url: created.url,
      events: created.events,
      secret: created.secret,
    };
  });
  app.delete("/v1/webhooks/:id", async (request) => ({
    deleted: storage.deleteWebhook(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    ),
  }));
  app.get("/v1/cache/stats", async () => cache.stats());
  app.post("/v1/cache/purge", async (request) => {
    if (!config.cachePurgeEnabled)
      throw new OpenBrowseError(
        "FEATURE_DISABLED",
        "Global cache purge is disabled by operator policy",
        501,
      );
    const body = parse(
      z
        .object({
          scope: z.enum(["all", "url"]),
          value: z.string().max(4096).optional(),
        })
        .superRefine((value, context) => {
          if (value.scope === "url" && !value.value)
            context.addIssue({
              code: "custom",
              message: "value is required for URL scope",
            });
        }),
      request.body,
    );
    return {
      purged: await cache.purge(body.scope === "url" ? body.value : undefined),
    };
  });
  app.post("/v1/jobs", async (request) => {
    const body = parse(
      z.object({
        operation: z.enum(["screenshot", "pdf"]),
        request: z.record(z.string(), z.unknown()),
        ttlSeconds: z.number().int().min(60).max(86400).default(3600),
      }),
      request.body,
    );
    const job = storage.createJob(
      body.operation,
      JSON.stringify(body.request),
      body.ttlSeconds,
      requestKeyHash(request),
    );
    void (async () => {
      try {
        storage.updateJob(job.id, job.ownerKeyHash, { status: "running" });
        if (body.operation === "screenshot") {
          const parsed = parse(
            z.object({
              url,
              format: z.enum(["png", "jpeg"]).default("png"),
              fullPage: z.boolean().default(true),
              quality: z.number().int().min(1).max(100).optional(),
              viewport: viewport.optional(),
              timeoutMs: z
                .number()
                .int()
                .min(100)
                .max(config.jobTimeoutMs)
                .optional(),
              waitUntil: z
                .enum(["load", "domcontentloaded", "networkidle"])
                .optional(),
              proxyId: z.string().optional(),
            }),
            body.request,
          );
          const proxy = await resolveProxy(parsed.proxyId, job.ownerKeyHash);
          const binary = await queue.run(
            () => screenshot(pool, { ...parsed, ...(proxy ? { proxy } : {}) }),
            "screenshot",
          );
          const artifact = await storage.createArtifact(
            binary.result,
            parsed.format === "jpeg" ? "image/jpeg" : "image/png",
            job.ownerKeyHash,
            body.ttlSeconds,
          );
          storage.updateJob(job.id, job.ownerKeyHash, {
            status: "complete",
            artifactId: artifact.id,
          });
        } else {
          const parsed = parse(
            z.object({
              url,
              format: z
                .enum(["A4", "Letter", "Legal", "A3", "A5"])
                .default("A4"),
              landscape: z.boolean().default(false),
              printBackground: z.boolean().default(true),
              margin: z
                .object({
                  top: z.string().max(16).optional(),
                  right: z.string().max(16).optional(),
                  bottom: z.string().max(16).optional(),
                  left: z.string().max(16).optional(),
                })
                .optional(),
              timeoutMs: z
                .number()
                .int()
                .min(100)
                .max(config.jobTimeoutMs)
                .optional(),
              proxyId: z.string().optional(),
            }),
            body.request,
          );
          const proxy = await resolveProxy(parsed.proxyId, job.ownerKeyHash);
          const binary = await queue.run(
            () => pdf(pool, { ...parsed, ...(proxy ? { proxy } : {}) }),
            "pdf",
          );
          const artifact = await storage.createArtifact(
            binary.result,
            "application/pdf",
            job.ownerKeyHash,
            body.ttlSeconds,
          );
          storage.updateJob(job.id, job.ownerKeyHash, {
            status: "complete",
            artifactId: artifact.id,
          });
        }
      } catch (error) {
        storage.updateJob(job.id, job.ownerKeyHash, {
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown job failure",
        });
      }
    })();
    return { id: job.id, status: job.status };
  });
  app.get("/v1/jobs/:id", async (request) => {
    const job = storage.getJob(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    );
    if (!job || job.expiresAt < Date.now())
      throw new OpenBrowseError(
        "JOB_NOT_FOUND",
        "Job does not exist or has expired",
        404,
      );
    return {
      id: job.id,
      status: job.status,
      ...(job.artifactId
        ? {
            artifact: {
              contentType:
                job.operation === "pdf" ? "application/pdf" : "image/png",
              downloadPath: `/v1/artifacts/${job.artifactId}`,
            },
          }
        : {}),
      ...(job.result ? { result: JSON.parse(job.result) as unknown } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  });
  app.get("/v1/artifacts/:id", async (request, reply) => {
    const artifact = await storage.getArtifact(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    );
    if (!artifact)
      throw new OpenBrowseError(
        "ARTIFACT_NOT_FOUND",
        "Artifact does not exist or has expired",
        404,
      );
    reply.type(artifact.artifact.contentType);
    reply.header("Content-Length", String(artifact.artifact.bytes));
    return reply.send(artifact.body);
  });
  app.get("/v1/capabilities", async () => ({
    execution: {
      planner: "deterministic-http-first-v1",
      defaultBackend: config.defaultBrowserBackend,
      browserBackends: browserBackendCatalog(),
      optionalBackends: {
        invisiblePlaywright: "replaced by the Node-native patchright-chromium backend",
        cloakBrowser: config.enabledBrowserBackends.has("cloakbrowser-chromium")
          ? "operator-enabled; applicable binary/OEM/SaaS license accepted by operator"
          : "installed integration; disabled until operator accepts licensing and enables the backend",
        camoufox: config.enabledBrowserBackends.has("camoufox-firefox")
          ? "operator-enabled; provision with npm run prepare:camoufox"
          : "installed integration; disabled until the operator provisions and enables the backend",
        clearcote: config.enabledBrowserBackends.has("clearcote-chromium")
          ? config.clearcoteExecutablePath
            ? "operator-enabled; executable path configured"
            : "enabled but unavailable until OPENBROWSE_CLEARCOTE_EXECUTABLE_PATH is configured"
          : "executable-path integration; disabled by default",
      },
    },
    browsers: {
      chromium: {
        playwright: config.rawBrowserProtocolBridges ? true : "disabled by operator policy",
        cdp: config.rawBrowserProtocolBridges ? "compatibility bridge at /, /chromium, /chrome; reconnectable sessions at /v1/cdp/sessions" : "disabled by operator policy",
      },
      firefox: {
        playwright: "native browser server; Docker image installs Firefox for Linux production hosts",
      },
      webkit: { playwright: true },
    },
    compatibility: {
      restAliases: [
        "/content",
        "/scrape",
        "/screenshot",
        "/pdf",
        "/smart-scrape",
        "/map",
        "/crawl",
        "/search",
        "/export",
        "/download",
        "/performance",
        "/unblock",
      ],
      playwrightWebSocket: config.rawBrowserProtocolBridges ? "/chromium/playwright" : "disabled by operator policy",
      browserqlStudio: "/browserql",
      liveViewer: config.vncBridgeUrl ? "/viewer (noVNC enabled)" : "/viewer (snapshot mode)",
      fullLighthouse: "/performance with engine=lighthouse",
      cachePurge: config.cachePurgeEnabled ? "operator-enabled" : "disabled by operator policy",
      searchProviderConfigured: Boolean(config.searchEndpoint),
    },
    policies: {
      captcha:
        "detect, bounded backend escalation, and authenticated human session handoff",
      stealth: "operator-selected backends only; never chosen from hostname or target response",
      fingerprintEvasion:
        "CloakBrowser and Clearcote accept bounded --fingerprint* arguments; Camoufox accepts typed backend options when operator-enabled",
      humanization:
        "CloakBrowser accepts bounded humanization configuration when operator-enabled",
      proxyRotation: "not implemented",
      extensions:
        config.chromiumExtensionDirs.length === 0
          ? "operator preloading supported; none configured"
          : `operator-preloaded (${config.chromiumExtensionDirs.length})`,
    },
  }));
}

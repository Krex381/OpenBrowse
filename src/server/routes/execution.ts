import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  basicPerformance,
  dispatchWebhooks,
  exportUrl,
  fullLighthouse,
  mapSite,
  searchWeb,
} from "../../automation.js";
import { config } from "../../config.js";
import { assertBoundedJson, jsonBytes } from "../../bounds.js";
import {
  browserDownload,
  recordVideo,
  runWorkflow,
  type BrowserPool,
} from "../../execution.js";
import type { AdmissionQueue } from "../../queue.js";
import { sendBinary } from "../presentation.js";
import {
  browserBackend,
  browserBackendOptions,
  fetchInput,
  parse,
  url,
  viewport,
  type ApiFetch,
} from "../input.js";
import type { StoredProxy, Storage } from "../../storage.js";

type FetchResponse = {
  requestId?: string;
  status: number;
  finalUrl: string;
  strategy: "http" | "browser";
  html?: string;
  markdown?: string;
  links?: string[];
};

export function registerExecutionRoutes(input: {
  app: FastifyInstance;
  storage: Storage;
  pool: BrowserPool;
  queue: AdmissionQueue;
  resolveProxy(id: string | undefined, ownerKeyHash: string): Promise<StoredProxy | undefined>;
  runFetch(body: ApiFetch & { ownerKeyHash: string }): Promise<FetchResponse>;
  requestKeyHash(request: FastifyRequest): string;
}): void {
  const { app, storage, pool, queue, resolveProxy, runFetch, requestKeyHash } = input;
  app.post("/v1/fetch", async (request) => {
    const response = await runFetch({ ...parse(fetchInput, request.body), ownerKeyHash: requestKeyHash(request) });
    return { ...response, requestId: request.id };
  });
  // Browserless REST-compatible aliases. Query-string token auth is accepted only on these aliases for migration compatibility.
  app.post("/smart-scrape", async (request) => {
    const body = parse(
      z.object({
        url,
        formats: z
          .array(z.enum(["html", "markdown", "links"]))
          .default(["markdown"]),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const response = await runFetch({
      url: body.url,
      strategy: "auto",
      ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      output: body.formats,
      cache: { mode: "default", ttlSeconds: 300 },
      ownerKeyHash: requestKeyHash(request),
    });
    return { ...response, requestId: request.id };
  });
  app.post("/scrape", async (request) => {
    const body = parse(
      z.object({
        url,
        elements: z
          .array(
            z.object({
              selector: z.string().min(1).max(512),
              attributes: z
                .array(z.string().min(1).max(128))
                .max(25)
                .optional(),
            }),
          )
          .min(1)
          .max(100),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const response = await runFetch({
      url: body.url,
      strategy: "browser",
      ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      output: ["html"],
      cache: { mode: "no-store", ttlSeconds: 1 },
      ownerKeyHash: requestKeyHash(request),
    });
    const html = String(response.html ?? "");
    const $ = (await import("cheerio")).load(html);
    return assertBoundedJson({
      data: body.elements.map((element) => ({
        selector: element.selector,
        results: $(element.selector)
          .map((_index, node) => ({
            text: $(node).text().trim(),
            html: $(node).html() ?? "",
            attributes: Object.fromEntries(
              (element.attributes ?? []).map((attribute) => [
                attribute,
                $(node).attr(attribute) ?? null,
              ]),
            ),
          }))
          .get(),
      })),
      strategy: response.strategy,
    }, "Scrape response");
  });
  app.post("/map", async (request) => {
    const body = parse(
      z.object({
        url,
        maxUrls: z.number().int().min(1).max(1000).optional(),
        maxDepth: z.number().int().min(0).max(10).optional(),
        include: z.array(z.string().max(256)).max(50).optional(),
        exclude: z.array(z.string().max(256)).max(50).optional(),
        search: z.string().max(256).optional(),
        render: z.enum(["auto", "http", "browser"]).default("auto"),
      }),
      request.body,
    );
    return {
      urls: await queue
        .run(() => mapSite(pool, body.url, body), "automation")
        .then((scheduled) => scheduled.result),
    };
  });
  app.post("/crawl", async (request) => {
    const body = parse(
      z.object({
        url,
        maxUrls: z.number().int().min(1).max(250).default(50),
        maxDepth: z.number().int().min(0).max(5).default(2),
        formats: z
          .array(z.enum(["html", "markdown", "links"]))
          .default(["markdown"]),
        ttlSeconds: z.number().int().min(60).max(86400).default(3600),
      }),
      request.body,
    );
    const job = storage.createJob(
      "crawl",
      JSON.stringify(body),
      body.ttlSeconds,
      requestKeyHash(request),
    );
    void (async () => {
      try {
        storage.updateJob(job.id, job.ownerKeyHash, { status: "running" });
        const urls = await mapSite(pool, body.url, body);
        const pages: Array<Record<string, unknown>> = [];
        let truncated = false;
        for (const item of urls) {
          let page: Record<string, unknown>;
          try {
            const result = await runFetch({
              url: item.url,
              strategy: "auto",
              output: body.formats,
              cache: { mode: "default", ttlSeconds: 300 },
              ownerKeyHash: job.ownerKeyHash,
            });
            page = {
              url: item.url,
              status: result.status,
              strategy: result.strategy,
              markdown: result.markdown,
              links: result.links,
            };
          } catch (error) {
            page = {
              url: item.url,
              error: error instanceof Error ? error.message : "crawl failed",
            };
          }
          if (jsonBytes({ pages: [...pages, page], truncated: false }) > config.maxResponseBytes) {
            truncated = true;
            break;
          }
          pages.push(page);
        }
        storage.updateJob(job.id, job.ownerKeyHash, {
          status: "complete",
          result: JSON.stringify({ pages, truncated }),
        });
        await dispatchWebhooks(storage, job.ownerKeyHash, "job.complete", {
          jobId: job.id,
          operation: "crawl",
          pages: pages.length,
        });
      } catch (error) {
        storage.updateJob(job.id, job.ownerKeyHash, {
          status: "failed",
          error: error instanceof Error ? error.message : "crawl failed",
        });
        await dispatchWebhooks(storage, job.ownerKeyHash, "job.failed", {
          jobId: job.id,
          operation: "crawl",
        });
      }
    })();
    return { id: job.id, status: "queued" };
  });
  app.post("/search", async (request) => {
    const body = parse(
      z.object({
        query: z.string().min(1).max(512),
        categories: z.enum(["general", "news", "images"]).default("general"),
        limit: z.number().int().min(1).max(20).default(10),
        scrape: z.boolean().default(false),
        formats: z
          .array(z.enum(["html", "markdown", "links"]))
          .default(["markdown"]),
      }),
      request.body,
    );
    const results = await searchWeb(
      config.searchEndpoint,
      body.query,
      body.categories,
      body.limit,
    );
    if (!body.scrape) return { results };
    const enriched: Array<Record<string, unknown>> = [];
    for (const result of results) {
      const item = await (async () => {
        try {
          const fetched = await runFetch({
            url: result.url,
            strategy: "auto",
            output: body.formats,
            cache: { mode: "default", ttlSeconds: 300 },
            ownerKeyHash: requestKeyHash(request),
          });
          return {
            ...result,
            scrape: {
              strategy: fetched.strategy,
              html: fetched.html,
              markdown: fetched.markdown,
              links: fetched.links,
            },
          };
        } catch (error) {
          return {
            ...result,
            scrapeError:
              error instanceof Error ? error.message : "scrape failed",
          };
        }
      })();
      assertBoundedJson({ results: [...enriched, item] }, "Search response");
      enriched.push(item);
    }
    return { results: enriched };
  });
  app.post("/export", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        includeResources: z.boolean().default(false),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const exported = await exportUrl({
      url: body.url,
      ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      includeResources: body.includeResources,
    });
    reply.header("X-OpenBrowse-Final-URL", exported.finalUrl);
    reply.type(exported.contentType);
    return reply.send(exported.body);
  });
  app.post("/performance", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
        engine: z.enum(["lighthouse", "bounded"]).default("bounded"),
        config: z
          .object({
            settings: z
              .object({
                onlyCategories: z
                  .array(
                    z.enum([
                      "accessibility",
                      "best-practices",
                      "performance",
                      "pwa",
                      "seo",
                    ]),
                  )
                  .max(5)
                  .optional(),
                onlyAudits: z
                  .array(z.string().min(1).max(128))
                  .max(100)
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
      request.body,
    );
    const options = {
      categories: body.config?.settings?.onlyCategories,
      audits: body.config?.settings?.onlyAudits,
    };
    if (body.engine === "bounded")
      return {
        audits: await queue
        .run(
          () =>
            basicPerformance(
              pool,
              { url: body.url, ...(body.timeout ? { timeoutMs: body.timeout } : {}) },
              { ...options, categories: options.categories?.filter((category) => category !== "pwa") },
            ),
          "automation",
        )
          .then((scheduled) => scheduled.result),
        engine: "openbrowse-hardened-performance-v1",
      };
    if (!config.lighthouseEnabled)
      return reply
        .code(501)
        .send({
          error: {
            code: "FEATURE_DISABLED",
            message:
              "Lighthouse is disabled. Enable OPENBROWSE_LIGHTHOUSE_ENABLED only in an isolated browser-worker deployment with egress controls.",
            requestId: request.id,
          },
        });
    const lighthouse = await queue
      .run(() => fullLighthouse(body.url, { ...(body.timeout ? { timeoutMs: body.timeout } : {}), ...options }), "automation")
      .then((scheduled) => scheduled.result);
    const artifact = await storage.createArtifact(
      lighthouse.rawJson,
      "application/json",
      requestKeyHash(request),
      3600,
    );
    return {
      audits: lighthouse.report,
      engine: "lighthouse",
      rawReport: {
        artifactId: artifact.id,
        downloadPath: `/v1/artifacts/${artifact.id}`,
        bytes: artifact.bytes,
      },
    };
  });
  app.post("/unblock", async (request) => {
    const body = parse(
      z.object({
        url,
        content: z.boolean().default(true),
        cookies: z.boolean().default(false),
        screenshot: z.boolean().default(false),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const result = await runFetch({
      url: body.url,
      strategy: "browser",
      ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      output: ["html"],
      cache: { mode: "no-store", ttlSeconds: 1 },
      ownerKeyHash: requestKeyHash(request),
    });
    return {
      status: result.status,
      ...(body.content ? { html: result.html } : {}),
      ...(body.screenshot
        ? { screenshot: "Use /screenshot for binary output" }
        : {}),
      policy:
        "Detected challenges are retried once per configured browser backend. The response reports backendAttempts and challengeRemaining; no external CAPTCHA-solving service is used.",
    };
  });
  const workflowSchema = z.object({
    url,
    timeoutMs: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
    viewport: viewport.optional(),
    browserBackend: browserBackend.optional(),
    browserOptions: browserBackendOptions.optional(),
    proxyId: z.string().optional(),
    steps: z
      .array(
        z.discriminatedUnion("action", [
          z.object({
            action: z.literal("wait"),
            selector: z.string().min(1).max(512),
          }),
          z.object({
            action: z.literal("click"),
            selector: z.string().min(1).max(512),
            index: z.number().int().min(0).max(99).optional(),
          }),
          z.object({
            action: z.literal("fill"),
            selector: z.string().min(1).max(512),
            value: z.string().max(10000),
          }),
          z.object({
            action: z.literal("press"),
            selector: z.string().min(1).max(512),
            key: z.string().min(1).max(64),
          }),
          z
            .object({
              action: z.literal("extract"),
              name: z.string().min(1).max(128),
              selector: z.string().min(1).max(512),
              type: z.enum(["text", "html", "attribute"]),
              attribute: z.string().max(128).optional(),
              all: z.boolean().optional(),
            })
            .superRefine((value, context) => {
              if (value.type === "attribute" && !value.attribute)
                context.addIssue({
                  code: "custom",
                  message: "attribute is required for attribute extraction",
                });
            }),
        ]),
      )
      .min(1)
      .max(30),
  });
  const workflowHandler = async (request: FastifyRequest) => {
    const body = parse(workflowSchema, request.body);
    const proxy = await resolveProxy(body.proxyId, requestKeyHash(request));
    return queue
      .run(
        () =>
          runWorkflow(
          pool,
          {
            url: body.url,
            ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
            ...(body.viewport ? { viewport: body.viewport } : {}),
            ...(body.browserBackend
              ? { browserBackend: body.browserBackend }
              : {}),
            ...(body.browserOptions
              ? { browserOptions: body.browserOptions }
              : {}),
            ...(proxy ? { proxy } : {}),
          },
          body.steps,
          ),
        "workflow",
      )
      .then((scheduled) => scheduled.result);
  };
  app.post("/v1/workflows/run", workflowHandler);
  app.post("/function", workflowHandler);
  app.post("/download", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        selector: z.string().min(1).max(512),
        index: z.number().int().min(0).max(99).default(0),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
        proxyId: z.string().optional(),
      }),
      request.body,
    );
    const proxy = await resolveProxy(body.proxyId, requestKeyHash(request));
    const downloaded = await queue
      .run(
        () =>
          browserDownload(pool, {
          url: body.url,
          selector: body.selector,
          index: body.index,
          ...(body.timeout ? { timeoutMs: body.timeout } : {}),
          ...(proxy ? { proxy } : {}),
          }),
        "download",
      )
      .then((scheduled) => scheduled.result);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${downloaded.filename.replaceAll('"', "_")}"`,
    );
    reply.header("X-OpenBrowse-Source-URL", downloaded.sourceUrl);
    return sendBinary(
      reply,
      downloaded.body,
      downloaded.contentType,
      request.id,
    );
  });
  app.post("/v1/recordings", async (request) => {
    const body = parse(
      z.object({
        url,
        durationMs: z.number().int().min(0).max(10000).default(1500),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.jobTimeoutMs)
          .optional(),
        viewport: viewport.optional(),
        browserBackend: browserBackend.optional(),
        browserOptions: browserBackendOptions.optional(),
        proxyId: z.string().optional(),
        ttlSeconds: z.number().int().min(60).max(86400).default(3600),
      }),
      request.body,
    );
    const proxy = await resolveProxy(body.proxyId, requestKeyHash(request));
    const recording = await queue
      .run(
        () =>
          recordVideo(pool, {
          url: body.url,
          durationMs: body.durationMs,
          ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.viewport ? { viewport: body.viewport } : {}),
          ...(body.browserBackend
            ? { browserBackend: body.browserBackend }
            : {}),
          ...(body.browserOptions ? { browserOptions: body.browserOptions } : {}),
          ...(proxy ? { proxy } : {}),
          }),
        "automation",
      )
      .then((scheduled) => scheduled.result);
    const artifact = await storage.createArtifact(
      recording.body,
      "video/webm",
      requestKeyHash(request),
      body.ttlSeconds,
    );
    return {
      id: artifact.id,
      contentType: artifact.contentType,
      bytes: artifact.bytes,
      finalUrl: recording.finalUrl,
      execution: recording.execution,
      downloadPath: `/v1/artifacts/${artifact.id}`,
    };
  });
}

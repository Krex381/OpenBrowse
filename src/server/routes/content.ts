import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { extract, pdf, screenshot, type BrowserPool } from "../../execution.js";
import type { AdmissionQueue } from "../../queue.js";
import { sendBinary, statusCard } from "../presentation.js";
import {
  parse,
  selector,
  strategy,
  url,
  viewport,
  type ApiFetch,
} from "../input.js";
import type { StoredProxy } from "../../storage.js";

type FetchResponse = {
  finalUrl: string;
  strategy: "http" | "browser";
  html?: string;
};

export function registerContentRoutes(input: {
  app: FastifyInstance;
  pool: BrowserPool;
  queue: AdmissionQueue;
  resolveProxy(id: string | undefined, ownerKeyHash: string): Promise<StoredProxy | undefined>;
  runFetch(body: ApiFetch & { ownerKeyHash: string }): Promise<FetchResponse>;
  requestKeyHash(request: FastifyRequest): string;
}): void {
  const { app, pool, queue, resolveProxy, runFetch, requestKeyHash } = input;
  app.post("/v1/content", async (request) => {
    const body = parse(
      z.object({
        url,
        render: strategy.default("auto"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.jobTimeoutMs)
          .optional(),
        proxyId: z.string().optional(),
      }),
      request.body,
    );
    const response = await runFetch({
      url: body.url,
      strategy: body.render,
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.proxyId ? { proxyId: body.proxyId } : {}),
      output: ["html"],
      cache: { mode: "default", ttlSeconds: 300 },
      ownerKeyHash: requestKeyHash(request),
    });
    return {
      html: response.html,
      finalUrl: response.finalUrl,
      strategy: response.strategy,
    };
  });
  app.post("/content", async (request, reply) => {
    const body = parse(
      z
        .object({
          url: url.optional(),
          html: z.string().max(config.maxResponseBytes).optional(),
          timeout: z
            .number()
            .int()
            .min(100)
            .max(config.jobTimeoutMs)
            .optional(),
        })
        .refine(
          (value) => Boolean(value.url || value.html),
          "url or html is required",
        ),
      request.body,
    );
    if (body.html) {
      reply.type("text/html; charset=utf-8");
      return body.html;
    }
    const response = await runFetch({
      url: body.url!,
      strategy: "browser",
      ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      output: ["html"],
      cache: { mode: "no-store", ttlSeconds: 1 },
      ownerKeyHash: requestKeyHash(request),
    });
    reply.type("text/html; charset=utf-8");
    return response.html ?? "";
  });
  app.post("/v1/extract", async (request) => {
    const body = parse(
      z.object({
        url,
        strategy,
        selectors: z
          .record(z.string().min(1).max(128), selector)
          .refine(
            (values) => Object.keys(values).length <= 100,
            "At most 100 selectors are allowed",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.jobTimeoutMs)
          .optional(),
        proxyId: z.string().optional(),
      }),
      request.body,
    );
    const response = await runFetch({
      url: body.url,
      strategy: body.strategy,
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.proxyId ? { proxyId: body.proxyId } : {}),
      output: ["html"],
      cache: { mode: "default", ttlSeconds: 300 },
      ownerKeyHash: requestKeyHash(request),
    });
    return {
      data: extract(
        String(response.html ?? ""),
        String(response.finalUrl),
        body.selectors,
      ),
      strategy: response.strategy,
    };
  });
  app.post("/v1/screenshot", async (request, reply) => {
    const body = parse(
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
      request.body,
    );
    const proxy = await resolveProxy(body.proxyId, requestKeyHash(request));
    const scheduled = await queue.run(
      () => screenshot(pool, { ...body, ...(proxy ? { proxy } : {}) }),
      "screenshot",
    );
    return sendBinary(
      reply,
      scheduled.result,
      body.format === "jpeg" ? "image/jpeg" : "image/png",
      request.id,
    );
  });
  app.post("/screenshot", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        options: z
          .object({
            type: z.enum(["png", "jpeg"]).optional(),
            fullPage: z.boolean().optional(),
            quality: z.number().int().min(1).max(100).optional(),
          })
          .default({}),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const scheduled = await queue.run(
      () => screenshot(pool, {
        url: body.url,
        format: body.options.type,
        fullPage: body.options.fullPage,
        quality: body.options.quality,
        ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      }),
      "screenshot",
    );
    return sendBinary(
      reply,
      scheduled.result,
      body.options.type === "jpeg" ? "image/jpeg" : "image/png",
      request.id,
    );
  });
  app.post("/v1/pdf", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).default("A4"),
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
      request.body,
    );
    const proxy = await resolveProxy(body.proxyId, requestKeyHash(request));
    const scheduled = await queue.run(
      () => pdf(pool, { ...body, ...(proxy ? { proxy } : {}) }),
      "pdf",
    );
    return sendBinary(reply, scheduled.result, "application/pdf", request.id);
  });
  app.post("/pdf", async (request, reply) => {
    const body = parse(
      z.object({
        url,
        options: z
          .object({
            format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
            landscape: z.boolean().optional(),
            printBackground: z.boolean().optional(),
            margin: z
              .object({
                top: z.string().max(16).optional(),
                right: z.string().max(16).optional(),
                bottom: z.string().max(16).optional(),
                left: z.string().max(16).optional(),
              })
              .optional(),
          })
          .default({}),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      }),
      request.body,
    );
    const scheduled = await queue.run(
      () => pdf(pool, {
        url: body.url,
        ...body.options,
        ...(body.timeout ? { timeoutMs: body.timeout } : {}),
      }),
      "pdf",
    );
    return sendBinary(reply, scheduled.result, "application/pdf", request.id);
  });
  app.post("/v1/svg", async (request, reply) => {
    const body = parse(
      z.object({
        template: z.literal("status-card"),
        width: z.number().int().min(100).max(2048),
        height: z.number().int().min(80).max(2048),
        theme: z.enum(["light", "dark"]).default("light"),
        data: z.record(z.string().max(64), z.string().max(500)),
      }),
      request.body,
    );
    reply.type("image/svg+xml; charset=utf-8");
    return statusCard(body.width, body.height, body.theme, body.data);
  });
}

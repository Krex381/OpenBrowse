import { z } from "zod";
import { config } from "../../config.js";
export const url = z.string().url().max(4096);
export const strategy = z
  .enum(["auto", "http", "quickjs", "browser"])
  .default("auto");
export const viewport = z.object({
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(3).optional(),
});
export const fetchInput = z.object({
  url,
  strategy,
  timeoutMs: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  output: z
    .array(z.enum(["html", "markdown", "links"]))
    .max(3)
    .default(["html"]),
  cache: z
    .object({
      mode: z.enum(["default", "no-store", "reload"]).default("default"),
      ttlSeconds: z.number().int().min(1).max(86400).default(300),
    })
    .default({ mode: "default", ttlSeconds: 300 }),
  proxyId: z
    .string()
    .regex(/^pxy_[a-z0-9]+$/)
    .optional(),
  viewport: viewport.optional(),
});
export const selector = z
  .object({
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
  });
export type ApiFetch = z.infer<typeof fetchInput>;

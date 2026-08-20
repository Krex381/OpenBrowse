import { z } from "zod";
import { config } from "../../config.js";
import {
  browserBackendIds,
  humanizationConfigKeys,
} from "../../execution/types.js";
export const url = z.string().url().max(4096);
export const strategy = z
  .enum(["auto", "http", "browser"])
  .default("auto");
export const viewport = z.object({
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(3).optional(),
});
export const browserWait = z.discriminatedUnion("type", [
  z.object({ type: z.literal("domcontentloaded") }),
  z.object({ type: z.literal("load") }),
  z.object({
    type: z.literal("networkidle"),
    timeoutMs: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
  }),
  z.object({
    type: z.literal("selector"),
    selector: z.string().min(1).max(512),
    state: z.enum(["attached", "visible"]).optional(),
  }),
  z.object({
    type: z.literal("delay"),
    ms: z.number().int().min(1).max(config.jobTimeoutMs),
  }),
  z.object({
    type: z.literal("stability"),
    quietMs: z.number().int().min(100).max(2_000).optional(),
    timeoutMs: z.number().int().min(250).max(config.jobTimeoutMs).optional(),
  }),
]);
export const browserBackendOptions = z
  .object({
    fingerprintArgs: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(
            /^--fingerprint(?:-[a-z0-9-]+)?(?:=[^\u0000-\u001f\u007f]*)?$/i,
            "Only --fingerprint and --fingerprint-* Chromium arguments are allowed",
          ),
      )
      .max(32)
      .optional(),
    humanize: z.boolean().optional(),
    humanPreset: z.enum(["default", "careful"]).optional(),
    humanConfig: z
      .partialRecord(
        z.enum(humanizationConfigKeys),
        z.union([
          z.number().finite().min(0).max(10_000),
          z.boolean(),
          z.tuple([
            z.number().finite().min(0).max(10_000),
            z.number().finite().min(0).max(10_000),
          ]),
        ]),
      )
      .optional(),
    camoufox: z
      .object({
        os: z.enum(["windows", "macos", "linux"]).optional(),
        locale: z
          .union([
            z.string().min(2).max(35),
            z.array(z.string().min(2).max(35)).min(1).max(8),
          ])
          .optional(),
        humanize: z
          .union([z.boolean(), z.number().finite().min(0).max(10)])
          .optional(),
        blockImages: z.boolean().optional(),
        blockWebrtc: z.boolean().optional(),
        enableCache: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [key, setting] of Object.entries(value.humanConfig ?? {})) {
      if (Array.isArray(setting) && setting[0] > setting[1])
        context.addIssue({
          code: "custom",
          path: ["humanConfig", key],
          message: "Humanization ranges must be ordered [minimum, maximum]",
        });
      if (
        /(?:chance|variance|_x_range|target_zone)$/.test(key) &&
        (typeof setting === "number" ? setting > 1 : false)
      )
        context.addIssue({
          code: "custom",
          path: ["humanConfig", key],
          message: "Probability humanization settings must be between 0 and 1",
        });
    }
  });

export const browserBackend = z.enum(browserBackendIds);

export const fetchInput = z.object({
  url,
  strategy,
  timeoutMs: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  wait: browserWait.optional(),
  output: z
    .array(z.enum(["html", "text", "markdown", "links", "metadata", "article", "provenance"]))
    .max(7)
    .default(["html"]),
  browserBackend: browserBackend.optional(),
  browserOptions: browserBackendOptions.optional(),
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
}).superRefine((value, context) => {
  if (value.wait && value.waitUntil)
    context.addIssue({
      code: "custom",
      path: ["wait"],
      message: "wait and waitUntil cannot be used together",
    });
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

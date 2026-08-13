import { z } from "zod";
import { config } from "../../config.js";
import { url } from "./schemas.js";
const agentWaitUntil = z.enum(["load", "domcontentloaded", "networkidle"]);
export const agentCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("goto"),
    params: z.object({ url, waitUntil: agentWaitUntil.optional() }),
  }),
  z.object({
    method: z.enum(["back", "forward", "reload"]),
    params: z.object({ waitUntil: agentWaitUntil.optional() }).default({}),
  }),
  z.object({
    method: z.literal("snapshot"),
    params: z
      .object({ maxElements: z.number().int().min(1).max(500).default(100) })
      .default({ maxElements: 100 }),
  }),
  z.object({
    method: z.literal("text"),
    params: z.object({ selector: z.string().min(1).max(512) }),
  }),
  z.object({
    method: z.literal("html"),
    params: z
      .object({ selector: z.string().min(1).max(512).optional() })
      .default({}),
  }),
  z.object({
    method: z.literal("evaluate"),
    params: z.object({ content: z.string().min(1).max(10000) }),
  }),
  z.object({
    method: z.literal("click"),
    params: z.object({ selector: z.string().min(1).max(512) }),
  }),
  z.object({
    method: z.literal("type"),
    params: z.object({
      selector: z.string().min(1).max(512),
      text: z.string().max(10000),
    }),
  }),
  z.object({
    method: z.literal("select"),
    params: z.object({
      selector: z.string().min(1).max(512),
      value: z.string().max(2048),
    }),
  }),
  z.object({
    method: z.literal("checkbox"),
    params: z.object({
      selector: z.string().min(1).max(512),
      checked: z.boolean().default(true),
    }),
  }),
  z.object({
    method: z.literal("hover"),
    params: z.object({ selector: z.string().min(1).max(512) }),
  }),
  z.object({
    method: z.literal("scroll"),
    params: z
      .object({
        selector: z.string().min(1).max(512).optional(),
        direction: z.enum(["up", "down", "left", "right"]).default("down"),
      })
      .default({ direction: "down" }),
  }),
  z.object({
    method: z.literal("waitForSelector"),
    params: z.object({
      selector: z.string().min(1).max(512),
      timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
    }),
  }),
  z.object({
    method: z.literal("waitForNavigation"),
    params: z
      .object({
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      })
      .default({}),
  }),
  z.object({
    method: z.literal("waitForTimeout"),
    params: z.object({
      time: z.number().int().min(0).max(config.jobTimeoutMs),
    }),
  }),
  z.object({
    method: z.literal("waitForRequest"),
    params: z
      .object({
        url: z.string().min(1).max(512).optional(),
        method: z.string().min(1).max(16).optional(),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      })
      .default({}),
  }),
  z.object({
    method: z.literal("waitForResponse"),
    params: z
      .object({
        url: z.string().min(1).max(512).optional(),
        statuses: z
          .array(z.number().int().min(100).max(599))
          .max(50)
          .optional(),
        timeout: z.number().int().min(100).max(config.jobTimeoutMs).optional(),
      })
      .default({}),
  }),
  z.object({ method: z.literal("liveURL"), params: z.object({}).default({}) }),
  z.object({ method: z.literal("close"), params: z.object({}).default({}) }),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;

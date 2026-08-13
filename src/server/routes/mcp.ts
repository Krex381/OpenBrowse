import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mapSite } from "../../automation.js";
import { config } from "../../config.js";
import { OpenBrowseError } from "../../errors.js";
import {
  extract,
  screenshot,
  type BrowserPool,
  type SessionManager,
} from "../../execution.js";
import type { AdmissionQueue } from "../../queue.js";
import { normalizeUrl } from "../../security.js";
import type { StoredProxy, StoredSession, Storage } from "../../storage.js";
import {
  agentCommandSchema,
  parse,
  selector,
  url,
  type AgentCommand,
  type ApiFetch,
} from "../input.js";
import {
  mcpError,
  mcpReply,
  mcpText,
  mcpTools,
  validateMcpOrigin,
  type McpId,
} from "../mcp.js";

type FetchResponse = { html?: string; finalUrl: string; strategy: string };

export function registerMcpRoutes(input: {
  app: FastifyInstance;
  storage: Storage;
  pool: BrowserPool;
  queue: AdmissionQueue;
  sessions: SessionManager;
  requestKeyHash(request: unknown): string;
  assertSessionOwner(request: unknown, session: StoredSession): void;
  resolveProxy(id: string | undefined, ownerKeyHash?: string): Promise<StoredProxy | undefined>;
  runFetch(body: ApiFetch & { ownerKeyHash?: string }): Promise<FetchResponse>;
  executeAgentCommand(
    session: StoredSession,
    command: AgentCommand,
  ): Promise<unknown>;
}): void {
  const {
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
  } = input;
  app.post("/mcp", async (request, reply) => {
    validateMcpOrigin(request);
    const message = request.body as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    const id: McpId =
      typeof message.id === "string" ||
      typeof message.id === "number" ||
      message.id === null
        ? message.id
        : null;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return reply
        .code(400)
        .send(mcpError(id, -32600, "Invalid JSON-RPC request"));
    if (message.id === undefined) return reply.code(202).send();
    if (message.method === "initialize")
      return mcpReply(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "openbrowse", version: "0.1.0" },
      });
    if (message.method === "server/discover")
      return mcpReply(id, {
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "openbrowse", version: "0.1.0" },
      });
    if (message.method === "ping") return mcpReply(id, {});
    if (message.method === "tools/list")
      return mcpReply(id, { tools: mcpTools });
    if (message.method !== "tools/call")
      return mcpError(id, -32601, "Method not found");
    const params = message.params as { name?: unknown; arguments?: unknown };
    if (!params || typeof params.name !== "string")
      return mcpError(id, -32602, "tools/call requires a tool name");
    try {
      let answer: unknown;
      if (params.name === "browserless_agent") {
        const body = parse(
          z.object({
            sessionId: z
              .string()
              .regex(/^ses_[a-z0-9]+$/)
              .optional(),
            profileId: z
              .string()
              .regex(/^prf_[a-z0-9]+$/)
              .optional(),
            profileName: z.string().trim().min(1).max(100).optional(),
            ttlSeconds: z
              .number()
              .int()
              .min(60)
              .max(config.maxSessionTtlSeconds)
              .default(900),
            persistent: z.boolean().default(false),
            commands: z.array(agentCommandSchema).min(1).max(20),
          }),
          params.arguments,
        );
        const existing = body.sessionId
          ? storage.getSession(body.sessionId)
          : undefined;
        if (body.sessionId && !existing)
          throw new OpenBrowseError(
            "SESSION_NOT_FOUND",
            "Agent session does not exist or has expired",
            404,
          );
        if (existing) assertSessionOwner(request, existing);
        if (existing && (body.profileId || body.profileName))
          throw new OpenBrowseError(
            "INVALID_REQUEST",
            "A profile may only be used when creating an agent session",
            400,
          );
        if (body.profileId && body.profileName)
          throw new OpenBrowseError(
            "INVALID_REQUEST",
            "Provide profileId or profileName, not both",
            400,
          );
        const profile = body.profileId
          ? storage.getBrowserProfile(body.profileId, requestKeyHash(request))
          : body.profileName
            ? storage.getBrowserProfileByName(
                body.profileName,
                requestKeyHash(request),
              )
            : undefined;
        if ((body.profileId || body.profileName) && !profile)
          throw new OpenBrowseError(
            "PROFILE_NOT_FOUND",
            "Browser profile does not exist",
            404,
          );
        const session =
          existing ??
          storage.createSession({
            ownerKeyHash: requestKeyHash(request),
            persistent: body.persistent,
            expiresAt: Date.now() + body.ttlSeconds * 1000,
            viewport: { width: 1280, height: 720 },
            ...(profile ? { storageState: profile.storageState } : {}),
          });
        const results: unknown[] = [];
        let closed = false;
        for (const command of body.commands) {
          if (closed)
            throw new OpenBrowseError(
              "INVALID_REQUEST",
              "close must be the final agent command",
              400,
            );
          results.push({
            method: command.method,
            result: await executeAgentCommand(session, command),
          });
          closed = command.method === "close";
        }
        if (!closed && session.persistent) {
          const state = await sessions.storageState(session.id);
          if (state) storage.updateSessionState(session.id, state);
        }
        const live = !closed
          ? await sessions.get(session, await resolveProxy(session.proxyId, session.ownerKeyHash))
          : undefined;
        answer = {
          sessionId: session.id,
          created: !existing,
          closed,
          results,
          ...(live
            ? {
                url: normalizeUrl(live.page.url()),
                title: await live.page.title(),
              }
            : {}),
        };
      } else if (params.name === "openbrowse_fetch") {
        const body = parse(
          z.object({
            url,
            strategy: z.enum(["auto", "http", "browser"]).default("auto"),
            output: z
              .array(z.enum(["html", "markdown", "links"]))
              .max(3)
              .default(["markdown"]),
          }),
          params.arguments,
        );
        answer = await runFetch({
          ...body,
          cache: { mode: "default", ttlSeconds: 300 },
          ownerKeyHash: requestKeyHash(request),
        });
      } else if (params.name === "openbrowse_extract") {
        const body = parse(
          z.object({
            url,
            selectors: z
              .record(z.string().min(1).max(128), selector)
              .refine(
                (values) => Object.keys(values).length <= 100,
                "At most 100 selectors are allowed",
              ),
          }),
          params.arguments,
        );
        const fetched = await runFetch({
          url: body.url,
          strategy: "auto",
          output: ["html"],
          cache: { mode: "default", ttlSeconds: 300 },
          ownerKeyHash: requestKeyHash(request),
        });
        answer = {
          data: extract(
            String(fetched.html ?? ""),
            fetched.finalUrl,
            body.selectors,
          ),
          strategy: fetched.strategy,
        };
      } else if (params.name === "openbrowse_map") {
        const body = parse(
          z.object({
            url,
            maxUrls: z.number().int().min(1).max(1000).optional(),
            maxDepth: z.number().int().min(0).max(10).optional(),
          }),
          params.arguments,
        );
        answer = {
          urls: await queue
            .run(() => mapSite(pool, body.url, body))
            .then((scheduled) => scheduled.result),
        };
      } else if (params.name === "openbrowse_screenshot") {
        const body = parse(
          z.object({ url, fullPage: z.boolean().default(true) }),
          params.arguments,
        );
        const image = await queue
          .run(() =>
            screenshot(pool, { url: body.url, fullPage: body.fullPage }),
          )
          .then((scheduled) => scheduled.result);
        return mcpReply(id, {
          content: [
            {
              type: "image",
              data: image.toString("base64"),
              mimeType: "image/png",
            },
          ],
        });
      } else return mcpError(id, -32602, "Unknown OpenBrowse MCP tool");
      return mcpReply(id, mcpText(answer));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Tool execution failed";
      return mcpReply(id, mcpText({ error: message }, true));
    }
  });
  app.get("/mcp", async (_request, reply) =>
    reply.code(405).header("Allow", "POST").send(),
  );
}

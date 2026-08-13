import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { notifyOperationalAlert } from "../alerts.js";
import { config, type ApiKeyPolicy } from "../config.js";
import { OpenBrowseError, registerErrorHandling } from "../errors.js";
import { constantTimeApiKeyMatch } from "../security.js";
import type { StoredSession, Storage } from "../storage.js";

type KeyedRequest = {
  openbrowseKeyHash?: string;
  openbrowseKeyPolicy?: ApiKeyPolicy;
};

const queryTokenCompatiblePaths = new Set([
  "/",
  "/chromium",
  "/chrome",
  "/content",
  "/scrape",
  "/screenshot",
  "/pdf",
  "/smart-scrape",
  "/map",
  "/crawl",
  "/search",
  "/export",
  "/performance",
  "/unblock",
  "/function",
  "/download",
  "/mcp",
  "/chromium/bql",
  "/chrome/bql",
  "/chromium/playwright",
  "/firefox/playwright",
  "/webkit/playwright",
]);

/** Browser WebSocket clients cannot attach Authorization headers. */
export function acceptsQueryToken(pathname: string): boolean {
  return (
    queryTokenCompatiblePaths.has(pathname) ||
    /^\/v1\/sessions\/[^/]+\/vnc$/.test(pathname)
  );
}

export type RequestPolicies = {
  requestKeyHash(request: unknown): string;
  assertSessionOwner(request: unknown, session: StoredSession): void;
};

export function installRequestPolicies(
  app: FastifyInstance,
  storage: Storage,
): RequestPolicies {
  const counters = new Map<string, { startedAt: number; count: number }>();
  const requestKeyHash = (request: unknown): string => {
    const hash = (request as KeyedRequest).openbrowseKeyHash;
    if (!hash)
      throw new OpenBrowseError(
        "UNAUTHORIZED",
        "A valid bearer API key is required",
        401,
      );
    return hash;
  };
  const assertSessionOwner = (
    request: unknown,
    session: StoredSession,
  ): void => {
    if (
      !session.ownerKeyHash ||
      session.ownerKeyHash !== requestKeyHash(request)
    )
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
  };
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const corsAllowed =
      typeof origin === "string" &&
      (config.corsAllowedOrigins.has("*") ||
        config.corsAllowedOrigins.has(origin));
    if (request.method === "OPTIONS" && corsAllowed) {
      reply
        .header(
          "Access-Control-Allow-Origin",
          config.corsAllowedOrigins.has("*") ? "*" : origin,
        )
        .header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        .header(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,X-Request-Id",
        )
        .header("Access-Control-Max-Age", "300")
        .code(204)
        .send();
      return reply;
    }
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (
      !pathname.startsWith("/v1/") &&
      !queryTokenCompatiblePaths.has(pathname)
    )
      return;
    const queryToken = acceptsQueryToken(pathname)
      ? (request.query as { token?: unknown }).token
      : undefined;
    const token =
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ??
      (typeof queryToken === "string" ? queryToken : undefined);
    if (!token || !constantTimeApiKeyMatch(token, config.apiKeys))
      throw new OpenBrowseError(
        "UNAUTHORIZED",
        "A valid bearer API key is required",
        401,
      );
    const key = createHash("sha256").update(token).digest("hex");
    const policy = config.apiKeyPolicies.get(key);
    const route = request.routeOptions.url ?? pathname;
    const isAllowedRoute = (allowed: string) =>
      allowed.endsWith("/*")
        ? route.startsWith(allowed.slice(0, -1))
        : route === allowed;
    if (
      policy &&
      policy.allowedRoutes.length > 0 &&
      !policy.allowedRoutes.some(isAllowedRoute)
    )
      throw new OpenBrowseError(
        "FORBIDDEN",
        "API key is not authorized for this route",
        403,
      );
    const now = Date.now();
    const state = counters.get(key);
    const updated =
      !state || now - state.startedAt >= 60000
        ? { startedAt: now, count: 1 }
        : { ...state, count: state.count + 1 };
    counters.set(key, updated);
    if (updated.count > (policy?.rateLimitPerMinute ?? 600))
      throw new OpenBrowseError(
        "RATE_LIMITED",
        "API key rate limit exceeded",
        429,
        true,
      );
    const dailyRequestLimit =
      policy?.dailyRequestLimit ?? config.dailyRequestLimit;
    if (!storage.reserveUsage(key, dailyRequestLimit))
      throw new OpenBrowseError(
        "RATE_LIMITED",
        "API key daily request quota exceeded",
        429,
        true,
      );
    (request as typeof request & KeyedRequest).openbrowseKeyHash = key;
    (request as typeof request & KeyedRequest).openbrowseKeyPolicy = policy;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (
      typeof origin === "string" &&
      (config.corsAllowedOrigins.has("*") ||
        config.corsAllowedOrigins.has(origin))
    ) {
      reply.header(
        "Access-Control-Allow-Origin",
        config.corsAllowedOrigins.has("*") ? "*" : origin,
      );
      reply.header("Vary", "Origin");
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    const keyHash = (request as typeof request & KeyedRequest)
      .openbrowseKeyHash;
    if (keyHash) storage.recordUsageOutcome(keyHash, reply.statusCode);
    if (request.url.startsWith("/v1/"))
      storage.audit(
        request.id,
        request.routeOptions.url ?? request.url,
        reply.statusCode,
      );
    const details = {
      requestId: request.id,
      operation: request.routeOptions.url ?? request.url.split("?", 1)[0],
      status: reply.statusCode,
    };
    if (reply.statusCode === 408)
      void notifyOperationalAlert("timeout", details);
    else if (reply.statusCode === 429)
      void notifyOperationalAlert("rejection", details);
    else if (reply.statusCode >= 500)
      void notifyOperationalAlert("error", details);
  });
  app.addHook("preHandler", async (request) => {
    if (!request.routeOptions.url?.startsWith("/v1/sessions/:id")) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    assertSessionOwner(request, session);
  });
  registerErrorHandling(app);
  return { requestKeyHash, assertSessionOwner };
}

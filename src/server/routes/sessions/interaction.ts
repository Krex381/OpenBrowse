import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { config } from "../../../config.js";
import { assertBoundedJson } from "../../../bounds.js";
import { OpenBrowseError } from "../../../errors.js";
import { redactCookies } from "../../../execution.js";
import { hasAccessChallenge } from "../../../execution/shared.js";
import { assertSafeUrl, normalizeUrl } from "../../../security.js";
import { parse, url } from "../../input.js";
import { agentCommandSchema } from "../../input.js";
import type { SessionRouteDeps } from "./lifecycle.js";

export function registerSessionInteractionRoutes(
  input: SessionRouteDeps,
): void {
  const { app, storage, sessions, resolveProxy, requestKeyHash, executeAgentCommand } = input;
  const challengeState = async (
    session: NonNullable<ReturnType<typeof storage.getSession>>,
    ownerKeyHash: string,
  ) => {
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, ownerKeyHash),
    );
    const html = await live.page.content();
    const cookies = await live.context.cookies(live.page.url()).catch(() => []);
    const challengeRemaining = hasAccessChallenge(html);
    return {
      sessionId: session.id,
      detected: challengeRemaining,
      resolved: !challengeRemaining,
      challengeRemaining,
      clearanceCookiePresent: cookies.some(
        (cookie) => cookie.name === "cf_clearance",
      ),
      finalUrl: normalizeUrl(live.page.url()),
      title: await live.page.title().catch(() => ""),
      screenshotPath: `/v1/sessions/${session.id}/inspect/screenshot`,
      ...(session.liveViewer
        ? {
            viewerPath: `/viewer?sessionId=${session.id}`,
            vncPath: `/v1/sessions/${session.id}/vnc`,
          }
        : {}),
    };
  };
  app.post("/v1/sessions/:id/commands", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const body = parse(
      z.object({ commands: z.array(agentCommandSchema).min(1).max(5) }),
      request.body,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError("SESSION_NOT_FOUND", "Session does not exist or has expired", 404);
    if (!executeAgentCommand)
      throw new OpenBrowseError("INTERNAL_ERROR", "Session commands are unavailable", 500);
    return assertBoundedJson(
      { results: await Promise.all(body.commands.map((command) => executeAgentCommand(session, command))) },
      "Session command response",
    );
  });
  app.post("/v1/sessions/:id/handoff", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const body = parse(
      z.object({ ttlSeconds: z.number().int().min(30).max(3600).default(300) }),
      request.body,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError("SESSION_NOT_FOUND", "Session does not exist or has expired", 404);
    const remainingSeconds = Math.floor((session.expiresAt - Date.now()) / 1000);
    const handoff = storage.createSessionHandoff(
      session.id,
      Math.max(1, Math.min(body.ttlSeconds, remainingSeconds)),
    );
    return {
      sessionId: session.id,
      token: handoff.token,
      expiresAt: new Date(handoff.expiresAt).toISOString(),
      redeemPath: "/v1/sessions/handoff",
    };
  });
  app.post("/v1/sessions/handoff", async (request) => {
    const body = parse(z.object({ token: z.string().min(40).max(256) }), request.body);
    const session = storage.redeemSessionHandoff(body.token, requestKeyHash(request));
    if (!session)
      throw new OpenBrowseError("HANDOFF_NOT_FOUND", "Session handoff is invalid, expired, or already redeemed", 404);
    return {
      id: session.id,
      persistent: session.persistent,
      expiresAt: new Date(session.expiresAt).toISOString(),
      transferred: true,
    };
  });
  app.get("/v1/sessions/:id/challenge", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    return challengeState(session, requestKeyHash(request));
  });
  app.post("/v1/sessions/:id/challenge/wait", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const body = parse(
      z.object({
        timeoutMs: z.number().int().min(250).max(60000).default(30000),
        pollIntervalMs: z.number().int().min(250).max(2000).default(500),
      }),
      request.body,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const startedAt = Date.now();
    const ownerKeyHash = requestKeyHash(request);
    let state = await challengeState(session, ownerKeyHash);
    while (state.challengeRemaining && Date.now() - startedAt < body.timeoutMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(body.pollIntervalMs, body.timeoutMs - (Date.now() - startedAt))),
      );
      state = await challengeState(session, ownerKeyHash);
    }
    if (state.resolved && session.persistent) {
      const storageState = await sessions.storageState(session.id);
      if (storageState) storage.updateSessionState(session.id, storageState);
    }
    return {
      ...state,
      waitedMs: Date.now() - startedAt,
      timedOut: state.challengeRemaining,
    };
  });
  app.post("/v1/sessions/:id/navigate", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const body = parse(
      z.object({
        url,
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .default("domcontentloaded"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.jobTimeoutMs)
          .default(config.jobTimeoutMs),
      }),
      request.body,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const proxy = await resolveProxy(session.proxyId, requestKeyHash(request));
    await assertSafeUrl(body.url, proxy?.allowedDomains);
    const live = await sessions.get(session, proxy);
    const response = await live.page.goto(body.url, {
      waitUntil: body.waitUntil,
      timeout: body.timeoutMs,
    });
    if (session.persistent) {
      const state = await sessions.storageState(id);
      if (state) storage.updateSessionState(id, state);
    }
    return {
      status: response?.status() ?? 200,
      finalUrl: normalizeUrl(live.page.url()),
    };
  });
  app.get("/v1/sessions/:id/cookies", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, requestKeyHash(request)),
    );
    return { cookies: redactCookies(await live.context.cookies()) };
  });
  app.put("/v1/sessions/:id/cookies", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const body = parse(
      z.object({
        cookies: z
          .array(
            z.object({
              name: z.string().min(1).max(256),
              value: z.string().max(4096),
              domain: z.string().min(1).max(253),
              path: z.string().max(1024).default("/"),
              secure: z.boolean().optional(),
              httpOnly: z.boolean().optional(),
              sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
              expires: z.number().optional(),
            }),
          )
          .min(1)
          .max(100),
      }),
      request.body,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, requestKeyHash(request)),
    );
    await live.context.addCookies(body.cookies);
    if (session.persistent) {
      const state = await sessions.storageState(id);
      if (state) storage.updateSessionState(id, state);
    }
    return { updated: body.cookies.length };
  });
  app.delete("/v1/sessions/:id", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    const trace = await sessions.stopTrace(id);
    const replay =
      trace && session
        ? storage.createReplay(
            session.id,
            (
              await storage.createArtifact(
                trace,
                "application/zip",
                requestKeyHash(request),
                Math.max(
                  60,
                  Math.ceil((session.expiresAt - Date.now()) / 1000),
                ),
              )
            ).id,
            Math.max(60, Math.ceil((session.expiresAt - Date.now()) / 1000)),
            requestKeyHash(request),
          )
        : undefined;
    await sessions.close(id);
    return {
      deleted: await storage.deleteSession(id),
      ...(replay
        ? {
            replay: {
              id: replay.id,
              downloadPath: `/v1/replays/${replay.id}/download`,
            },
          }
        : {}),
    };
  });
  app.post("/v1/sessions/:id/replay", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    await sessions.startTrace(session, await resolveProxy(session.proxyId, requestKeyHash(request)));
    return { sessionId: id, recording: true };
  });
  app.post("/v1/sessions/:id/replay/stop", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const trace = await sessions.stopTrace(id);
    if (!trace)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "No active trace exists for this session",
        400,
      );
    const ttlSeconds = Math.max(
      60,
      Math.ceil((session.expiresAt - Date.now()) / 1000),
    );
    const artifact = await storage.createArtifact(
      trace,
      "application/zip",
      requestKeyHash(request),
      ttlSeconds,
    );
    const replay = storage.createReplay(id, artifact.id, ttlSeconds, requestKeyHash(request));
    return {
      id: replay.id,
      artifactId: artifact.id,
      downloadPath: `/v1/replays/${replay.id}/download`,
      traceViewer: "https://trace.playwright.dev",
    };
  });
  app.get("/v1/replays/:id", async (request) => {
    const replay = storage.getReplay(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    );
    if (!replay)
      throw new OpenBrowseError(
        "ARTIFACT_NOT_FOUND",
        "Replay does not exist or has expired",
        404,
      );
    return {
      id: replay.id,
      sessionId: replay.sessionId,
      createdAt: new Date(replay.createdAt).toISOString(),
      expiresAt: new Date(replay.expiresAt).toISOString(),
      downloadPath: `/v1/replays/${replay.id}/download`,
      traceViewer: "https://trace.playwright.dev",
    };
  });
  app.get("/v1/replays/:id/download", async (request, reply) => {
    const replay = storage.getReplay(
      parse(z.object({ id: z.string() }), request.params).id,
      requestKeyHash(request),
    );
    if (!replay)
      throw new OpenBrowseError(
        "ARTIFACT_NOT_FOUND",
        "Replay does not exist or has expired",
        404,
      );
    const artifact = await storage.getArtifact(replay.artifactId, requestKeyHash(request));
    if (!artifact)
      throw new OpenBrowseError(
        "ARTIFACT_NOT_FOUND",
        "Replay artifact does not exist or has expired",
        404,
      );
    reply.type(artifact.artifact.contentType);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${replay.id}.zip"`,
    );
    return reply.send(artifact.body);
  });
  app.get(
    "/v1/sessions/:id/cdp",
    { websocket: true },
    async (client, request) => {
      const id = parse(z.object({ id: z.string() }), request.params).id;
      const session = storage.getSession(id);
      if (!session) {
        client.close(1008, "Session not found");
        return;
      }
      await sessions.get(session, await resolveProxy(session.proxyId, requestKeyHash(request)));
      const endpoint = sessions.wsEndpoint(id);
      if (!endpoint) {
        client.close(1011, "Browser unavailable");
        return;
      }
      const upstream = new WebSocket(endpoint);
      upstream.on("message", (data: RawData, isBinary: boolean) =>
        client.send(data, { binary: isBinary }),
      );
      upstream.on("close", () => client.close());
      upstream.on("error", () => client.close(1011, "CDP upstream error"));
      client.on("message", (data: RawData, isBinary: boolean) => {
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary: isBinary });
      });
      client.on("close", () => upstream.close());
    },
  );
}

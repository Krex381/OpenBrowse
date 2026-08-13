import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../../config.js";
import { OpenBrowseError } from "../../../errors.js";
import type { SessionManager } from "../../../execution.js";
import type { StoredProxy, StoredSession, Storage } from "../../../storage.js";
import { parse, viewport } from "../../input.js";
import type { AgentCommand } from "../../input.js";
import { sessionConnectUrl } from "../../presentation.js";

export type SessionRouteDeps = {
  app: FastifyInstance;
  storage: Storage;
  sessions: SessionManager;
  requestKeyHash(request: unknown): string;
  assertSessionOwner(request: unknown, session: StoredSession): void;
  resolveProxy(id: string | undefined, ownerKeyHash: string): Promise<StoredProxy | undefined>;
  executeAgentCommand?(
    session: StoredSession,
    command: AgentCommand,
  ): Promise<unknown>;
};
export function registerSessionLifecycleRoutes(input: SessionRouteDeps): void {
  const {
    app,
    storage,
    sessions,
    requestKeyHash,
    assertSessionOwner,
    resolveProxy,
  } = input;
  app.post("/v1/sessions", async (request) => {
    const body = parse(
      z.object({
        persistent: z.boolean().default(false),
        ttlSeconds: z
          .number()
          .int()
          .min(60)
          .max(config.maxSessionTtlSeconds)
          .default(3600),
        keepAliveSeconds: z.number().int().min(0).max(3600).default(30),
        viewport: viewport
          .pick({ width: true, height: true })
          .default({ width: 1280, height: 720 }),
        proxyId: z.string().optional(),
        profileId: z
          .string()
          .regex(/^prf_[a-z0-9]+$/)
          .optional(),
        profileName: z.string().trim().min(1).max(100).optional(),
        recordTrace: z.boolean().default(false),
        liveViewer: z.boolean().default(false),
      }),
      request.body,
    );
    const ownerKeyHash = requestKeyHash(request);
    await resolveProxy(body.proxyId, ownerKeyHash);
    if (body.liveViewer && !config.vncBridgeUrl)
      throw new OpenBrowseError(
        "FEATURE_DISABLED",
        "Live VNC viewer is not enabled on this host",
        503,
        true,
      );
    if (body.profileId && body.profileName)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "Provide profileId or profileName, not both",
        400,
      );
    const profile = body.profileId
      ? storage.getBrowserProfile(body.profileId, ownerKeyHash)
      : body.profileName
        ? storage.getBrowserProfileByName(
            body.profileName,
            ownerKeyHash,
          )
        : undefined;
    if ((body.profileId || body.profileName) && !profile)
      throw new OpenBrowseError(
        "PROFILE_NOT_FOUND",
        "Browser profile does not exist",
        404,
      );
    const session = storage.createSession({
      ownerKeyHash,
      persistent: body.persistent,
      expiresAt: Date.now() + body.ttlSeconds * 1000,
      viewport: body.viewport,
      ...(body.proxyId ? { proxyId: body.proxyId } : {}),
      ...(profile ? { storageState: profile.storageState } : {}),
      ...(body.liveViewer ? { liveViewer: true } : {}),
    });
    if (body.recordTrace)
      await sessions.startTrace(session, await resolveProxy(session.proxyId, ownerKeyHash));
    return {
      id: session.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
      connectUrl: sessionConnectUrl(request, session.id),
      persistent: session.persistent,
      recording: body.recordTrace,
      ...(body.liveViewer ? { viewerPath: `/viewer?sessionId=${session.id}` } : {}),
    };
  });
  app.get("/v1/sessions", async (request) => ({
    sessions: storage.listSessions(requestKeyHash(request)).map((session) => ({
      id: session.id,
      persistent: session.persistent,
      active: sessions.isActive(session.id),
      tracing: sessions.isTracing(session.id),
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      viewport: session.viewport,
      liveViewer: Boolean(session.liveViewer),
    })),
  }));
  app.post("/v1/profiles", async (request) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        sourceSessionId: z.string().regex(/^ses_[a-z0-9]+$/),
      }),
      request.body,
    );
    const session = storage.getSession(body.sourceSessionId);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Source session does not exist or has expired",
        404,
      );
    assertSessionOwner(request, session);
    const ownerKeyHash = requestKeyHash(request);
    if (
      storage
        .listBrowserProfiles(ownerKeyHash)
        .some((profile) => profile.name === body.name)
    )
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "A browser profile with this name already exists",
        409,
      );
    await sessions.get(session, await resolveProxy(session.proxyId, ownerKeyHash));
    const storageState = await sessions.storageState(session.id);
    if (!storageState)
      throw new OpenBrowseError(
        "INTERNAL_ERROR",
        "Browser profile state could not be captured",
        500,
      );
    const profile = storage.createBrowserProfile({
      ownerKeyHash,
      name: body.name,
      storageState,
    });
    return {
      id: profile.id,
      name: profile.name,
      createdAt: new Date(profile.createdAt).toISOString(),
      updatedAt: new Date(profile.updatedAt).toISOString(),
    };
  });
  app.get("/v1/profiles", async (request) => ({
    profiles: storage
      .listBrowserProfiles(requestKeyHash(request))
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        createdAt: new Date(profile.createdAt).toISOString(),
        updatedAt: new Date(profile.updatedAt).toISOString(),
      })),
  }));
  app.delete("/v1/profiles/:id", async (request) => {
    const id = parse(
      z.object({ id: z.string().regex(/^prf_[a-z0-9]+$/) }),
      request.params,
    ).id;
    if (!storage.deleteBrowserProfile(id, requestKeyHash(request)))
      throw new OpenBrowseError(
        "PROFILE_NOT_FOUND",
        "Browser profile does not exist",
        404,
      );
    return { deleted: true };
  });
}

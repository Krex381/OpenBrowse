import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { assertBoundedJson } from "../bounds.js";
import { OpenBrowseError } from "../errors.js";
import {
  browserBackendIds,
  type BrowserBackendId,
  type SessionManager,
} from "../execution.js";
import type { AdmissionQueue } from "../queue.js";
import type { StoredProxy, StoredSession, Storage } from "../storage.js";
import { browserBackendOptions, parse } from "./input.js";
import { parseBql, selectBqlResponse, type BqlField } from "./browserql.js";

export function createBqlHandler(input: {
  storage: Storage;
  queue: AdmissionQueue;
  sessions: SessionManager;
  requestKeyHash(request: unknown): string;
  resolveProxy(id: string | undefined, ownerKeyHash?: string): Promise<StoredProxy | undefined>;
  executeBqlField(session: StoredSession, field: BqlField): Promise<unknown>;
  bqlNetwork: Map<
    string,
    {
      requests: Array<{ url: string; method: string }>;
      responses: Array<{
        url: string;
        status: number;
        contentType?: string;
        body?: string;
        bodyTruncated?: boolean;
      }>;
      pending: Promise<void>[];
      captureBodies: boolean;
    }
  >;
}) {
  const {
    storage,
    queue,
    sessions,
    requestKeyHash,
    resolveProxy,
    executeBqlField,
    bqlNetwork,
  } = input;
  return async (request: FastifyRequest) => {
    const body = parse(
      z.object({
        query: z.string().min(1).max(30000),
        variables: z.record(z.string(), z.unknown()).default({}),
        profileId: z
          .string()
          .regex(/^prf_[a-z0-9]+$/)
          .optional(),
        browserBackend: z.enum(browserBackendIds).optional(),
        browserOptions: browserBackendOptions.optional(),
      }),
      request.body,
    );
    const profileName = parse(
      z.object({ profile: z.string().trim().min(1).max(100).optional() }),
      request.query,
    ).profile;
    if (body.profileId && profileName)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "Provide profileId or profile query parameter, not both",
        400,
      );
    const fields = parseBql(body.query, body.variables);
    const ownerKeyHash = requestKeyHash(request);
    const profile = body.profileId
      ? storage.getBrowserProfile(body.profileId, ownerKeyHash)
      : profileName
        ? storage.getBrowserProfileByName(profileName, ownerKeyHash)
        : undefined;
    if ((body.profileId || profileName) && !profile)
      throw new OpenBrowseError(
        "PROFILE_NOT_FOUND",
        "Browser profile does not exist",
        404,
      );
    if (
      body.browserOptions &&
      body.browserBackend &&
      body.browserBackend !== "cloakbrowser-chromium" &&
      body.browserBackend !== "camoufox-firefox" &&
      body.browserBackend !== "clearcote-chromium"
    )
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "BrowserQL browserOptions apply only to CloakBrowser, Camoufox, and Clearcote attempts",
        400,
      );
    const solveRequested = fields.some((field) => field.name === "solve");
    const preferred = body.browserBackend ?? config.defaultBrowserBackend;
    const candidates = [
      preferred,
      ...(solveRequested
        ? ([
            "patchright-chromium",
            "clearcote-chromium",
            "camoufox-firefox",
            "cloakbrowser-chromium",
          ] as const)
        : []),
    ].filter(
      (backend, index, all): backend is BrowserBackendId =>
        config.enabledBrowserBackends.has(backend) &&
        all.indexOf(backend) === index,
    );
    const scheduled = await queue.run(async () => {
      const backendAttempts: BrowserBackendId[] = [];
      let finalResult: {
        data: Record<string, unknown>;
        selectedBackend: BrowserBackendId;
        challengeRemaining: boolean;
      } | undefined;
      let lastUnavailable: OpenBrowseError | undefined;
      for (const backend of candidates) {
        backendAttempts.push(backend);
        const session = storage.createSession({
          ownerKeyHash,
          persistent: false,
          expiresAt: Date.now() + Math.min(config.jobTimeoutMs, 60000),
          viewport: { width: 1280, height: 720 },
          ...(profile ? { storageState: profile.storageState } : {}),
        });
        try {
          const live = await sessions.get(
            session,
            await resolveProxy(session.proxyId, ownerKeyHash),
            undefined,
            backend,
            backend === "cloakbrowser-chromium" ||
            backend === "camoufox-firefox" ||
            backend === "clearcote-chromium"
              ? body.browserOptions
              : undefined,
          );
          const network = {
            requests: [] as Array<{ url: string; method: string }>,
            responses: [] as Array<{
              url: string;
              status: number;
              contentType?: string;
              body?: string;
              bodyTruncated?: boolean;
            }>,
            pending: [] as Promise<void>[],
            captureBodies: fields.some(
              (field) =>
                field.name === "network" && field.args.captureBodies === true,
            ),
          };
          bqlNetwork.set(session.id, network);
          live.page.on("request", (pageRequest) => {
            if (network.requests.length < 200)
              network.requests.push({
                url: pageRequest.url(),
                method: pageRequest.method(),
              });
          });
          live.page.on("response", (response) => {
            if (network.responses.length < 200) {
              const record: (typeof network.responses)[number] = {
                url: response.url(),
                status: response.status(),
                contentType: response.headers()["content-type"],
              };
              network.responses.push(record);
              if (
                network.captureBodies &&
                /^text\/|json|javascript|xml/i.test(record.contentType ?? "") &&
                network.pending.length < 50
              ) {
                const task = response
                  .body()
                  .then((responseBody) => {
                    const limit = Math.min(
                      1024 * 1024,
                      config.maxResponseBytes,
                    );
                    record.body = responseBody
                      .subarray(0, limit)
                      .toString("utf8");
                    record.bodyTruncated = responseBody.length > limit;
                  })
                  .catch(() => undefined);
                network.pending.push(task);
              }
            }
          });
          const data: Record<string, unknown> = {};
          let challengeRemaining = false;
          for (const field of fields) {
            const started = Date.now();
            const result = await executeBqlField(session, field);
            if (
              field.name === "solve" &&
              result &&
              typeof result === "object" &&
              (result as Record<string, unknown>).retryRecommended === true
            )
              challengeRemaining = true;
            const timed =
              result &&
              typeof result === "object" &&
              !Array.isArray(result) &&
              !("time" in result)
                ? {
                    ...(result as Record<string, unknown>),
                    time: Date.now() - started,
                  }
                : result;
            data[field.key] = selectBqlResponse(timed, field.selection);
          }
          finalResult = { data, selectedBackend: backend, challengeRemaining };
          if (!challengeRemaining) break;
        } catch (error) {
          if (
            error instanceof OpenBrowseError &&
            error.code === "BROWSER_BACKEND_UNAVAILABLE"
          ) {
            lastUnavailable = error;
            continue;
          }
          throw error;
        } finally {
          bqlNetwork.delete(session.id);
          await sessions.close(session.id);
          await storage.deleteSession(session.id);
        }
      }
      if (!finalResult)
        throw (
          lastUnavailable ??
          new OpenBrowseError(
            "BROWSER_BACKEND_DISABLED",
            "No configured browser backend can execute this BrowserQL request",
            409,
          )
        );
      return { ...finalResult, backendAttempts };
    }, "workflow");
    return assertBoundedJson({
      data: scheduled.result.data,
      extensions: {
        engine: "openbrowse-browserql-safe",
        queueMs: scheduled.queueMs,
        backendAttempts: scheduled.result.backendAttempts,
        selectedBackend: scheduled.result.selectedBackend,
        challengeRemaining: scheduled.result.challengeRemaining,
      },
    }, "BrowserQL response");
  };
}

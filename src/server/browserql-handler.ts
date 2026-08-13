import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import type { SessionManager } from "../execution.js";
import type { AdmissionQueue } from "../queue.js";
import type { StoredProxy, StoredSession, Storage } from "../storage.js";
import { parse } from "./input.js";
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
    const scheduled = await queue.run(async () => {
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
            (field) => field.name === "network" && field.args.captureBodies === true,
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
                .then((body) => {
                  const limit = Math.min(1024 * 1024, config.maxResponseBytes);
                  record.body = body.subarray(0, limit).toString("utf8");
                  record.bodyTruncated = body.length > limit;
                })
                .catch(() => undefined);
              network.pending.push(task);
            }
          }
        });
        const data: Record<string, unknown> = {};
        for (const field of fields) {
          const started = Date.now();
          const result = await executeBqlField(session, field);
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
        return data;
      } finally {
        bqlNetwork.delete(session.id);
        await sessions.close(session.id);
        await storage.deleteSession(session.id);
      }
    }, "workflow");
    return {
      data: scheduled.result,
      extensions: {
        engine: "openbrowse-browserql-safe",
        queueMs: scheduled.queueMs,
        bypass: "disabled",
      },
    };
  };
}

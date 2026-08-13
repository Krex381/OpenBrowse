import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { CdpReconnectManager } from "../../cdp-reconnect.js";
import { config } from "../../config.js";
import { OpenBrowseError } from "../../errors.js";
import { parse } from "../input.js";

export function registerReconnectableCdpRoutes(input: {
  app: FastifyInstance;
  cdp: CdpReconnectManager;
  requestKeyHash(request: unknown): string;
}): void {
  if (!config.rawBrowserProtocolBridges) return;
  const { app, cdp, requestKeyHash } = input;
  app.post("/v1/cdp/sessions", async (request) => {
    const body = parse(
      z.object({
        ttlSeconds: z.number().int().min(30).max(config.maxSessionTtlSeconds).default(300),
        headless: z.boolean().default(true),
      }),
      request.body,
    );
    const created = await cdp.create(requestKeyHash(request), body.ttlSeconds, {
      headless: body.headless,
    });
    const host = request.headers.host ?? `localhost:${config.port}`;
    return {
      id: created.id,
      accessToken: created.accessToken,
      expiresAt: new Date(created.expiresAt).toISOString(),
      connectPath: `/v1/cdp/sessions/${created.id}?accessToken=${created.accessToken}`,
      connectUrl: `ws://${host}/v1/cdp/sessions/${created.id}?accessToken=${created.accessToken}`,
      protocol: "cdp",
    };
  });
  app.delete("/v1/cdp/sessions/:id", async (request) => {
    const id = parse(z.object({ id: z.string().regex(/^cdp_[a-z0-9]+$/) }), request.params).id;
    const token = parse(z.object({ accessToken: z.string().min(40).max(256) }), request.query).accessToken;
    cdp.get(id, requestKeyHash(request), token);
    await cdp.close(id);
    return { deleted: true };
  });
  app.get("/v1/cdp/sessions/:id", { websocket: true }, async (client, request) => {
    try {
      const id = parse(z.object({ id: z.string().regex(/^cdp_[a-z0-9]+$/) }), request.params).id;
      const token = parse(z.object({ accessToken: z.string().min(40).max(256) }), request.query).accessToken;
      const browser = cdp.get(id, requestKeyHash(request), token);
      const pending: Array<{ data: RawData; isBinary: boolean }> = [];
      let upstream: WebSocket | undefined;
      client.on("message", (data: RawData, isBinary: boolean) => {
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      });
      upstream = new WebSocket(browser.endpoint);
      upstream.on("open", () => {
        for (const message of pending.splice(0)) upstream?.send(message.data, { binary: message.isBinary });
      });
      upstream.on("message", (data: RawData, isBinary: boolean) => client.send(data, { binary: isBinary }));
      upstream.on("close", () => client.close());
      upstream.on("error", () => client.close(1011, "CDP upstream error"));
      client.once("close", () => upstream?.close());
    } catch (error) {
      const message = error instanceof OpenBrowseError ? error.message : "Could not connect CDP session";
      client.close(1008, message);
    }
  });
}
